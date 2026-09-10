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
