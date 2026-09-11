import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkforceWatch, WorkforceWatchServer } from '../src/workforce-watch.js'

const fixture = async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'workforce-watch-'))
  let now = 0
  const notices: string[] = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', now: () => now, notify: async text => { notices.push(text) } })
  return { stateDir, watch, notices, advance: (ms: number) => { now += ms }, close: () => rm(stateDir, { recursive: true, force: true }) }
}

test('worker enrollment, terminal alert context, and sustained recovery preserve only redacted state', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => f.watch.enroll('wrong', { workerId: 'stocks-production', checkInSeconds: 10, graceSeconds: 0 }), /Unauthorized/)
    const enrolled = await f.watch.enroll('fleet-secret', { workerId: 'stocks-production', checkInSeconds: 10, graceSeconds: 0, runbookUrl: 'https://runbooks.example/stocks' })
    await assert.rejects(() => f.watch.checkIn('stocks-production', 'wrong', { status: 'ok' }), /Unauthorized/)
    await f.watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true, activity: 'IBKR session probe', error: 'No broker server time', runId: 'daily-42', logsHint: 'journalctl --user -u ez-stocks.service --since 30m' })
    assert.match(f.notices[0], /IBKR session probe/)
    assert.match(f.notices[0], /No broker server time/)
    const state = await f.watch.inspect('stocks-production') as Record<string, unknown>
    assert.equal('tokenHash' in state, false)
    assert.deepEqual((state.history as Array<Record<string, unknown>>).at(-1)?.runId, 'daily-42')
    await f.watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok', activity: 'retry one' })
    await f.watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok', activity: 'retry two' })
    assert.equal(f.notices.length, 2)
    assert.match(f.notices[1], /recovered/)
  } finally { await f.close() }
})

test('a missed check-in alerts once and requires clean check-ins to recover', async () => {
  const f = await fixture()
  try {
    const enrolled = await f.watch.enroll('fleet-secret', { workerId: 'annie-pa', checkInSeconds: 10, graceSeconds: 2, severity: 'warning' })
    f.advance(12_001)
    await f.watch.evaluate(); await f.watch.evaluate()
    assert.equal(f.notices.length, 1)
    assert.match(f.notices[0], /missed check-in/)
    await f.watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok', activity: 'relay available' })
    assert.equal(f.notices.length, 1)
    await f.watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok', activity: 'relay available' })
    assert.equal(f.notices.length, 2)
  } finally { await f.close() }
})

test('a failed recovery notification stays pending and is retried on evaluation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'workforce-watch-'))
  let now = 0, failRecovery = true
  const notices: string[] = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', now: () => now, notify: async text => {
    if (text.includes('recovered') && failRecovery) throw new Error('Telegram unavailable')
    notices.push(text)
  } })
  try {
    const enrolled = await watch.enroll('fleet-secret', { workerId: 'dusk-dune', checkInSeconds: 10, graceSeconds: 0 })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' })
    await assert.rejects(() => watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' }), /Telegram unavailable/)
    assert.ok((await watch.inspect('dusk-dune') as { incident?: unknown }).incident)
    failRecovery = false; now += 1
    await watch.evaluate()
    assert.equal((await watch.inspect('dusk-dune') as { incident?: unknown }).incident, undefined)
    assert.equal(notices.length, 2)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('an incident whose opening alert never delivered resolves quietly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'workforce-watch-'))
  let rejectAlert = true
  const notices: string[] = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', notify: async text => {
    if (rejectAlert && text.includes('alert')) throw new Error('Telegram unavailable')
    notices.push(text)
  } })
  try {
    const enrolled = await watch.enroll('fleet-secret', { workerId: 'jc-stack', checkInSeconds: 10, graceSeconds: 0 })
    await assert.rejects(() => watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true }), /Telegram unavailable/)
    rejectAlert = false
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' })
    assert.deepEqual(notices, [])
    assert.equal((await watch.inspect('jc-stack') as { incident?: unknown }).incident, undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('an enrollment-authorized token rotation invalidates the prior worker secret', async () => {
  const f = await fixture()
  try {
    const enrolled = await f.watch.enroll('fleet-secret', { workerId: 'aifit', checkInSeconds: 10, graceSeconds: 0 })
    await assert.rejects(() => f.watch.rotate('wrong', 'aifit'), /Unauthorized/)
    const rotated = await f.watch.rotate('fleet-secret', 'aifit')
    await assert.rejects(() => f.watch.checkIn('aifit', enrolled.workerToken, { status: 'ok' }), /Unauthorized/)
    await f.watch.checkIn('aifit', rotated.workerToken, { status: 'ok' })
  } finally { await f.close() }
})

test('HTTP enrollment and check-in endpoints reject secrets not owned by the caller', async () => {
  const f = await fixture(), server = new WorkforceWatchServer(f.watch, 'fleet-secret', () => {})
  try {
    await server.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port()}`
    assert.equal((await fetch(`${base}/v1/workers`)).status, 401)
    const enrollment = await fetch(`${base}/v1/enroll`, { method: 'POST', headers: { authorization: 'Bearer fleet-secret', 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'ez-cto', checkInSeconds: 10, graceSeconds: 0 }) })
    assert.equal(enrollment.status, 201)
    const { workerToken } = await enrollment.json() as { workerToken: string }
    assert.equal((await fetch(`${base}/v1/workers/ez-cto/check-in`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"status":"ok"}' })).status, 401)
    assert.equal((await fetch(`${base}/v1/workers/ez-cto/check-in`, { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: '{"status":"ok","activity":"relay started"}' })).status, 200)
    const rotation = await fetch(`${base}/v1/workers/ez-cto/rotate`, { method: 'POST', headers: { authorization: 'Bearer fleet-secret' } })
    assert.equal(rotation.status, 200)
    const rotated = await rotation.json() as { workerToken: string }
    assert.equal((await fetch(`${base}/v1/workers/ez-cto/check-in`, { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: '{"status":"ok"}' })).status, 401)
    assert.equal((await fetch(`${base}/v1/workers/ez-cto/check-in`, { method: 'POST', headers: { authorization: `Bearer ${rotated.workerToken}`, 'content-type': 'application/json' }, body: '{"status":"ok"}' })).status, 200)
  } finally { await server.close(); await f.close() }
})
