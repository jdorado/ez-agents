import { repairEnabled } from './repair-policy.js'
import path from 'node:path'
import { homedir } from 'node:os'

export type ControlConfig = {
  controlDir: string
  pairingTtlMs: number
}

export type Config = ControlConfig & {
  repairEnabled?: boolean
  telegramEnabled?: boolean
  telegramBotToken: string
  workspace: string
  executorTimeoutMs: number
  codexSandbox?: 'external'
  codexAutoCompactTokens?: number
  executorCli: string
  channelBackendUrl?: string
  channelBackendToken?: string
  applicationPort?: number
  applicationHost?: string
  geminiApiKey?: string
  openaiApiKey?: string
  pagerDutyRoutingKey?: string
  pagerDutyStocksHealthUrl?: string
  pagerDutyPollMs?: number
  pagerDutyFailureThreshold?: number
}

const positiveInteger = (value: string | undefined, name: string, fallback?: number): number => {
  if (!value && fallback !== undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export const loadControlConfig = (env: NodeJS.ProcessEnv = process.env): ControlConfig => {
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(homedir(), '.local', 'state')
  return {
    controlDir: path.resolve(env.EZ_CONTROL_DIR?.trim() || path.join(stateHome, 'ezenciel-agents')),
    pairingTtlMs: positiveInteger(env.EZ_PAIRING_TTL_SECONDS, 'EZ_PAIRING_TTL_SECONDS', 900) * 1_000,
  }
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  if (env.EZ_TELEGRAM_ENABLED !== undefined && !['true', 'false'].includes(env.EZ_TELEGRAM_ENABLED)) throw new Error('EZ_TELEGRAM_ENABLED must be true or false')
  const telegramEnabled = env.EZ_TELEGRAM_ENABLED !== 'false'
  const telegramBotToken = telegramEnabled ? env.TELEGRAM_BOT_TOKEN?.trim() || '' : ''
  if (!telegramEnabled && !env.EZ_APPLICATION_PORT) throw new Error('Application-only execution requires EZ_APPLICATION_PORT')
  if (telegramEnabled && !telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required')

  if (env.EZ_CHANNEL_BACKEND_URL && !env.EZ_CHANNEL_BACKEND_TOKEN?.trim()) throw new Error('EZ_CHANNEL_BACKEND_TOKEN is required')
  if (env.EZ_APPLICATION_PORT && env.EZ_CHANNEL_BACKEND_URL) throw new Error('Application input requires the native Ez executor, not a channel backend')
  const codexSandbox = env.EZ_CODEX_SANDBOX?.trim()
  if (codexSandbox && codexSandbox !== 'external') throw new Error('EZ_CODEX_SANDBOX must be external or unset')
  if (codexSandbox && (telegramEnabled || env.EZ_EXECUTOR_TRANSPORT !== 'local')) throw new Error('External Codex sandbox requires application-only local execution')
  const pagerDutyRoutingKey = env.PAGERDUTY_ROUTING_KEY?.trim()
  const pagerDutyStocksHealthUrl = env.EZ_PAGERDUTY_STOCKS_HEALTH_URL?.trim()
  if (pagerDutyStocksHealthUrl && !pagerDutyRoutingKey)
    throw new Error('PAGERDUTY_ROUTING_KEY is required when EZ_PAGERDUTY_STOCKS_HEALTH_URL is set')
  if (pagerDutyStocksHealthUrl) {
    let url: URL
    try { url = new URL(pagerDutyStocksHealthUrl) }
    catch { throw new Error('EZ_PAGERDUTY_STOCKS_HEALTH_URL must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('EZ_PAGERDUTY_STOCKS_HEALTH_URL must be an absolute HTTP(S) URL without credentials or a fragment')
  }
  return {
    ...loadControlConfig(env),
    telegramEnabled,
    telegramBotToken,
    repairEnabled: repairEnabled(env.EZ_REPAIR_ENABLED),
    workspace: path.resolve(env.EZ_AGENT_WORKSPACE?.trim() || './agent'),
    executorTimeoutMs: 0,
    codexSandbox: codexSandbox === 'external' ? 'external' : undefined,
    codexAutoCompactTokens: !env.EZ_CODEX_AUTO_COMPACT_TOKENS?.trim() ? undefined : positiveInteger(env.EZ_CODEX_AUTO_COMPACT_TOKENS, 'EZ_CODEX_AUTO_COMPACT_TOKENS'),
    executorCli: env.EZ_EXECUTOR_CLI?.trim() || 'agy',
    applicationPort: env.EZ_APPLICATION_PORT ? positiveInteger(env.EZ_APPLICATION_PORT, 'EZ_APPLICATION_PORT') : undefined,
    applicationHost: env.EZ_APPLICATION_HOST?.trim() || '127.0.0.1',
    channelBackendUrl: env.EZ_CHANNEL_BACKEND_URL?.trim(),
    channelBackendToken: env.EZ_CHANNEL_BACKEND_TOKEN?.trim(),
    geminiApiKey: env.GEMINI_API_KEY?.trim(),
    openaiApiKey: env.OPENAI_API_KEY?.trim(),
    pagerDutyRoutingKey,
    pagerDutyStocksHealthUrl,
    pagerDutyPollMs: pagerDutyRoutingKey && pagerDutyStocksHealthUrl
      ? positiveInteger(env.EZ_PAGERDUTY_POLL_SECONDS, 'EZ_PAGERDUTY_POLL_SECONDS', 30) * 1_000
      : undefined,
    pagerDutyFailureThreshold: pagerDutyRoutingKey && pagerDutyStocksHealthUrl
      ? positiveInteger(env.EZ_PAGERDUTY_FAILURE_THRESHOLD, 'EZ_PAGERDUTY_FAILURE_THRESHOLD', 3)
      : undefined,
  }
}
