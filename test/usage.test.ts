import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readClaudeLimits, readCodexEmail, readCodexLimits, usageReport } from '../src/usage.js'

const temp = async (t: test.TestContext, name: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `ez-usage-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const fakeCodex = (observed: string, reply: string, noise = '') => `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }))
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
    if (message.method === 'initialize') { ${noise}console.log(JSON.stringify({ id: message.id, result: {} })) }
    if (message.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: message.id, ${reply} }))
  }
})`

test('Codex limits come from the app-server of the bound home', { skip: process.platform === 'win32' }, async t => {
  const root = await temp(t, 'codex'), bin = path.join(root, 'bin'), home = path.join(root, 'home'), observed = path.join(root, 'observed.json')
  const prior = process.env.PATH
  t.after(() => { process.env.PATH = prior })
  await mkdir(bin); await mkdir(home)
  process.env.PATH = bin + path.delimiter + prior
  await writeFile(path.join(bin, 'codex'), fakeCodex(observed, `result: { rateLimits: {
    primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1900000000 },
    secondary: { usedPercent: 49.4, windowDurationMins: 10080, resetsAt: 1900500000 } } }`), { mode: 0o700 })
  assert.deepEqual(await readCodexLimits(home), [
    { label: '5h', usedPercent: 28, resetsAt: 1900000000 },
    { label: '7d', usedPercent: 49.4, resetsAt: 1900500000 },
  ])
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { args: ['app-server', '--stdio'], home })

  // A literal `null` line and a server message that carries a method are ignored.
  const reply = `result: { rateLimits: { primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1900000000 } } }`
  await writeFile(path.join(bin, 'codex'), fakeCodex(observed, reply, `console.log('null'); console.log(JSON.stringify({ method: 'note', id: 2 })); `), { mode: 0o700 })
  assert.deepEqual(await readCodexLimits(home), [{ label: '5h', usedPercent: 28, resetsAt: 1900000000 }])

  await writeFile(path.join(bin, 'codex'), fakeCodex(observed, `error: { message: 'not logged in' }`), { mode: 0o700 })
  await assert.rejects(readCodexLimits(home), /not logged in\?/)
  process.env.PATH = path.join(root, 'empty')
  await assert.rejects(readCodexLimits(home), /Codex unavailable/)
})

// Output shape captured from `claude -p /usage --output-format json` (Claude Code 2.1.296).
const claudeUsageText = `You are currently using your subscription to power your Claude Code usage

Current session: 15% used · resets Oct 31 at 11:50am (Asia/Dubai)
Current week (Fable): 0% used · resets Oct 31 at 9pm (Asia/Dubai)

What's contributing to your limits usage?
Last 24h · 1970 requests · 17 sessions
  87% of your usage was at >150k context`

const fakeClaude = (observed: string, output: unknown) => `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, token: process.env.CLAUDE_CODE_OAUTH_TOKEN }))
console.log(${JSON.stringify(JSON.stringify(output))})`

test('Claude limits come from the local /usage command of the bound home', { skip: process.platform === 'win32' }, async t => {
  const root = await temp(t, 'claude'), bin = path.join(root, 'bin'), home = path.join(root, 'home'), observed = path.join(root, 'observed.json')
  const prior = process.env.PATH
  t.after(() => { process.env.PATH = prior })
  await mkdir(bin); await mkdir(home)
  await writeFile(path.join(home, 'oauth-token'), 'sk-ant-oat01-named_profile_token_value')
  process.env.PATH = bin + path.delimiter + prior
  const install = (output: unknown) => writeFile(path.join(bin, 'claude'), fakeClaude(observed, output), { mode: 0o700 })

  await install({ type: 'result', is_error: false, result: claudeUsageText })
  assert.deepEqual(await readClaudeLimits(home, 'work'), [
    { label: '5h', usedPercent: 15, resetsText: 'Oct 31 at 11:50am (Asia/Dubai)' },
    { label: '7d Fable', usedPercent: 0, resetsText: 'Oct 31 at 9pm (Asia/Dubai)' },
  ])
  // The native client runs in the bound home; Ez only hands it the token, as execution does.
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), {
    args: ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], config: home, token: 'sk-ant-oat01-named_profile_token_value' })

  // Free text from the client is reduced to plain name and date characters.
  await install({ type: 'result', is_error: false, result: 'Current session: 5% used · resets Nov 1 at 9am (UTC\u001b[31m<b>)\nCurrent week (Opus <i>): 7% used' })
  assert.deepEqual(await readClaudeLimits(home, 'work'), [
    { label: '5h', usedPercent: 5, resetsText: 'Nov 1 at 9am (UTC31mb)' },
    { label: '7d Opus i', usedPercent: 7 },
  ])

  await install({ type: 'result', is_error: false, result: 'Usage is only available for subscription plans.' })
  assert.deepEqual(await readClaudeLimits(home, 'work'), [])
  await install({ type: 'result', is_error: true, result: 'Not logged in' })
  await assert.rejects(readClaudeLimits(home, 'work'), /usage unavailable/)
  process.env.PATH = path.join(root, 'empty')
  await assert.rejects(readClaudeLimits(home, 'work'), /Claude unavailable/)
})

test('the report lists each login with percent left, resets and blocks, and never leaks provider errors', async t => {
  const root = await temp(t, 'report'), now = Date.UTC(2026, 10, 1, 12, 0)
  await mkdir(path.join(root, 'cli', 'profiles', 'work', 'codex'), { recursive: true })
  await mkdir(path.join(root, 'cli', 'profiles', 'work', 'claude'), { recursive: true })
  const readers = {
    codex: async (home: string) => home.endsWith(path.join('work', 'codex')) ? [] : [
      { label: '5h', usedPercent: 28, resetsAt: now / 1000 + 130 * 60 },
      { label: '7d', usedPercent: 100, resetsAt: now / 1000 + 3 * 86400 + 4 * 3600 }],
    claude: async (_home: string, authProfile?: string) => {
      if (authProfile) throw new Error('upstream said sk-ant-oat01-LEAK')
      return [{ label: '5h', usedPercent: 15, resetsText: 'Oct 31 at 11:50am (Asia/Dubai)' }]
    },
  }
  const report = await usageReport(root, {
    'claude@work': { resetAt: new Date(now + 3600_000).toISOString() },
    'codex@work': { manualRetry: true },
  }, { readers, available: async () => true, now })
  assert.equal(report, [
    'Account usage', '',
    'codex',
    '  5h ███████░░░ 72% left · resets in 2h 10m (11-01 14:10 UTC)',
    '  7d ░░░░░░░░░░ 0% left · resets in 3d 4h (11-04 16:00 UTC)', '',
    'claude',
    '  5h █████████░ 85% left · resets Oct 31 at 11:50am (Asia/Dubai)', '',
    'codex@work',
    '  ⛔ quota-blocked · awaiting /retry_quota',
    '  no limit data returned', '',
    'claude@work',
    '  ⛔ quota-blocked · resets in 1h 0m (11-01 13:00 UTC)',
    '  unavailable',
  ].join('\n'))
  assert.equal(await usageReport(path.join(root, 'none'), {}, { readers, available: async () => false, now }), 'No Codex or Claude login is installed.')

  // Many profiles stay under Telegram's reply limit, cut at a line break.
  for (let index = 0; index < 40; index++) await mkdir(path.join(root, 'cli', 'profiles', `p${index}`, 'codex'), { recursive: true })
  const long = await usageReport(root, {}, { readers: { ...readers, codex: async () => [{ label: '5h', usedPercent: 1, resetsAt: now / 1000 + 60 }, { label: '7d', usedPercent: 2, resetsAt: now / 1000 + 600 }] }, available: async () => true, now })
  assert.ok(long.length <= 4096 && long.endsWith('\n…'), String(long.length))
})

test('Claude usage shows only saved emails in private reports, including unavailable profiles', async t => {
  const root = await temp(t, 'identities')
  const defaultHome = path.join(root, 'cli', 'claude')
  const save = async (home: string, emailAddress: string) => {
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress, accountUuid: 'private-account-id' },
      unrelated: 'private-value',
    }))
  }
  await save(defaultHome, 'primary@example.com')
  const profileHome = (name: string) => path.join(root, 'cli', 'profiles', name, 'claude')
  await save(profileHome('expired'), 'relogin+work@example.com')
  await save(profileHome('token'), 'old@example.com')
  await writeFile(path.join(profileHome('token'), 'oauth-token'), 'private-token')
  await save(profileHome('invalid'), 'invalid@example.com\nInjected line')
  const deps = {
    available: async (cli: string) => cli === 'claude',
    readers: {
      codex: async () => [],
      claude: async (_home: string, profile?: string) => {
        if (profile === 'expired') throw new Error('private-error')
        return []
      },
    },
  }

  const report = await usageReport(root, {}, { ...deps, showAccountEmails: true })
  assert.match(report, /^claude · primary@example\.com$/m)
  assert.match(report, /^claude@expired · relogin\+work@example\.com\n  unavailable$/m)
  assert.match(report, /^claude@token$/m)
  assert.match(report, /^claude@invalid$/m)
  assert.doesNotMatch(report, /old@example|invalid@example|Injected|private-/)
  const group = await usageReport(root, {}, deps)
  assert.match(group, /^claude@expired\n  unavailable$/m)
  assert.doesNotMatch(group, /@example\.com/)
})

test('Codex usage shows the app-server account email only in private reports, never for API-key logins', { skip: process.platform === 'win32' }, async t => {
  const root = await temp(t, 'codex-email'), bin = path.join(root, 'bin')
  const prior = process.env.PATH
  t.after(() => { process.env.PATH = prior })
  await mkdir(bin)
  process.env.PATH = bin + path.delimiter + prior
  // The fake answers `account/read` from the bound home's account.json, as the native client does.
  await writeFile(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs'), path = require('path')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }))
    if (message.method === 'account/read') {
      if (message.params.refreshToken !== false) process.exit(3)
      console.log(JSON.stringify({ id: message.id, result: { account: JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'account.json'), 'utf8')) } }))
    }
    if (message.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: message.id, error: { message: 'private-error' } }))
  }
})`, { mode: 0o700 })
  const save = async (home: string, account: object) => {
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'account.json'), JSON.stringify(account))
  }
  const profileHome = (name: string) => path.join(root, 'cli', 'profiles', name, 'codex')
  await save(path.join(root, 'cli', 'codex'), { type: 'chatgpt', email: 'primary@example.com', planType: 'pro' })
  await save(profileHome('work'), { type: 'chatgpt', email: 'work+codex@example.com' })
  await save(profileHome('key'), { type: 'apiKey', email: 'key@example.com' })
  await save(profileHome('invalid'), { type: 'chatgpt', email: 'invalid@example.com\nInjected line' })
  assert.equal(await readCodexEmail(path.join(root, 'cli', 'codex')), 'primary@example.com')
  assert.equal(await readCodexEmail(path.join(root, 'missing')), undefined)

  const deps = { available: async (cli: string) => cli === 'codex' }
  const report = await usageReport(root, {}, { ...deps, showAccountEmails: true })
  assert.match(report, /^codex · primary@example\.com\n  limits unavailable/m)
  assert.match(report, /^codex@work · work\+codex@example\.com$/m)
  assert.match(report, /^codex@key$/m)
  assert.match(report, /^codex@invalid$/m)
  assert.doesNotMatch(report, /key@example|invalid@example|Injected|private-error|pro\b/)
  const group = await usageReport(root, {}, deps)
  assert.doesNotMatch(group, /@example\.com/)
})
