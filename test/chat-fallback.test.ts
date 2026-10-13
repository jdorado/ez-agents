import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Update } from 'grammy/types'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore, activeSetup } from '../src/runs.js'
import { initialPreset, resolveFallbacks, type AiPreset } from '../src/ai.js'
import type { ExecutorOptions } from '../src/executor.js'
import { telemetryObserver, validTelemetry } from '../src/run-telemetry.js'

const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)) } throw new Error('Timed out') }
const message = (id: number, text: string): Update => ({ update_id: id, message: { message_id: id, date: 0, text,
  from: { id: 101, is_bot: false, first_name: 'Owner' }, chat: { id: 101, type: 'private', first_name: 'Owner' } } })
const opus: AiPreset = { id: 'opus', name: 'Opus', cli: 'claude', model: 'opus', effort: 'high' }
const logins = ['claude2', 'claude3', 'claude4']
const codex: AiPreset = { id: 'codex-sol', name: 'Codex', cli: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }
const chain: AiPreset[] = [...logins.map(authProfile => ({ id: authProfile, name: authProfile, cli: 'claude', authProfile })), codex]
const quota = { type: 'assistant', error: 'rate_limit' }
const work = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }

type Script = { lines?: unknown[]; code?: number; hold?: boolean; throws?: boolean; beforeExit?: () => Promise<void> }
const fixture = async (name: string, scripts: Script[], options: { chain?: AiPreset[]; telemetry?: boolean } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), `ez-chat-${name}-`)), control = new ControlStore(dir, 1000), runs = new RunStore(dir)
  const launches: ExecutorOptions[] = [], prompts: string[][] = [], admitted: (AiPreset | undefined)[] = [], sent: string[] = []
  const relay = createRelay({ workspace: dir, controlDir: dir, pairingTtlMs: 1000, executorTimeoutMs: 0, executorCli: 'claude', telegramBotToken: 'fixture' }, async (texts, launch) => {
    const script = scripts[launches.length] ?? { code: 0 }
    launches.push(launch); prompts.push(texts)
    const run = (await runs.get(launch.runId))!
    admitted.push(run.attempts ? activeSetup(run) : run.execution?.preset)
    await script.beforeExit?.()
    if (script.throws) throw new Error('spawn failed after submission')
    const out = (script.lines ?? []).map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n')
    const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(out ? out + '\n' : '')});setTimeout(()=>process.exit(${script.code ?? 0}),${script.hold ? 60000 : 10})`], { detached: process.platform !== 'win32' })
    await once(child, 'spawn'); return { child, cleanup: async () => {}, stdout: '' }
  })
  relay.bot.botInfo = { id: 999, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } as typeof relay.bot.botInfo
  relay.bot.api.config.use(async (_prev, method, payload) => { if (method === 'sendMessage') sent.push((payload as { text: string }).text); return { ok: true, result: { message_id: 42 } } as never })
  await control.requestPairing(101, 101); await control.approveOwner(101)
  await control.aiState(initialPreset('claude')); await control.savePreset(opus)
  await control.selectPreset(opus.id, (await control.status()).activeSession?.sessionId ?? null, true)
  if (options.chain !== undefined) { if (options.chain.length) await control.setChatFallbacks(options.chain) } else await control.setChatFallbacks(chain)
  if (options.telemetry) await control.setRunTelemetry(true)
  let update = 0
  const turn = async (text = 'Owner request') => {
    const before = (await runs.list()).length
    await relay.bot.handleUpdate(message(++update, text)); await relay.drainInbox(true)
    await until(async () => (await runs.list()).length > before)
    const run = (await runs.list()).at(-1)!
    await until(async () => ['completed', 'failed', 'cancelled'].includes((await runs.get(run.id))!.status))
    return (await runs.get(run.id))!
  }
  const session = async () => (await control.status()).activeSession!
  return { dir, control, runs, relay, launches, prompts, admitted, sent, turn, session,
    close: async () => { await relay.stop(); await rm(dir, { recursive: true, force: true }) } }
}

test('the chat chain tries Claude default, Claude 2–4 and Codex in order, preserving the role model and effort', async () => {
  const f = await fixture('five', [{ lines: [quota], code: 1 }, { lines: [quota], code: 1 }, { lines: [quota], code: 1 }, { lines: [quota], code: 1 }, { lines: [work], code: 0 }])
  try {
    const run = await f.turn()
    assert.equal(run.status, 'completed')
    assert.deepEqual(f.launches.map(l => [l.cli, l.authProfile, l.model, l.effort, l.runId]), [
      ['claude', undefined, 'opus', 'high', run.id], ...logins.map(p => ['claude', p, 'opus', 'high', run.id]), ['codex', undefined, 'gpt-6.1-sol', 'xhigh', run.id]])
    assert.deepEqual(f.admitted.map(p => [p?.cli, p?.authProfile]), f.launches.map(l => [l.cli, l.authProfile]))
    assert.deepEqual(run.attempts!.map(a => [a.quotaScope, a.outcome, a.category]), [
      ['claude', 'failed', 'quota'], ['claude@claude2', 'failed', 'quota'], ['claude@claude3', 'failed', 'quota'], ['claude@claude4', 'failed', 'quota'], ['codex', 'completed', undefined]])
    assert.ok(f.launches.every(l => l.structuredOutput === true && !l.nativeSession))
    assert.ok(f.prompts.every(p => JSON.stringify(p) === JSON.stringify(f.prompts[0])), 'nothing ran, so no continuation fact is added')
    assert.equal((await f.runs.list()).length, 1)
  } finally { await f.close() }
})

test('queued work keeps the chain and choice captured when it was queued; roles keep their own model and effort', async () => {
  const f = await fixture('queued', [{ lines: [quota], code: 1 }, { lines: [work], code: 0 }])
  try {
    await f.relay.bot.handleUpdate(message(1, 'Queued request'))
    // Edits after admission apply to later work only.
    await f.control.setChatFallbacks([codex])
    const sonnet = { id: 'sonnet', name: 'Sonnet', cli: 'claude', model: 'sonnet', effort: 'medium' }
    await f.control.savePreset(sonnet); await f.control.selectPreset(sonnet.id, (await f.session()).sessionId)
    await f.relay.drainInbox(true)
    await until(async () => (await f.runs.list())[0]?.status === 'completed')
    const run = (await f.runs.list())[0]
    assert.deepEqual(run.execution!.fallbacks!.map(p => [p.authProfile, p.model, p.effort]), [...logins.map(p => [p, 'opus', 'high']), [undefined, 'gpt-6.1-sol', 'xhigh']])
    assert.deepEqual(f.launches.map(l => [l.authProfile, l.model, l.effort]), [[undefined, 'opus', 'high'], ['claude2', 'opus', 'high']])
    // An application role with its own model gets the same logins at that model.
    const role = { id: 'role', name: 'Role', cli: 'claude', model: 'haiku', effort: 'low' }
    await f.control.setChatFallbacks(chain)
    const captured = await f.control.captureApplicationChoice(initialPreset('claude'), 'a'.repeat(64), false, role)
    assert.deepEqual(captured.fallbacks!.map(p => [p.cli, p.authProfile, p.model, p.effort]), [...logins.map(p => ['claude', p, 'haiku', 'low']), ['codex', undefined, 'gpt-6.1-sol', 'xhigh']])
    assert.deepEqual(resolveFallbacks(opus, [{ ...opus, id: 'copy' }, ...chain, chain[0]]), resolveFallbacks(opus, chain), 'setups equal to an earlier one are dropped')
  } finally { await f.close() }
})

test('each login keeps its own native session for the conversation', async () => {
  const f = await fixture('sessions', [{ lines: [quota], code: 1 }, { lines: [work], code: 0 }, { lines: [work], code: 0 }, { lines: [work], code: 0 }], { chain: [chain[0]] })
  try {
    const conversation = (await f.session()).sessionId
    const first = await f.turn()
    assert.equal(first.status, 'completed')
    const [defaultLaunch, claude2Launch] = f.launches
    assert.equal(defaultLaunch.sessionId, conversation); assert.equal(defaultLaunch.isResume, false)
    assert.equal(claude2Launch.authProfile, 'claude2'); assert.notEqual(claude2Launch.sessionId, conversation); assert.equal(claude2Launch.isResume, false)
    let state = await f.session()
    assert.deepEqual(state.linked, [{ cli: 'claude', authProfile: 'claude2', sessionId: claude2Launch.sessionId, hasStarted: true }])
    assert.equal(state.hasStarted, false)
    // The rejected default login may have claimed its ID; its next attempt uses a fresh one.
    assert.ok(state.nativeSessionId && state.nativeSessionId !== conversation)
    // The default login is cooling down: the next turn resumes the claude2 session.
    const second = await f.turn()
    assert.deepEqual(second.attempts!.map(a => [a.quotaScope, a.outcome]), [['claude', 'skipped'], ['claude@claude2', 'completed']])
    assert.deepEqual([f.launches[2].authProfile, f.launches[2].sessionId, f.launches[2].isResume], ['claude2', claude2Launch.sessionId, true])
    // Once the default login is available again it starts its own session, never claude2's.
    await f.control.clearQuotaWait((await f.control.status()).owner!, ['claude'])
    const third = await f.turn()
    assert.equal(third.attempts!.length, 1)
    assert.deepEqual([f.launches[3].authProfile, f.launches[3].sessionId, f.launches[3].isResume], [undefined, state.nativeSessionId, false])
    state = await f.session()
    assert.equal(state.hasStarted, true); assert.equal(state.cli, 'claude'); assert.equal(state.authProfile, undefined)
  } finally { await f.close() }
})

test('owner stop cancels the turn and never advances to another login', async () => {
  const f = await fixture('stop', [{ lines: [quota], hold: true }])
  try {
    await f.relay.bot.handleUpdate(message(1, 'Long request')); await f.relay.drainInbox(true)
    await until(async () => Boolean((await f.runs.list())[0]?.pid))
    await f.relay.bot.handleUpdate(message(2, '/stop'))
    await until(async () => ['completed', 'failed', 'cancelled'].includes((await f.runs.list())[0].status))
    const run = (await f.runs.list())[0]
    assert.equal(run.status, 'cancelled'); assert.equal(f.launches.length, 1)
    assert.deepEqual(run.attempts!.map(a => a.outcome), ['cancelled'])
  } finally { await f.close() }
})

test('access denial, revoked owner authority and uncertain outcomes stop the chain without replay', async () => {
  const cases: [string, Script, string | undefined][] = [
    ['denied', { lines: [{ type: 'assistant', error: 'oauth_org_not_allowed' }, quota], code: 1 }, 'access-denied'],
    ['partial', { lines: [work, { type: 'assistant', error: 'overloaded' }], code: 1 }, 'after-work-began'],
    ['silent', { code: 1 }, 'uncertain'],
    ['spawn', { throws: true }, 'uncertain'],
  ]
  for (const [name, script, category] of cases) {
    const f = await fixture(name, [script])
    try {
      const run = await f.turn()
      assert.equal(run.status, 'failed', name); assert.equal(f.launches.length, 1, name)
      assert.deepEqual(run.attempts!.map(a => [a.preset.authProfile, a.outcome, a.category]), [[undefined, 'failed', category]], name)
    } finally { await f.close() }
  }
  // An eligible rejection still cannot advance once the owner binding is revoked.
  const revoke = { control: undefined as ControlStore | undefined }
  const f = await fixture('revoked', [{ lines: [quota], code: 1, beforeExit: async () => { await revoke.control!.revokeOwner() } }])
  revoke.control = f.control
  try {
    await f.relay.bot.handleUpdate(message(1, 'Request')); await f.relay.drainInbox(true)
    await until(async () => ['failed', 'cancelled', 'completed'].includes((await f.runs.list())[0]?.status ?? ''))
    assert.equal(f.launches.length, 1)
    assert.equal((await f.runs.list())[0].status, 'failed')
  } finally { await f.close() }
})

test('a usage limit after work began continues on the next login, told that work may be partly applied', async () => {
  const limit = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791460800 } }
  const f = await fixture('partial-limit', [{ lines: [work, limit, quota], code: 1 }, { lines: [work], code: 0 }])
  try {
    const run = await f.turn()
    assert.equal(run.status, 'completed')
    assert.deepEqual(run.attempts!.map(a => [a.quotaScope, a.category]), [['claude', 'quota-after-work-began'], ['claude@claude2', undefined]])
    assert.match(f.prompts[1].at(-1)!, /began work in native session .* That work may be partly applied\.\]$/)
    // The default session began work, so it resumes rather than being replaced.
    assert.equal((await f.session()).hasStarted, true)
  } finally { await f.close() }
})

test('without a chain or telemetry, chat behavior is unchanged', async () => {
  const f = await fixture('plain', [{ lines: [quota], code: 1 }], { chain: [] })
  try {
    const run = await f.turn()
    assert.equal(run.status, 'failed'); assert.equal(run.attempts, undefined); assert.equal(run.telemetry, undefined)
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0].structuredOutput, false)
  } finally { await f.close() }
})

const secret = 'SECRET-PROMPT-TOOL-ARG-RESULT-THOUGHT'
const claudeTurn = [
  { type: 'system', subtype: 'init', model: 'claude-opus-4-9', session_id: 's', tools: ['Bash'], cwd: '/private' },
  { type: 'user', message: { content: [{ type: 'text', text: secret }] } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: secret }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: secret } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: secret, is_error: true }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: secret }] } },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: secret }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 110, cache_creation_input_tokens: 0 } } },
  { type: 'result', subtype: 'success', is_error: false, result: secret, total_cost_usd: 1.23, usage: { input_tokens: 13, output_tokens: 14, cache_read_input_tokens: 210, cache_creation_input_tokens: 7 } },
]

test('telemetry deduplicates repeated and cumulative events and keeps only counts, names and categories', () => {
  let clock = 1000
  const observer = telemetryObserver({}, () => (clock += 250))
  for (const event of claudeTurn) observer.write(JSON.stringify(event) + '\n')
  const claude = observer.result()
  assert.deepEqual(claude, { coverage: 'complete', model: 'claude-opus-4-9',
    tokens: { input: 13, output: 14, cacheRead: 210, cacheWrite: 7, source: 'native-total' },
    tools: { calls: 1, completed: 1, errors: 1, durationMs: 250, byName: { Bash: { calls: 1, completed: 1, errors: 1, durationMs: 250 } } } })
  assert.ok(!JSON.stringify(claude).includes('SECRET') && !JSON.stringify(claude).includes('cost') && !JSON.stringify(claude).includes('1.23'))
  // Without a native total, repeated per-message usage is counted once and labelled partial.
  const partial = telemetryObserver()
  partial.write(claudeTurn.slice(0, 4).map(e => JSON.stringify(e)).join('\n') + '\n')
  assert.deepEqual(partial.result(), { coverage: 'partial', gaps: ['tokens-without-native-total', 'tools-incomplete'], model: 'claude-opus-4-9',
    tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7, source: 'message-sum' },
    tools: { calls: 1, completed: 0, errors: 0, durationMs: 0, byName: { Bash: { calls: 1, completed: 0, errors: 0, durationMs: 0 } } } })
  // Codex exec: repeated items count once; the last cumulative total replaces earlier ones.
  const codexEvents = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: secret } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: secret } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: secret, aggregated_output: secret, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'aifit', tool: 'workout_show', arguments: secret, status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 } },
    { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 80, output_tokens: 9 } }]
  const codexObserver = telemetryObserver({ cumulativeSession: true }, () => (clock += 100))
  codexObserver.write(codexEvents.map(e => JSON.stringify(e)).join('\n') + '\n')
  const codexResult = codexObserver.result()
  assert.deepEqual(codexResult.tokens, { input: 70, output: 9, cacheRead: 80, cacheWrite: 0, source: 'native-total' })
  assert.deepEqual(codexResult.gaps, ['tokens-may-include-earlier-session-turns', 'reported-model', 'tool-durations-partial'])
  assert.deepEqual(codexResult.tools!.byName, { command: { calls: 1, completed: 1, errors: 1, durationMs: 100 }, 'mcp:aifit/workout_show': { calls: 1, completed: 1, errors: 0, durationMs: 0 } })
  assert.ok(!JSON.stringify(codexResult).includes('SECRET'))
  // A forwarded summary replaces local observation; a malformed one is ignored.
  const forwarded = telemetryObserver()
  forwarded.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n' + JSON.stringify({ type: 'ez.telemetry', telemetry: claude }) + '\n')
  assert.deepEqual(forwarded.result(), claude)
  assert.equal(validTelemetry({ ...claude, model: secret + ' with spaces' }), undefined)
  assert.equal(validTelemetry({ ...claude, tokens: { ...claude.tokens, input: -1 } }), undefined)
  assert.equal(telemetryObserver().result().coverage, 'none')
})

test('opt-in run telemetry records each attempt without prompts, tool data or costs; default off', async () => {
  const f = await fixture('telemetry', [{ lines: [quota], code: 1 }, { lines: claudeTurn, code: 0 }], { chain: [chain[0]], telemetry: true })
  try {
    const run = await f.turn(`Owner says ${secret}`)
    assert.equal(run.status, 'completed'); assert.equal(run.telemetry, true)
    assert.ok(f.launches.every(l => l.telemetry === true))
    const [rejected, served] = run.attempts!
    assert.deepEqual(rejected.telemetry!.errors, ['rate_limit']); assert.equal(rejected.telemetry!.coverage, 'partial')
    assert.deepEqual([served.preset.authProfile, served.telemetry!.model, served.telemetry!.tokens?.output, served.telemetry!.tools?.calls], ['claude2', 'claude-opus-4-9', 14, 1])
    assert.ok(!JSON.stringify(run.attempts).includes('SECRET'))
    await f.control.setRunTelemetry(false)
    const off = await f.turn()
    assert.equal(off.telemetry, undefined); assert.ok(off.attempts!.every(a => a.telemetry === undefined))
    assert.ok(f.launches.at(-1)!.telemetry === false)
  } finally { await f.close() }
})

test('host transport admits only the active chat attempt and forwards Claude summaries without content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ez-chat-host-')), workspace = join(root, 'mind'), controlDir = join(root, 'control'), directory = join(controlDir, 'host-executor')
  const { serveHostExecutor } = await import('../src/host-executor.js')
  const abort = new AbortController(), launched: ExecutorOptions[] = [], oldPath = process.env.PATH
  let server: Promise<void> | undefined
  try {
    await mkdir(workspace, { recursive: true }); await mkdir(directory, { recursive: true }); await mkdir(join(root, 'bin'))
    await mkdir(join(controlDir, 'cli', 'profiles', 'claude2', 'claude'), { recursive: true })
    await writeFile(join(root, 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    process.env.PATH = join(root, 'bin') + ':' + oldPath
    const control = new ControlStore(controlDir, 900_000); await control.requestPairing(101, 101); await control.approveOwner(101)
    const runs = new RunStore(controlDir), id = 'r_chat_fallback'
    const claude2 = { ...opus, id: 'claude2', name: 'claude2', authProfile: 'claude2' }
    await runs.create({ id, chatId: 101, telegramUserId: 101, texts: ['work'], execution: { sessionId: '00000000-0000-4000-8000-000000000000', preset: opus, fallbacks: [claude2] } })
    await runs.patch(id, { status: 'running', telemetry: true, attempts: [{ preset: opus, quotaScope: 'claude', outcome: 'failed', category: 'quota' }, { preset: claude2, quotaScope: 'claude@claude2', outcome: 'running' }] })
    server = serveHostExecutor({ cli: 'claude', agents: [{ name: 't', workspace, controlDir, binDir: join(root, 'bin') }] }, abort.signal, async (_texts, options) => {
      launched.push(options)
      const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(claudeTurn.map(e => JSON.stringify(e)).join('\n') + '\n')});process.exit(0)`])
      return { child, cleanup: async () => {}, stdout: '' }
    }, async () => [{ cli: 'claude', model: 'opus', name: 'Opus', efforts: ['high'] }, { cli: 'claude', authProfile: 'claude2', model: 'opus', name: 'Opus', efforts: ['high'] }])
    const events = async () => { for (let n = 0; n < 150; n++) { try { const text = await readFile(join(directory, id + '.events'), 'utf8'); if (text.includes('"stream":"exit"')) return text } catch {}; await new Promise(r => setTimeout(r, 20)) } throw new Error('No exit event') }
    const request = (options: object) => writeFile(join(directory, id + '.request.json'), JSON.stringify({ texts: ['work'], options }))
    for (let n = 0; n < 100 && !await readFile(join(directory, 'heartbeat.json')).then(() => true, () => false); n++) await new Promise(r => setTimeout(r, 20))
    const { rm: remove } = await import('node:fs/promises')
    // The rejected default login is no longer admitted for this run.
    await request({ cli: 'claude', model: 'opus', effort: 'high' })
    assert.match(await events(), /auth profile does not match its captured AI selection/); await remove(join(directory, id + '.events'))
    await request({ cli: 'claude', model: 'sonnet', effort: 'high', authProfile: 'claude2' })
    assert.match(await events(), /does not match its captured AI selection/); await remove(join(directory, id + '.events'))
    await request({ cli: 'claude', model: 'opus', effort: 'high', authProfile: 'claude2' })
    const output = await events()
    assert.equal(launched.length, 1)
    assert.deepEqual([launched[0].authProfile, launched[0].structuredOutput, launched[0].telemetry, launched[0].nativeSession], ['claude2', true, true, false])
    const lines = output.trim().split('\n').map(l => JSON.parse(l)).filter(e => e.stream === 'stdout').flatMap(e => e.text.trim().split('\n').map((l: string) => JSON.parse(l)))
    assert.ok(lines.every((e: { type: string }) => ['ez.startup', 'ez.telemetry'].includes(e.type)))
    assert.equal(lines.filter((e: { type: string }) => e.type === 'ez.telemetry').at(-1).telemetry.tokens.output, 14)
    assert.doesNotMatch(output, /SECRET/)
  } finally { abort.abort(); await server; process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }) }
})

test('AI CLI saves, shows and clears the chat chain and toggles telemetry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ez-ai-chain-'))
  try {
    const controlDir = join(root, 'control'), binDir = join(root, 'bin')
    await mkdir(join(controlDir, 'host-executor'), { recursive: true }); await mkdir(binDir)
    for (const cli of ['claude', 'codex']) await writeFile(join(binDir, cli), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    for (const profile of logins) await mkdir(join(controlDir, 'cli', 'profiles', profile, 'claude'), { recursive: true })
    await writeFile(join(controlDir, 'host-executor', 'models.json'), JSON.stringify([
      { cli: 'claude', model: 'opus', name: 'Opus', efforts: ['high'] }, ...logins.map(authProfile => ({ cli: 'claude', authProfile, model: 'opus', name: 'Opus', efforts: ['high'] })),
      { cli: 'codex', model: 'gpt-6.1-sol', name: 'Sol', efforts: ['xhigh'] }]))
    const store = new ControlStore(controlDir, 900000); await store.aiState(initialPreset('claude')); await store.savePreset(opus)
    await store.selectPreset(opus.id, null, true)
    const env = { ...process.env, HOME: root, PATH: binDir + ':' + process.env.PATH, EZ_CONTROL_DIR: controlDir, EZ_AI_CATALOG: 'host' }
    const bin = fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs', import.meta.url))
    const call = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })
    const set = call('fallbacks', ...logins.flatMap(p => ['--fallback', `cli=claude,auth-profile=${p}`]), '--fallback', 'cli=codex,model=gpt-6.1-sol,effort=xhigh')
    assert.equal(set.status, 0, set.stderr)
    assert.deepEqual(JSON.parse(set.stdout).order, ['claude · opus · high', ...logins.map(p => `claude@${p} · opus · high`), 'codex · gpt-6.1-sol · xhigh'])
    assert.notEqual(call('fallbacks', '--fallback', 'cli=claude,auth-profile=missing').status, 0, 'an unprovisioned login is refused')
    assert.notEqual(call('fallbacks', '--fallback', 'cli=codex,model=unknown').status, 0, 'an unadvertised model is refused')
    assert.equal((await store.status()).ai!.fallbacks!.length, 4)
    assert.equal(JSON.parse(call('telemetry').stdout).runTelemetry, 'off')
    assert.equal(JSON.parse(call('telemetry', 'on').stdout).runTelemetry, 'on'); assert.equal((await store.status()).runTelemetry, true)
    assert.equal(JSON.parse(call('telemetry', 'off').stdout).runTelemetry, 'off')
    assert.equal(call('fallbacks', '--clear').status, 0); assert.equal((await store.status()).ai!.fallbacks, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
