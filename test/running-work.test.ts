import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Owner } from '../src/control-state.js'
import { ControlStore } from '../src/control-state.js'
import { type RunRecord, RunStore } from '../src/runs.js'
import { type Schedule, Scheduler } from '../src/scheduler.js'
import { projectRunningWork, formatRunningWork, runningWork } from '../src/running-work.js'
import { callDeliverySocket, socketPathFor } from '../src/delivery-socket.js'
import { ownerRun } from './helpers/owner-run.js'
import { serveTestLedger } from './helpers/ledger.js'

const exec = promisify(execFile)
const owner: Owner = { telegramUserId: 101, telegramChatId: 101, pairedAt: '2026-01-01T00:00:00Z' }
const now = Date.parse('2026-10-12T16:00:00Z')
const run = (id: string, change: Partial<RunRecord> = {}): RunRecord => ({
  version: 1, id, chatId: 101, telegramUserId: 101, texts: ['PRIVATE PROMPT'], status: 'running',
  createdAt: '2026-10-12T15:00:00Z', startedAt: '2026-10-12T15:01:00Z', ...change,
})
const origin = { id: 'daily', revision: 'revision', dueAt: '2026-10-12T15:00:00Z', pairedAt: owner.pairedAt }
const execution = { sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', preset: { id: 'primary', name: 'Primary', cli: 'codex', model: 'fixture-model' } }

test('one view combines foreground, queued and scheduled work with timestamps and honest provenance', () => {
  const foreground = run('foreground', { execution })
  const scheduled = run('scheduled', { scheduled: { ...origin, originRunId: 'finished_origin' }, execution })
  const queued = run('queued', { status: 'queued', startedAt: undefined, scheduled: { ...origin, originRunId: 'foreground' } })
  const definition: Schedule = { version: 1, ...origin, name: 'Daily report', text: 'PRIVATE SCHEDULE TEXT',
    trigger: { at: origin.dueAt }, enabled: true, owner, execution }
  const view = projectRunningWork([queued, scheduled, foreground, run('finished_origin', { status: 'completed' })],
    [{ id: 'delivery', runId: 'foreground', chatId: 101, createdAt: '2026-10-12T15:55:00Z', text: 'PRIVATE MESSAGE', state: 'sent' }], [definition], owner, now)
  assert.deepEqual(view.counts, { running: 2, queued: 1 })
  assert.deepEqual(view.runs.map(item => item.id), ['foreground', 'scheduled', 'queued'])
  const first = view.runs[0], second = view.runs[1], third = view.runs[2]
  assert.equal(first.elapsedSeconds, 3540)
  assert.deepEqual(first.lastObservedActivity, { at: '2026-10-12T15:55:00.000Z', kind: 'delivery-enqueued', ageSeconds: 300 })
  assert.deepEqual(first.scheduledChildren, [{ id: 'queued', status: 'queued' }])
  assert.deepEqual(second.origin, { runId: 'finished_origin', relation: 'schedule-origin', status: 'completed', retained: true })
  assert.equal(second.schedule?.name, 'Daily report')
  assert.equal(third.startedAt, null); assert.equal(third.elapsedSeconds, null); assert.equal(third.queuedSeconds, 3600)
  assert.deepEqual(first.nativeChildren, { state: 'unavailable' })
  const human = formatRunningWork(view), json = JSON.stringify(view)
  assert.match(human, /2 running, 1 queued/); assert.match(human, /Daily report/); assert.match(human, /completed/)
  assert.match(human, /Native children: unavailable/); assert.match(human, /schedule-origin|Schedule origin/)
  assert.ok(!human.includes('PRIVATE') && !json.includes('PRIVATE'))
})

test('old running records remain running, missing/future telemetry stays unknown, terminals are omitted', () => {
  const records = [
    run('stale', { startedAt: '2026-01-02T00:00:00Z' }),
    run('partial', { startedAt: undefined, execution: { ...execution, preset: { ...execution.preset, model: undefined } } }),
    run('future', { createdAt: '2026-10-13T00:00:00Z', startedAt: '2026-10-13T01:00:00Z' }),
    ...(['completed', 'failed', 'cancelled'] as const).map(status => run(status, { status })),
  ]
  const before = structuredClone(records)
  const view = projectRunningWork(records, [], [], owner, now)
  assert.equal(view.counts.running, 3); assert.equal(view.counts.queued, 0)
  assert.equal(view.runs.find(item => item.id === 'stale')?.status, 'running')
  const partial = view.runs.find(item => item.id === 'partial')!
  assert.equal(partial.elapsedSeconds, null); assert.equal(partial.execution?.model, null)
  const future = view.runs.find(item => item.id === 'future')!
  assert.equal(future.elapsedSeconds, null); assert.equal(future.lastObservedActivity, null)
  assert.match(formatRunningWork(view), /silence is not idle or completion/)
  assert.deepEqual(records, before, 'a status read must not reconcile, cancel or complete work')
})

test('fallback metadata uses the latest non-skipped saved setup, and every engine retains its visibility limits', () => {
  const claude = { id: 'fallback', name: 'Fallback', cli: 'claude', model: 'opus' }
  const records = ['codex', 'codex-gui', 'claude', 'grok', 'opencode', 'pi'].map(cli => run(cli, {
    execution: { ...execution, preset: { ...execution.preset, cli, model: cli === 'opencode' ? 'provider/model' : undefined } },
    nativeSessionId: 'PRIVATE NATIVE SESSION', output: 'PRIVATE ENGINE OUTPUT',
  }))
  records.push(run('fallback', { execution: { ...execution, fallbacks: [claude] }, attempts: [
    { preset: execution.preset, quotaScope: 'codex', outcome: 'failed', startedAt: '2026-10-12T15:01:00Z', endedAt: '2026-10-12T15:02:00Z' },
    { preset: claude, quotaScope: 'claude', outcome: 'running', startedAt: '2026-10-12T15:03:00Z' },
    { preset: execution.preset, quotaScope: 'codex', outcome: 'skipped', startedAt: '2026-10-12T15:04:00Z' },
  ] }))
  records.push(run('script', { scheduled: origin, script: { id: 'guard', args: ['PRIVATE ARGUMENT'] } }))
  records.push(run('unknown_engine'))
  const view = projectRunningWork(records, [], [], owner, now)
  for (const cli of ['codex', 'codex-gui', 'claude', 'grok', 'opencode', 'pi']) {
    const item = view.runs.find(item => item.id === cli)!
    assert.equal(item.execution?.cli, cli)
    assert.equal(item.execution?.model, cli === 'opencode' ? 'provider/model' : null)
    assert.deepEqual(item.nativeChildren, { state: 'unavailable' })
  }
  const fallback = view.runs.find(item => item.id === 'fallback')!
  assert.equal(fallback.execution?.cli, 'claude'); assert.equal(fallback.execution?.model, 'opus')
  assert.equal(fallback.execution?.source, 'latest-attempt'); assert.equal(fallback.execution?.attemptOutcome, 'running')
  assert.equal(fallback.lastObservedActivity?.at, '2026-10-12T15:04:00.000Z')
  assert.equal(fallback.lastObservedActivity?.kind, 'setup-skipped')
  assert.equal(view.runs.find(item => item.id === 'script')?.execution, null)
  assert.equal(view.runs.find(item => item.id === 'unknown_engine')?.execution, null)
  assert.ok(!JSON.stringify(view).includes('PRIVATE'))
})

test('scope excludes revoked/unrelated work; missing origins and stale schedule definitions are not invented', () => {
  const view = projectRunningWork([
    run('visible', { scheduled: { ...origin, originRunId: 'other' } }),
    run('other', { chatId: 202, telegramUserId: 202 }),
    run('old', { scheduled: { ...origin, pairedAt: 'old-pairing' } }),
    run('pre-pairing', { createdAt: '2025-12-01T00:00:00Z' }),
    run('external', { external: { sourceId: 'private', bindingId: 'private', eventIds: ['private'] } }),
    run('isolated', { taskId: 'private' }),
    run('app', { application: { bindingId: 'private', scope: 'private', requestId: 'private', inputText: 'PRIVATE APP PROMPT', context: { secret: 'PRIVATE APP CONTEXT' } } }),
    run('channel', { delivery: { bindingId: 'private', scope: 'private' } }),
  ], [], [{ version: 1, id: 'daily', revision: 'new-revision', name: 'Wrong revision', owner } as Schedule], owner, now)
  assert.deepEqual(view.runs.map(item => item.id), ['app', 'channel', 'visible'])
  assert.equal(view.runs.find(item => item.id === 'app')?.kind, 'application-foreground')
  const scheduled = view.runs.find(item => item.id === 'visible')!
  assert.equal(scheduled.schedule?.name, null)
  assert.deepEqual(scheduled.origin, { runId: 'other', relation: 'schedule-origin', status: null, retained: false })
  assert.ok(!JSON.stringify(view).includes('PRIVATE'))
  assert.match(formatRunningWork(view), /status unknown; record unavailable/)
})

async function files(dir: string) {
  const result: Record<string, string> = {}
  for (const name of (await readdir(dir, { recursive: true })).sort())
    if ((await stat(join(dir, name))).isFile()) result[name] = await readFile(join(dir, name), 'utf8')
  return result
}

test('public CLI and socket return sanitized readable/JSON snapshots without changing control files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-running-work-'))
  const foreground = await ownerRun(dir, 'foreground')
  const ledger = await serveTestLedger(dir)
  t.after(async () => { await ledger.stop(); await rm(dir, { recursive: true, force: true }) })
  const control = new ControlStore(dir, 1000), runs = new RunStore(dir), boundOwner = (await control.status()).owner!
  const definition = await new Scheduler(dir).save({ id: 'daily', name: 'Daily report', text: 'PRIVATE TASK TEXT',
    owner: boundOwner, execution, originRunId: foreground.id, enabled: true, trigger: { at: new Date(Date.now() + 60_000).toISOString() } }, true)
  const scheduled = await runs.create({ id: 'scheduled', chatId: 101, telegramUserId: 101, texts: ['PRIVATE PROMPT'], execution,
    scheduled: { id: definition.id, revision: definition.revision, dueAt: new Date().toISOString(), pairedAt: boundOwner.pairedAt, originRunId: foreground.id } })
  await runs.patch(scheduled.id, { status: 'running', startedAt: new Date().toISOString(), nativeSessionId: 'PRIVATE SESSION', failureReason: 'PRIVATE FAILURE' })
  const before = await files(dir)
  const env = { ...process.env, EZ_CONTROL_DIR: dir, EZ_DELIVERY_SOCKET: ledger.socketPath, EZ_RUN_ID: foreground.id }
  const cli = (...args: string[]) => exec(process.execPath, ['bin/ezenciel-agents-schedule.mjs', 'running', ...args], { env })
  const human = (await cli()).stdout, json = (await cli('--json')).stdout, view = JSON.parse(json)
  assert.match(human, /2 running, 0 queued/); assert.match(human, /Daily report/)
  assert.equal(view.schemaVersion, 1); assert.equal(view.runs.length, 2)
  assert.equal(view.runs.find((item: any) => item.id === 'scheduled').origin.runId, foreground.id)
  assert.ok(!json.includes('PRIVATE') && !human.includes('PRIVATE'))
  assert.deepEqual(await files(dir), before)
  assert.equal((await runs.get('scheduled'))?.status, 'running')
  assert.match((await exec(process.execPath, ['bin/ezenciel-agents-schedule.mjs', '--help'])).stdout, /running \[--json\]/)
  await assert.rejects(cli('--model', 'override'), /accepts only --json/)
  await assert.rejects(cli('unexpected-id'), /accepts only --json/)
})

test('server rejects unauthorized/finished callers, revocation and an unavailable relay instead of reporting idle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-running-auth-'))
  await ownerRun(dir, 'caller')
  const ledger = await serveTestLedger(dir), runs = new RunStore(dir)
  t.after(async () => { await ledger.stop(); await rm(dir, { recursive: true, force: true }) })
  await ownerRun(dir, 'external', { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] })
  await assert.rejects(callDeliverySocket(socketPathFor(dir), { op: 'runningWork', payload: { callerRunId: 'external' } }), /blocked/)
  await assert.rejects(runningWork(dir, { callerRunId: '../caller' }), /identifier/)
  await runs.patch('caller', { replyOnly: true })
  await assert.rejects(runningWork(dir, { callerRunId: 'caller' }), /Telegram owner/)
  const application = await runs.create({ id: 'application', chatId: 101, telegramUserId: 101, texts: [],
    application: { bindingId: 'private', scope: 'private', requestId: 'private' } })
  await runs.patch(application.id, { status: 'running' })
  await assert.rejects(runningWork(dir, { callerRunId: application.id }), /Telegram owner/)
  await runs.patch('caller', { replyOnly: false, status: 'completed' })
  await assert.rejects(runningWork(dir, { callerRunId: 'caller' }), /No active core run/)
  await new ControlStore(dir, 1000).revokeOwner()
  await assert.rejects(runningWork(dir), /No authorized owner/)
  await ledger.stop()
  await assert.rejects(exec(process.execPath, ['bin/ezenciel-agents-schedule.mjs', 'running', '--json'], {
    env: { ...process.env, EZ_CONTROL_DIR: dir, EZ_DELIVERY_SOCKET: ledger.socketPath, EZ_RUN_ID: '' },
  }), /Delivery relay unavailable/)
})
