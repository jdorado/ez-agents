import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

test('requires a Telegram token', () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN is required/)
})

test('uses a relative agent workspace and protected control state defaults', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'test-token',
    EZ_AGENT_WORKSPACE: './fixture-agent',
    EZ_CONTROL_DIR: './fixture-control',
  })
  assert.match(config.workspace, /fixture-agent$/)
  assert.match(config.controlDir, /fixture-control$/)
  assert.equal(config.executorTimeoutMs, 0)
  assert.equal(config.pairingTtlMs, 900_000)
})

test('rejects malformed timeouts', () => {
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: 'test', EZ_EXECUTOR_TIMEOUT_SECONDS: '300' }).executorTimeoutMs, 0)
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'test', EZ_PAIRING_TTL_SECONDS: 'bad' }), /positive integer/)
})

test('loads executor CLI configuration with agy fallback', () => {
  const defaultConfig = loadConfig({ TELEGRAM_BOT_TOKEN: 'test' })
  assert.equal(defaultConfig.executorCli, 'agy')

  const customConfig = loadConfig({ TELEGRAM_BOT_TOKEN: 'test', EZ_EXECUTOR_CLI: 'claude' })
  assert.equal(customConfig.executorCli, 'claude')
})

test('Codex context limit is configurable and rejects invalid values', () => {
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'test'}).codexAutoCompactTokens,64000)
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'test',EZ_CODEX_AUTO_COMPACT_TOKENS:'32000'}).codexAutoCompactTokens,32000)
  for(const value of ['0','-1','bad','1.5','9007199254740992'])
    assert.throws(()=>loadConfig({TELEGRAM_BOT_TOKEN:'test',EZ_CODEX_AUTO_COMPACT_TOKENS:value}),/positive integer/)
})

test('PagerDuty Stocks monitoring requires a routing key and validates its target', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: 'test', EZ_PAGERDUTY_STOCKS_HEALTH_URL: 'http://stocks.test/health/critical' }),
    /PAGERDUTY_ROUTING_KEY is required/,
  )
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: 'test', PAGERDUTY_ROUTING_KEY: 'key', EZ_PAGERDUTY_STOCKS_HEALTH_URL: 'file:///private/health' }),
    /absolute HTTP\(S\) URL/,
  )
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'test',
    PAGERDUTY_ROUTING_KEY: 'pagerduty-key',
    EZ_PAGERDUTY_STOCKS_HEALTH_URL: 'http://stocks.test/health/critical',
    EZ_PAGERDUTY_POLL_SECONDS: '45',
    EZ_PAGERDUTY_FAILURE_THRESHOLD: '4',
  })
  assert.equal(config.pagerDutyRoutingKey, 'pagerduty-key')
  assert.equal(config.pagerDutyStocksHealthUrl, 'http://stocks.test/health/critical')
  assert.equal(config.pagerDutyPollMs, 45_000)
  assert.equal(config.pagerDutyFailureThreshold, 4)
})
