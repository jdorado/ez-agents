import path from 'node:path'
import { homedir } from 'node:os'

export type ControlConfig = {
  controlDir: string
  pairingTtlMs: number
}

export type Config = ControlConfig & {
  telegramBotToken: string
  workspace: string
  executorTimeoutMs: number
  codexAutoCompactTokens?: number
  executorCli: string
  channelBackendUrl?: string
  channelBackendToken?: string
  geminiApiKey?: string
  openaiApiKey?: string
  pagerDutyRoutingKey?: string
  pagerDutyStocksHealthUrl?: string
  pagerDutyPollMs?: number
  pagerDutyFailureThreshold?: number
}

const positiveInteger = (value: string | undefined, name: string, fallback: number): number => {
  if (!value) return fallback
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
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim()
  if (!telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required')

  if (env.EZ_CHANNEL_BACKEND_URL && !env.EZ_CHANNEL_BACKEND_TOKEN?.trim()) throw new Error('EZ_CHANNEL_BACKEND_TOKEN is required')
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
    telegramBotToken,
    workspace: path.resolve(env.EZ_AGENT_WORKSPACE?.trim() || './agent'),
    executorTimeoutMs: 0,
    codexAutoCompactTokens: positiveInteger(env.EZ_CODEX_AUTO_COMPACT_TOKENS, 'EZ_CODEX_AUTO_COMPACT_TOKENS', 64000),
    executorCli: env.EZ_EXECUTOR_CLI?.trim() || 'agy',
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
