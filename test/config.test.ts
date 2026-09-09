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
