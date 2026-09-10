import assert from 'node:assert/strict'
import test from 'node:test'
import { PagerDutyStocksMonitor } from '../src/pagerduty.js'

test('sustained critical Stocks health triggers one incident and recovery resolves it', async () => {
  let healthy = false
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const monitor = new PagerDutyStocksMonitor({
    routingKey: 'pagerduty-key',
    healthUrl: 'http://stocks.test/health/critical',
    pollMs: 30_000,
    failureThreshold: 2,
    fetcher: async (url, options) => {
      const target = String(url)
      requests.push({
        url: target,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      })
      if (target === 'http://stocks.test/health/critical')
        return new Response(JSON.stringify({ status: healthy ? 'ok' : 'critical' }), { status: 200 })
      return new Response('{}', { status: 202 })
    },
  })

  await monitor.check()
  assert.equal(requests.filter(({ url }) => url.includes('pagerduty.com')).length, 0)
  await monitor.check()
  const trigger = requests.find(({ url }) => url.includes('pagerduty.com'))!.body!
  assert.equal(trigger.event_action, 'trigger')
  assert.equal(trigger.dedup_key, 'ez:stocks:critical-health')
  assert.equal(trigger.routing_key, 'pagerduty-key')

  healthy = true
  await monitor.check()
  const pagerDutyEvents = requests.filter(({ url }) => url.includes('pagerduty.com'))
  assert.equal(pagerDutyEvents.length, 2)
  assert.equal(pagerDutyEvents[1].body!.event_action, 'resolve')
})

test('a failed PagerDuty delivery remains eligible for a later trigger', async () => {
  let pagerDutyCalls = 0
  const monitor = new PagerDutyStocksMonitor({
    routingKey: 'pagerduty-key',
    healthUrl: 'http://stocks.test/health/critical',
    pollMs: 30_000,
    failureThreshold: 1,
    onError: () => {},
    fetcher: async (url) => {
      if (String(url).includes('pagerduty.com')) {
        pagerDutyCalls += 1
        return new Response('{}', { status: 500 })
      }
      return new Response(JSON.stringify({ status: 'critical' }), { status: 200 })
    },
  })

  await monitor.check()
  await monitor.check()
  assert.equal(pagerDutyCalls, 2)
})

for (const uncertainTrigger of [false, true]) {
  test(`recovery after restart resolves ${uncertainTrigger ? 'uncertain' : 'accepted'} trigger`, async () => {
    let healthy = false
    const actions: string[] = []
    const options = {
      routingKey: 'fixture', healthUrl: 'http://stocks.test/health/critical',
      pollMs: 30000, failureThreshold: 1,
      fetcher: async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).includes('pagerduty.com'))
          return new Response(JSON.stringify({status: healthy ? 'ok' : 'critical'}))
        const action = JSON.parse(String(init?.body)).event_action
        actions.push(action)
        if (action === 'trigger' && uncertainTrigger) throw new Error('connection lost after acceptance')
        return new Response('{}', {status: 202})
      },
    }
    const first = new PagerDutyStocksMonitor(options)
    await first.check()
    first.stop()
    healthy = true
    const restarted = new PagerDutyStocksMonitor(options)
    await restarted.check()
    await restarted.check()
    assert.deepEqual(actions, ['trigger', 'resolve'])
  })
}

test('failed recovery delivery retries without generating a false outage', async () => {
  const actions: string[] = []
  const monitor = new PagerDutyStocksMonitor({
    routingKey: 'fixture', healthUrl: 'http://stocks.test/health/critical',
    pollMs: 30000, failureThreshold: 1,
    fetcher: async (url, init) => {
      if (!String(url).includes('pagerduty.com')) return new Response('{"status":"ok"}')
      actions.push(JSON.parse(String(init?.body)).event_action)
      return new Response('{}', {status: actions.length === 1 ? 500 : 202})
    },
  })
  await monitor.check()
  await monitor.check()
  await monitor.check()
  assert.deepEqual(actions, ['resolve', 'resolve'])
})
