import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

test('requires an application listener when no Telegram bot token is present', () => {
  assert.throws(() => loadConfig({}), /EZ_APPLICATION_PORT/)
})

test('uses a relative agent workspace and protected control state defaults', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',
    EZ_AGENT_WORKSPACE: './fixture-agent',
    EZ_CONTROL_DIR: './fixture-control',
  })
  assert.match(config.workspace, /fixture-agent$/)
  assert.match(config.controlDir, /fixture-control$/)
  assert.equal(config.executorTimeoutMs, 0)
  assert.equal(config.pairingTtlMs, 900_000)
})

test('rejects malformed timeouts', () => {
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', EZ_EXECUTOR_TIMEOUT_SECONDS: '300' }).executorTimeoutMs, 0)
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', EZ_PAIRING_TTL_SECONDS: 'bad' }), /positive integer/)
})

test('loads executor CLI configuration with agy fallback', () => {
  const defaultConfig = loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY' })
  assert.equal(defaultConfig.executorCli, 'agy')

  const customConfig = loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', EZ_EXECUTOR_CLI: 'claude' })
  assert.equal(customConfig.executorCli, 'claude')
})

test('Codex context limit is configurable and rejects invalid values', () => {
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'}).codexAutoCompactTokens,undefined)
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_CODEX_AUTO_COMPACT_TOKENS:'32000'}).codexAutoCompactTokens,32000)
  for(const value of ['0','-1','bad','1.5','9007199254740992'])
    assert.throws(()=>loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_CODEX_AUTO_COMPACT_TOKENS:value}),/positive integer/)
})

test('PagerDuty Stocks monitoring requires a routing key and validates its target', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', EZ_PAGERDUTY_STOCKS_HEALTH_URL: 'http://stocks.test/health/critical' }),
    /PAGERDUTY_ROUTING_KEY is required/,
  )
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', PAGERDUTY_ROUTING_KEY: 'key', EZ_PAGERDUTY_STOCKS_HEALTH_URL: 'file:///private/health' }),
    /absolute HTTP\(S\) URL/,
  )
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',
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

test('external Codex isolation requires explicit native local deployment', () => {
  const env = {EZ_APPLICATION_PORT:'8110', EZ_EXECUTOR_TRANSPORT:'local', EZ_CODEX_SANDBOX:'external'}
  assert.equal(loadConfig(env).codexSandbox, 'external')
  assert.equal(loadConfig({...env,TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'}).codexSandbox, 'external')
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'}).codexSandbox, undefined)
  assert.equal(loadConfig({...env,EZ_EXECUTOR_TRANSPORT:''}).isolation, 'isolated')
  assert.throws(() => loadConfig({...env,EZ_EXECUTOR_TRANSPORT:'host'}), /sandbox|SANDBOX|Isolation/)
  assert.throws(() => loadConfig({...env,EZ_CODEX_SANDBOX:'danger-full-access'}), /sandbox|SANDBOX/)
})

test('isolation class is isolated by default and rejects host transport mismatch', () => {
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'}).isolation, 'isolated')
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'isolated',EZ_EXECUTOR_TRANSPORT:'local'}).isolation, 'isolated')
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_EXECUTOR_TRANSPORT:'host'}).isolation, 'host-capable')
  assert.equal(loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'host-capable',EZ_EXECUTOR_TRANSPORT:'host'}).isolation, 'host-capable')
  assert.throws(() => loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'isolated',EZ_EXECUTOR_TRANSPORT:'host'}), /Isolation isolated requires EZ_EXECUTOR_TRANSPORT=local/)
  assert.throws(() => loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'host-capable',EZ_EXECUTOR_TRANSPORT:'local'}), /Isolation host-capable requires EZ_EXECUTOR_TRANSPORT=host/)
  assert.throws(() => loadConfig({TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'seatbelt'}), /isolated or host-capable/)
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN:'110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY',EZ_ISOLATION:'host-capable',EZ_EXECUTOR_TRANSPORT:'host',
    EZ_CHANNEL_BACKEND_URL:'https://backend.example',EZ_CHANNEL_BACKEND_TOKEN:'secret',
  }), /Host-capable isolation requires the host native CLI/)
})

test('optional web launcher preserves reserved commands and accepts only HTTPS without secrets', () => {
  const config = (value: unknown) => loadConfig({ TELEGRAM_BOT_TOKEN: '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', EZ_TELEGRAM_WEB_APP: JSON.stringify(value) })
  assert.deepEqual(config({command:'voice',label:'Voice',url:'https://voice.example/'}).webLauncher,{command:'voice',label:'Voice',url:'https://voice.example/'})
  for (const value of [{command:'stop',label:'Voice',url:'https://voice.example/'},{command:'voice',label:'Voice',url:'http://voice.example/'},{command:'voice',label:'Voice',url:'https://voice.example/#secret'},{command:'voice',label:'Voice',url:'https://user:pass@voice.example/'},{command:'voice',label:'Voice',url:'https://voice.example/?token=secret'}]) assert.throws(()=>config(value))
})

test('Telegram transport is inferred from a valid token; legacy flag contradictions fail closed', () => {
  const token = '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'
  const enabled = loadConfig({ TELEGRAM_BOT_TOKEN: token, EZ_APPLICATION_PORT: '8110' })
  assert.equal(enabled.telegramEnabled, true)
  assert.equal(enabled.telegramBotToken, token)
  const appOnly = loadConfig({ TELEGRAM_BOT_TOKEN: '   ', EZ_APPLICATION_PORT: '8110' })
  assert.equal(appOnly.telegramEnabled, false)
  assert.equal(appOnly.telegramBotToken, '')
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'garbage', EZ_APPLICATION_PORT: '8110' }), /malformed/)
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: token, EZ_TELEGRAM_ENABLED: 'false', EZ_APPLICATION_PORT: '8110' }), /contradicts/)
  assert.throws(() => loadConfig({ EZ_TELEGRAM_ENABLED: 'true', EZ_APPLICATION_PORT: '8110' }), /contradicts/)
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: token, EZ_TELEGRAM_ENABLED: 'sometimes' }), /must be true or false/)
  assert.equal(loadConfig({ EZ_TELEGRAM_ENABLED: 'false', EZ_APPLICATION_PORT: '8110' }).telegramEnabled, false)
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: token, EZ_TELEGRAM_ENABLED: 'true' }).telegramEnabled, true)
})
