import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startExecutorJob } from '../src/executor.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { serveHostExecutor } from '../src/host-executor.js'
import { authProfileStatus, initialPreset, readModels, validateSelection, type AiPreset } from '../src/ai.js'

const restoreEnv = (keys: string[]) => {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  return () => { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value }
}

test('each Claude and Codex profile runs only with its own home and credentials', {skip:process.platform==='win32'}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-profiles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(restoreEnv(['PATH', 'HOME', 'EZ_ISOLATION', 'EZ_EXECUTOR_TRANSPORT']))
  const bin = path.join(root, 'bin'), workspace = path.join(root, 'mind'), controlDir = path.join(root, 'control')
  await mkdir(bin); await mkdir(workspace)
  const observed = path.join(root, 'observed.json')
  for (const cli of ['claude', 'codex']) await writeFile(path.join(bin, cli), `#!${process.execPath}
const fs=require('fs'),p=require('path');let auth=null
try{auth=fs.lstatSync(p.join(process.env.CODEX_HOME,'auth.json')).isSymbolicLink()?'link:'+fs.readlinkSync(p.join(process.env.CODEX_HOME,'auth.json')):'file'}catch{}
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR,storage:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,token:process.env.CLAUDE_CODE_OAUTH_TOKEN,codexHome:process.env.CODEX_HOME,auth}))`, { mode: 0o700 })
  process.env.PATH = bin + path.delimiter + process.env.PATH
  process.env.HOME = root
  delete process.env.EZ_ISOLATION; delete process.env.EZ_EXECUTOR_TRANSPORT
  const tokens = { work: 'sk-ant-oat01-work_profile_token', personal: 'sk-ant-oat01-personal_profile_token' }
  for (const [name, token] of Object.entries(tokens)) {
    await mkdir(path.join(controlDir, 'cli', 'profiles', name, 'claude'), { recursive: true })
    await writeFile(path.join(controlDir, 'cli', 'profiles', name, 'claude', 'oauth-token'), token, { mode: 0o600 })
    await mkdir(path.join(controlDir, 'cli', 'profiles', name, 'codex'), { recursive: true })
    await writeFile(path.join(controlDir, 'cli', 'profiles', name, 'codex', 'auth.json'), '{}', { mode: 0o600 })
  }
  let n = 0
  const run = async (cli: string, authProfile?: string) => {
    const runId = `r_profile_${n++}`
    await ownerRun(controlDir, runId)
    await rm(observed, { force: true })
    const job = await startExecutorJob(['hello'], { workspace, controlDir, binDir: bin, cli, authProfile, runId, timeoutMs: 5000, repairEnabled: false })
    assert.equal(await new Promise(resolve => job.child.once('close', resolve)), 0); await job.cleanup()
    return JSON.parse(await readFile(observed, 'utf8'))
  }
  // Default bindings are unchanged: shared host login.
  const claudeDefault = await run('claude')
  assert.equal(claudeDefault.config, path.join(controlDir, 'cli', 'claude')); assert.equal(claudeDefault.storage, ''); assert.equal(claudeDefault.token, undefined)
  const codexDefault = await run('codex')
  assert.equal(codexDefault.codexHome, path.join(controlDir, 'cli', 'codex')); assert.equal(codexDefault.auth, `link:${path.join(root, '.codex', 'auth.json')}`)
  // Named profiles use only their own store: no shared secure storage, no host link.
  for (const [name, token] of Object.entries(tokens)) {
    const claude = await run('claude', name)
    assert.deepEqual(claude, { config: path.join(controlDir, 'cli', 'profiles', name, 'claude'), token, auth: null })
    const codex = await run('codex', name)
    assert.deepEqual(codex, { codexHome: path.join(controlDir, 'cli', 'profiles', name, 'codex'), auth: 'file' })
  }
  // Unprovisioned or unsupported profiles fail closed before any process starts.
  for (const [cli, authProfile, error] of [['claude', 'missing', /not provisioned/], ['codex', 'missing', /not provisioned/], ['opencode', 'work', /Invalid auth profile/], ['claude', '../work', /Invalid auth profile/]] as const) {
    await ownerRun(controlDir, `r_reject_${n}`); await rm(observed, { force: true })
    await assert.rejects(startExecutorJob(['hello'], { workspace, controlDir, binDir: bin, cli, authProfile, runId: `r_reject_${n++}`, timeoutMs: 5000, repairEnabled: false }), error)
    await assert.rejects(stat(observed))
  }
  assert.equal((await lstat(path.join(controlDir, 'cli', 'profiles'))).isDirectory(), true)
  await assert.rejects(stat(path.join(controlDir, 'cli', 'profiles', 'missing')))
})

test('a conversation stays bound to its auth profile and never resumes under another', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-profile-sessions-'))
  try {
    const store = new ControlStore(root, 900000)
    await store.aiState(initialPreset('claude'))
    const work: AiPreset = { id: 'work', name: 'Claude work', cli: 'claude', authProfile: 'work', model: 'opus' }
    const personal: AiPreset = { id: 'personal', name: 'Claude personal', cli: 'claude', authProfile: 'personal', model: 'opus' }
    for (const preset of [work, personal]) await store.savePreset(preset)
    const first = await store.captureChoice(initialPreset('claude'))
    await store.markSessionStarted(first.sessionId)
    // A profile change is a new conversation, never an in-place settings change.
    assert.equal(await store.selectPreset('work', first.sessionId), false)
    assert.equal(await store.selectPreset('work', first.sessionId, true), true)
    const working = await store.captureChoice(initialPreset('claude'))
    assert.notEqual(working.sessionId, first.sessionId)
    assert.equal((await store.executionSession(working)).authProfile, 'work')
    await store.markSessionStarted(working.sessionId)
    // A choice that names another account for this session is rejected at launch.
    await assert.rejects(store.executionSession({ sessionId: working.sessionId, preset: personal }), /matching CLI binding/)
    await assert.rejects(store.executionSession({ sessionId: first.sessionId, preset: work }), /matching CLI binding/)
    // Switching back restores that conversation's own account.
    assert.equal(await store.selectPreset('personal', working.sessionId, true), true)
    const restored = await store.switchSession(working.sessionId)
    assert.equal(restored.authProfile, 'work')
    assert.equal((await store.captureChoice(initialPreset('claude'))).preset.authProfile, 'work')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('catalog offers provisioned profiles only; host refuses a request that changes the captured profile', {skip:process.platform==='win32'}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-profile-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(restoreEnv(['PATH']))
  const workspace = path.join(root, 'mind'), controlDir = path.join(root, 'control'), bin = path.join(root, 'bin'), directory = path.join(controlDir, 'host-executor')
  await mkdir(workspace, { recursive: true }); await mkdir(bin); await mkdir(directory, { recursive: true })
  for (const cli of ['codex', 'claude']) await writeFile(path.join(bin, cli), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await mkdir(path.join(controlDir, 'cli', 'profiles', 'work', 'claude'), { recursive: true })
  process.env.PATH = bin + path.delimiter + process.env.PATH
  const catalog = await readModels(root, undefined, path.join(controlDir, 'cli', 'codex'), undefined, undefined, undefined, controlDir)
  assert.deepEqual(catalog.filter(model => model.authProfile), [{ cli: 'claude', name: 'work · claude · client default', efforts: [], authProfile: 'work' }])
  await validateSelection({ id: 'w', name: 'w', cli: 'claude', authProfile: 'work' }, catalog)
  await assert.rejects(validateSelection({ id: 'p', name: 'p', cli: 'claude', authProfile: 'personal' }, catalog), /not provisioned/)

  const runs = new RunStore(controlDir)
  await ownerRun(controlDir, 'r_seed')
  const execution = { sessionId: '00000000-0000-4000-8000-000000000001', preset: { id: 'work', name: 'work', cli: 'claude', authProfile: 'work' } }
  for (const id of ['r_wrong', 'r_right', 'r_dropped']) {
    await runs.create({ id, chatId: 101, telegramUserId: 101, texts: ['hello'], execution })
    await runs.patch(id, { status: 'running' })
  }
  const abort = new AbortController(), launched: string[] = []
  const server = serveHostExecutor({ cli: 'codex', agents: [{ name: 'test', workspace, controlDir, binDir: bin }] }, abort.signal, async (_texts, options) => {
    launched.push(`${options.runId}:${options.authProfile}`)
    return { child: spawn(process.execPath, ['-e', 'process.exit(0)']), cleanup: async () => {}, stdout: '' }
  })
  try {
    const exit = async (id: string, options: Record<string, unknown>) => {
      await writeFile(path.join(directory, `${id}.request.json`), JSON.stringify({ texts: ['hello'], options }))
      for (let n = 0; n < 200; n++) {
        const events = await readFile(path.join(directory, `${id}.events`), 'utf8').catch(() => '')
        const code = events.match(/"stream":"exit","code":(\d+)/)?.[1]
        if (code !== undefined) return { code: Number(code), events }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('host request did not finish')
    }
    for (const [id, options] of [['r_wrong', { authProfile: 'personal' }], ['r_dropped', {}]] as const) {
      const result = await exit(id, { cli: 'claude', sessionId: execution.sessionId, ...options })
      assert.equal(result.code, 1); assert.match(result.events, /does not match its captured AI selection/)
    }
    assert.equal((await exit('r_right', { cli: 'claude', authProfile: 'work', sessionId: execution.sessionId })).code, 0)
    assert.deepEqual(launched, ['r_right:work'])
  } finally { abort.abort(); await server }
})

test('profile setup and diagnostics never print credentials or account identity', {skip:process.platform==='win32'}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-profile-cli-'))
  try {
    const controlDir = path.join(root, 'control'), bin = path.join(root, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = auth ]; then
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","email":"owner@example.com","orgId":"org-secret"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
exit 0
`, { mode: 0o700 })
    await writeFile(path.join(bin, 'codex'), '#!/bin/sh\n[ -f "$CODEX_HOME/auth.json" ] && { echo "Logged in using ChatGPT (owner@example.com)" >&2; exit 0; }\necho "Not logged in"; exit 1\n', { mode: 0o700 })
    const store = new ControlStore(controlDir, 900000); await store.aiState(initialPreset('claude'))
    const env = { ...process.env, HOME: root, PATH: bin + path.delimiter + process.env.PATH, EZ_CONTROL_DIR: controlDir }
    const ai = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs', import.meta.url)), ...args], { env, encoding: 'utf8' })
    for (const [cli, name] of [['claude', 'work'], ['claude', 'personal'], ['codex', 'work']]) {
      const added = ai('profile', 'add', '--cli', cli, '--auth-profile', name)
      assert.equal(added.status, 0, added.stderr)
      const home = path.join(controlDir, 'cli', 'profiles', name, cli)
      assert.equal(JSON.parse(added.stdout).home, home)
      assert.equal((await stat(home)).mode & 0o777, 0o700)
    }
    assert.notEqual(ai('profile', 'add', '--cli', 'opencode', '--auth-profile', 'work').status, 0)
    await writeFile(path.join(controlDir, 'cli', 'profiles', 'work', 'claude', 'oauth-token'), 'sk-ant-oat01-never_printed_token', { mode: 0o600 })
    await writeFile(path.join(controlDir, 'cli', 'profiles', 'work', 'codex', 'auth.json'), '{"tokens":"never-printed"}', { mode: 0o600 })
    const profiles = ai('profiles')
    assert.equal(profiles.status, 0, profiles.stderr)
    for (const secret of ['never_printed', 'never-printed', 'owner@example.com', 'org-secret']) assert.equal(profiles.stdout.includes(secret), false)
    const byKey = Object.fromEntries((JSON.parse(profiles.stdout) as Awaited<ReturnType<typeof authProfileStatus>>).map(item => [`${item.cli}@${item.authProfile}`, item]))
    assert.deepEqual(byKey['claude@work'], { cli: 'claude', authProfile: 'work', provisioned: true, sharesHostLogin: false, credentialFiles: ['oauth-token'], loggedIn: true, method: 'oauth_token' })
    assert.equal(byKey['claude@personal'].loggedIn, false)
    assert.deepEqual(byKey['codex@work'], { cli: 'codex', authProfile: 'work', provisioned: true, sharesHostLogin: false, credentialFiles: ['auth.json'], loggedIn: true, method: 'chatgpt' })
    assert.equal(byKey['claude@null'].sharesHostLogin, true)
    // Selecting a provisioned profile binds a fresh conversation to it.
    const selected = ai('select', '--cli', 'claude', '--auth-profile', 'work')
    assert.equal(selected.status, 0, selected.stderr)
    assert.equal((await store.status()).activeSession?.authProfile, 'work')
    assert.notEqual(ai('select', '--cli', 'claude', '--auth-profile', 'unknown').status, 0)
    assert.equal((await store.status()).activeSession?.authProfile, 'work')
  } finally { await rm(root, { recursive: true, force: true }) }
})
