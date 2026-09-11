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

test('PagerDuty uses one worker-specific deduplication key and resolves only a triggered incident', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'workforce-watch-'))
  const pages: Array<{ action: string; dedupKey: string; customDetails: Record<string, string> }> = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', page: async event => { pages.push(event) } })
  try {
    const enrolled = await watch.enroll('fleet-secret', { workerId: 'stocks', checkInSeconds: 10, graceSeconds: 0, severity: 'critical' })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true, activity: 'broker probe', error: 'gateway unavailable', logsHint: 'journalctl -u stocks' })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' })
    await watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' })
    assert.deepEqual(pages.map(page => [page.action, page.dedupKey]), [['trigger', 'ez:workforce:stocks'], ['resolve', 'ez:workforce:stocks']])
    assert.equal(pages[0]?.customDetails.error, 'gateway unavailable')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('PagerDuty trigger is not duplicated when supplemental Telegram delivery fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'workforce-watch-'))
  const pages: string[] = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', page: async event => { pages.push(event.action) }, notify: async () => { throw new Error('Telegram unavailable') } })
  try {
    const enrolled = await watch.enroll('fleet-secret', { workerId: 'aifit', checkInSeconds: 10, graceSeconds: 0 })
    await assert.rejects(() => watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true }), /Telegram unavailable/)
    await assert.rejects(() => watch.evaluate(), /Telegram unavailable/)
    assert.deepEqual(pages, ['trigger'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
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
  const notices: string[] = []
  const watch = new WorkforceWatch({ stateDir, enrollmentToken: 'fleet-secret', notify: async text => {
    if (text.includes('alert')) throw new Error('Telegram unavailable')
    notices.push(text)
  } })
  try {
    const enrolled = await watch.enroll('fleet-secret', { workerId: 'jc-stack', checkInSeconds: 10, graceSeconds: 0 })
    await assert.rejects(() => watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'failed', terminal: true }), /Telegram unavailable/)
    await assert.rejects(() => watch.checkIn(enrolled.workerId, enrolled.workerToken, { status: 'ok' }), /Telegram unavailable/)
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

for (const recoveredChannel of ['pagerduty', 'telegram'] as const) {
  for (const relapse of ['terminal', 'failed', 'missed'] as const) {
    test(`a ${relapse} relapse reopens only the recovered ${recoveredChannel} channel after restart`, async () => {
      const stateDir = await mkdtemp(join(tmpdir(), 'workforce-relapse-'))
      let now = 0, failRecovery = true
      const pages: string[] = [], notices: string[] = []
      const options = { stateDir, enrollmentToken: 'synthetic', now: () => now,
        page: async (event: { action: string }) => {
          if (event.action === 'resolve' && recoveredChannel === 'telegram' && failRecovery) throw new Error('recovery unavailable')
          pages.push(event.action)
        },
        notify: async (message: string) => {
          if (message.includes('recovered') && recoveredChannel === 'pagerduty' && failRecovery) throw new Error('recovery unavailable')
          notices.push(message.includes('recovered') ? 'resolve' : 'trigger')
        } }
      try {
        let watch = new WorkforceWatch(options)
        const worker = await watch.enroll('synthetic', { workerId: 'synthetic-worker', checkInSeconds: 10, graceSeconds: 0 })
        await watch.checkIn(worker.workerId, worker.workerToken, { status: 'failed', terminal: true })
        await watch.checkIn(worker.workerId, worker.workerToken, { status: 'ok' })
        await assert.rejects(() => watch.checkIn(worker.workerId, worker.workerToken, { status: 'ok' }), /recovery unavailable/)
        watch = new WorkforceWatch(options)
        now = relapse === 'missed' ? 10_001 : 1
        if (relapse === 'missed') await watch.evaluate()
        else await watch.checkIn(worker.workerId, worker.workerToken, { status: 'failed', terminal: relapse === 'terminal' })
        assert.deepEqual(pages, recoveredChannel === 'pagerduty' ? ['trigger', 'resolve', 'trigger'] : ['trigger'])
        assert.deepEqual(notices, recoveredChannel === 'telegram' ? ['trigger', 'resolve', 'trigger'] : ['trigger'])
        failRecovery = false
        await watch.checkIn(worker.workerId, worker.workerToken, { status: 'ok' })
        await watch.checkIn(worker.workerId, worker.workerToken, { status: 'ok' })
        assert.equal((await watch.inspect(worker.workerId) as { incident?: unknown }).incident, undefined)
        assert.equal(pages.at(-1), 'resolve')
        assert.equal(notices.at(-1), 'resolve')
      } finally { await rm(stateDir, { recursive: true, force: true }) }
    })
  }
}
