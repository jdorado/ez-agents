import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { Scheduler } from '../src/scheduler.js'
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
  return { root, dir, next, host, files }
}

test('a graceful relay stop hands running host work to the next relay, which records it without relaunching', async t => {
  const { root, dir, next, host, files } = await fixture(t)
  const control = new ControlStore(dir, 1000), scheduler = new Scheduler(dir), first = new RunStore(dir)
  await control.requestPairing(101, 101); await control.approveOwner(101)
  const owner = (await control.status()).owner!
  const execution = await control.captureChoice({ ...initialPreset('grok'), model: 'fixture-model' })
  const due = Date.now() + 1000
  await scheduler.save({ id: 'long', name: 'Long', text: 'Long work', owner, execution, enabled: true, trigger: { at: new Date(due).toISOString() } }, true)
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
  await before.stop()
  const handoff = JSON.parse(await readFile(join(dir, 'run-handoff.json'), 'utf8'))
  assert.deepEqual(handoff.runs.map((run: { id: string; status: string }) => [run.id, run.status]).sort(),
    [[foreground.id, 'running'], [scheduled.id, 'running']].sort())
  assert.deepEqual(await files(), [foreground.id + '.events', foreground.id + '.running.json', scheduled.id + '.events', scheduled.id + '.running.json'].sort(),
    'the stop must not cancel, finish or resubmit host work')

  const after = createRelay(config(next, root)), runs = new RunStore(next)
  try {
    await after.adoptHandoff()
    await assert.rejects(readFile(join(dir, 'run-handoff.json')), { code: 'ENOENT' })
    assert.deepEqual((await runs.list()).map(run => run.status), ['running', 'running'])
    // The new ledger accepts the run's result delivery and holds its schedule.
    assert.ok(await runs.enqueueMessage(scheduled.id, 'Result after replacement'))
    await scheduler.tick(owner, runs, due + 60_000); await after.drainSources()
    assert.equal((await runs.list()).length, 2, 'no duplicate occurrence or queued replacement')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(!(await files()).some(file => file.endsWith('.request.json') || file.endsWith('.cancel')), 'adoption never resubmits or cancels')
    for (const [id, code] of [[foreground.id, 0], [scheduled.id, 3]] as const) {
      await appendFile(join(host, id + '.events'), JSON.stringify({ stream: 'exit', code }) + '\n')
      await rm(join(host, id + '.running.json'))
    }
    await until(async () => (await runs.list()).every(run => run.status !== 'running'))
    assert.equal((await runs.get(foreground.id))?.status, 'completed')
    assert.equal((await runs.get(scheduled.id))?.status, 'failed')
    assert.equal((await runs.get(scheduled.id))?.exitCode, 3)
    assert.equal((await new ControlStore(next, 1000).executionSession(execution)).hasStarted, true)
    assert.deepEqual(await files(), [], 'the adopted watcher consumed the results')
  } finally { await after.stop() }
})

test('adoption fails closed for invalid, lost or corrupt handoff records and never launches', async t => {
  const { root, dir, host, files } = await fixture(t)
  const control = new ControlStore(dir, 1000)
  await control.requestPairing(101, 101); await control.approveOwner(101)
  const owner = (await control.status()).owner!
  const lost = { version: 1, id: 'r_schedule_lost', chatId: 101, telegramUserId: 101, texts: ['work'], status: 'running', createdAt: new Date().toISOString(),
    scheduled: { id: 'gone', revision: 'v1', dueAt: new Date().toISOString(), pairedAt: owner.pairedAt } }
  await writeFile(join(dir, 'run-handoff.json'), JSON.stringify({ version: 1, runs: [lost, { ...lost, id: '../escape' }, { ...lost, id: 'r_done', status: 'completed' }] }))
  let launches = 0
  const relay = createRelay(config(dir, root), async () => { launches++; throw new Error('Must not launch') }), runs = new RunStore(dir)
  try {
    await relay.adoptHandoff()
    await until(async () => (await runs.get(lost.id))?.status === 'failed')
    assert.match((await runs.get(lost.id))?.failure?.error ?? '', /outcome is unknown/)
    assert.deepEqual((await runs.list()).map(run => run.id), [lost.id])
    await writeFile(join(dir, 'run-handoff.json'), '{not json')
    await relay.adoptHandoff()
    await assert.rejects(readFile(join(dir, 'run-handoff.json')), { code: 'ENOENT' })
    await relay.drainSources()
    assert.equal(launches, 0)
    assert.deepEqual(await files(), [])
  } finally { await relay.stop() }
})
