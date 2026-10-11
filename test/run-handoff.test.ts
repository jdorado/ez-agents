import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { Scheduler, holdsSchedule } from '../src/scheduler.js'
import { initialPreset } from '../src/ai.js'

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('Timed out')
}
const config = (controlDir: string, workspace: string) =>
  ({ workspace, controlDir, pairingTtlMs: 1000, executorTimeoutMs: 0, executorCli: 'grok', telegramBotToken: 'fixture' })

// The test is the host transport: it claims requests, streams events and
// keeps the heartbeat fresh. A second path to the same control directory gives
// the next relay an empty memory ledger, as a replacement process would have.
const fixture = async (t: test.TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'ez-run-handoff-')), dir = join(root, 'control'), next = join(root, 'next-control')
  const host = join(dir, 'host-executor')
  await mkdir(host, { recursive: true, mode: 0o700 }); await symlink(dir, next)
  const transport = process.env.EZ_EXECUTOR_TRANSPORT
  process.env.EZ_EXECUTOR_TRANSPORT = 'host'
  const beat = setInterval(() => void writeFile(join(host, 'beat.tmp'), JSON.stringify({ at: Date.now() }))
    .then(() => rename(join(host, 'beat.tmp'), join(host, 'heartbeat.json'))).catch(() => {}), 200)
  t.after(async () => {
    clearInterval(beat)
    if (transport === undefined) delete process.env.EZ_EXECUTOR_TRANSPORT; else process.env.EZ_EXECUTOR_TRANSPORT = transport
    await rm(root, { recursive: true, force: true })
  })
  const files = async () => (await readdir(host)).filter(file => file !== 'heartbeat.json' && !file.endsWith('.tmp')).sort()
  const control = new ControlStore(dir, 1000)
  await control.requestPairing(101, 101); await control.approveOwner(101)
  return { root, dir, next, host, files, control, owner: (await control.status()).owner! }
}

test('a graceful relay stop hands running host work to the next relay, which records it without relaunching', async t => {
  const { root, dir, next, host, files, control, owner } = await fixture(t)
  const scheduler = new Scheduler(dir), first = new RunStore(dir)
  const execution = await control.captureChoice({ ...initialPreset('grok'), model: 'fixture-model' })
  const due = Date.now() + 1000
  const saved = await scheduler.save({ id: 'long', name: 'Long', text: 'Long work', owner, execution, enabled: true,
    trigger: { everySeconds: 60, start: new Date(due).toISOString() } }, true)
  await scheduler.tick(owner, first, due)
  const foreground = await first.create({ chatId: 101, telegramUserId: 101, texts: ['chat'], execution })
  const before = createRelay(config(dir, root))
  await before.drainSources()
  const scheduled = (await first.list()).find(run => run.scheduled)!
  for (const id of [foreground.id, scheduled.id]) {
    await until(async () => (await files()).includes(id + '.request.json'))
    await rename(join(host, id + '.request.json'), join(host, id + '.running.json'))
    await appendFile(join(host, id + '.events'), JSON.stringify({ stream: 'stdout', text: 'working\n' }) + '\n')
  }
  const delivered=await first.enqueueMessage(scheduled.id,'Delivered before replacement')
  await first.claimOutbox(delivered.id)
  await first.markOutboxSent(delivered.id,[17])
  await before.stop()
  assert.equal((await stat(join(dir, 'run-handoff.json'))).mode & 0o777, 0o600)
  const handoff = JSON.parse(await readFile(join(dir, 'run-handoff.json'), 'utf8'))
  assert.ok(Date.now() - Date.parse(handoff.writtenAt) < 60_000)
  assert.deepEqual(handoff.runs.map((run: { id: string; status: string }) => [run.id, run.status]).sort(),
    [[foreground.id, 'running'], [scheduled.id, 'running']].sort())
  assert.deepEqual(await files(), [foreground.id + '.events', foreground.id + '.running.json', scheduled.id + '.events', scheduled.id + '.running.json'].sort(),
    'the stop must not cancel, finish or resubmit host work')

  const after = createRelay(config(next, root)), runs = new RunStore(next)
  after.bot.botInfo = { id: 999, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } as typeof after.bot.botInfo
  after.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  try {
    await after.adoptHandoff()
    await assert.rejects(readFile(join(dir, 'run-handoff.json')), { code: 'ENOENT' })
    assert.deepEqual((await runs.list()).map(run => run.status), ['running', 'running'])
    assert.deepEqual(await runs.waitForDelivery(delivered.id,100),await first.waitForDelivery(delivered.id,100))
    // The new ledger accepts the run's result delivery and holds its recurring schedule.
    assert.ok(await runs.enqueueMessage(scheduled.id, 'Result after replacement'))
    await scheduler.tick(owner, runs, due + 60_000); await after.drainSources()
    assert.equal((await runs.list()).length, 2, 'the next recurrence waits for the adopted occurrence')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(!(await files()).some(file => file.endsWith('.request.json') || file.endsWith('.cancel')), 'adoption never resubmits or cancels')
    await appendFile(join(host, foreground.id + '.events'), JSON.stringify({ stream: 'exit', code: 0 }) + '\n')
    await rm(join(host, foreground.id + '.running.json'))
    await until(async () => (await runs.get(foreground.id))?.status === 'completed')
    assert.equal((await new ControlStore(next, 1000).executionSession(execution)).hasStarted, true)
    // /stop reaches the adopted run through the existing cancel path.
    await after.bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, text: '/stop', from: { id: 101, is_bot: false, first_name: 'Owner' }, chat: { id: 101, type: 'private', first_name: 'Owner' } } } as Update)
    await until(async () => (await runs.get(scheduled.id))?.status === 'cancelled')
    assert.ok((await files()).includes(scheduled.id + '.cancel'), 'the host is asked to stop the adopted executor')
    assert.equal(holdsSchedule(saved, (await runs.get(scheduled.id))!), false)
  } finally { await after.stop() }
})

test('adoption fails closed for unknown, invalid, stale or corrupt handoff records and never launches', async t => {
  const { root, dir, files, owner } = await fixture(t)
  const scheduler = new Scheduler(dir)
  const saved = await scheduler.save({ id: 'gone', name: 'Gone', text: 'work', owner, enabled: true, trigger: { everySeconds: 60, start: new Date(Date.now() + 1000).toISOString() },
    execution: { sessionId: '00000000-0000-4000-8000-000000000000', preset: { ...initialPreset('grok'), model: 'fixture-model' } } }, true)
  const lost = { version: 1, id: 'r_schedule_lost', chatId: 101, telegramUserId: 101, texts: ['work'], status: 'running', createdAt: new Date().toISOString(),
    scheduled: { id: saved.id, revision: saved.revision, dueAt: new Date().toISOString(), pairedAt: owner.pairedAt } }
  const write = (runs: unknown[], writtenAt = new Date().toISOString()) => writeFile(join(dir, 'run-handoff.json'), JSON.stringify({ version: 1, writtenAt, runs }))
  await write([lost, { ...lost, id: '../escape' }, { ...lost, id: 'r_done', status: 'completed' }])
  let launches = 0
  const relay = createRelay(config(dir, root), async () => { launches++; throw new Error('Must not launch') }), runs = new RunStore(dir)
  try {
    await relay.adoptHandoff()
    await until(async () => (await runs.get(lost.id))?.status === 'failed')
    const failed = (await runs.get(lost.id))!
    assert.match(failed.failure?.error ?? '', /outcome is unknown/)
    assert.equal(failed.failureReason, 'handoff-outcome-unknown')
    assert.equal(failed.interrupted, true)
    assert.equal(holdsSchedule(saved, failed), true, 'an unknown outcome holds its schedule until an explicit edit')
    assert.deepEqual((await runs.list()).map(run => run.id), [lost.id])
    for (const stale of [() => write([{ ...lost, id: 'r_schedule_stale' }], new Date(Date.now() - 25 * 3600_000).toISOString()), () => writeFile(join(dir, 'run-handoff.json'), '{not json')]) {
      await stale()
      await relay.adoptHandoff()
      await assert.rejects(readFile(join(dir, 'run-handoff.json')), { code: 'ENOENT' })
    }
    await relay.drainSources()
    assert.equal(launches, 0)
    assert.deepEqual((await runs.list()).map(run => run.id), [lost.id])
    assert.deepEqual(await files(), [])
  } finally { await relay.stop() }
  // A relay without host transport removes a record it cannot adopt.
  delete process.env.EZ_EXECUTOR_TRANSPORT
  await write([{ ...lost, id: 'r_schedule_local' }])
  const local = createRelay(config(dir, root))
  try {
    await local.adoptHandoff()
    await assert.rejects(readFile(join(dir, 'run-handoff.json')), { code: 'ENOENT' })
    assert.equal(await runs.get('r_schedule_local'), null)
  } finally { await local.stop() }
})

test('an adopted scheduled run continues a terminal quota limit on its next saved login', async t => {
  const { root, dir, next, host, files, owner } = await fixture(t)
  const scheduler = new Scheduler(dir), first = new RunStore(dir)
  const primary = { ...initialPreset('claude'), model: 'opus', effort: 'xhigh' }
  const profiles = ['claude2', 'claude3'].map((authProfile, i) => ({ ...primary, id: `fallback-${i + 1}`, authProfile }))
  const saved = await scheduler.save({ id: 'quota', name: 'Quota', text: 'Saved work', owner, enabled: true,
    trigger: { at: '2027-01-01T00:00:00Z' }, execution: { sessionId: '00000000-0000-4000-8000-000000000000', preset: primary, fallbacks: profiles } }, true)
  const run = await scheduler.trigger(saved.id, saved.revision, 'adopt-quota', owner, first)
  const before = createRelay(config(dir, root))
  t.after(() => before.stop())
  before.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  for (const profile of profiles) await mkdir(join(dir, 'cli', 'profiles', profile.authProfile, 'claude'), { recursive: true })
  const event = (text: unknown) => JSON.stringify({ stream: 'stdout', text: JSON.stringify(text) + '\n' }) + '\n'
  await before.drainSources()
  await until(async () => (await files()).includes(run.id + '.request.json'))
  await rename(join(host, run.id + '.request.json'), join(host, run.id + '.running.json'))
  await appendFile(join(host, run.id + '.events'), event({ type: 'assistant', error: 'rate_limit' }) + JSON.stringify({ stream: 'exit', code: 1 }) + '\n')
  await rm(join(host, run.id + '.running.json'))
  await until(async () => (await first.get(run.id))?.attempts?.length === 2 && (await files()).includes(run.id + '.request.json'))
  await rename(join(host, run.id + '.request.json'), join(host, run.id + '.running.json'))
  await appendFile(join(host, run.id + '.events'), event({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }))
  const partialSession = (await first.get(run.id))!.attempts![1].sessionId!
  await before.stop()

  const launches: { authProfile?: string; model?: string; effort?: string; runId: string; sessionId?: string; texts: string[] }[] = []
  const after = createRelay(config(next, root), async (texts, options) => {
    launches.push({ authProfile: options.authProfile, model: options.model, effort: options.effort, runId: options.runId, sessionId: options.sessionId, texts })
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"ez.startup",workBegan:true})+String.fromCharCode(10));setTimeout(()=>process.exit(0),20)'])
    await once(child, 'spawn')
    return { child, cleanup: async () => {}, stdout: '' }
  }), runs = new RunStore(next)
  after.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  try {
    await after.adoptHandoff()
    assert.equal(launches.length, 0, 'adoption only attaches to the existing native session')
    await appendFile(join(host, run.id + '.events'), event({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2114380800 } }) +
      event({ type: 'assistant', error: 'rate_limit' }) + JSON.stringify({ stream: 'exit', code: 1 }) + '\n')
    await rm(join(host, run.id + '.running.json'))
    await until(async () => ['completed', 'failed'].includes((await runs.get(run.id))!.status))
    const ended = (await runs.get(run.id))!
    assert.equal(ended.status, 'completed')
    assert.deepEqual(ended.attempts!.map(a => [a.quotaScope, a.outcome, a.category]), [
      ['claude', 'failed', 'quota'], ['claude@claude2', 'failed', 'quota-after-work-began'], ['claude@claude3', 'completed', undefined],
    ])
    assert.equal(launches.length, 1)
    assert.deepEqual([launches[0].authProfile, launches[0].model, launches[0].effort, launches[0].runId], ['claude3', 'opus', 'xhigh', run.id])
    assert.notEqual(launches[0].sessionId, partialSession)
    assert.match(launches[0].texts.at(-1)!, new RegExp(`began work in native session ${partialSession}.*That work may be partly applied`))
    assert.equal((await runs.list()).length, 1)
  } finally { await after.stop() }
})
