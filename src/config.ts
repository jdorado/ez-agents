import { parseWebLauncher, type WebLauncher } from './web-launcher.js'
import { repairEnabled } from './repair-policy.js'
import { isolationTransport, resolveIsolation, type IsolationClass } from './isolation.js'
import path from 'node:path'
import { homedir } from 'node:os'

export type ControlConfig = {
  controlDir: string
  pairingTtlMs: number
}

export type Config = ControlConfig & {
  repairEnabled?: boolean
  telegramEnabled?: boolean
  webLauncher?: WebLauncher
  telegramBotToken: string
  workspace: string
  executorTimeoutMs: number
  isolation?: IsolationClass
  codexSandbox?: 'external'
  codexAutoCompactTokens?: number
  executorCli: string
  channelBackendUrl?: string
  channelBackendToken?: string
  applicationPort?: number
  applicationHost?: string
  geminiApiKey?: string
  speechVoiceEn?: string
  speechVoiceEs?: string
  openaiApiKey?: string
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

export const telegramToken = (env: NodeJS.ProcessEnv = process.env): string => {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || ''
  if (token && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN is malformed; refusing to start Telegram transport')
  return token
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const legacy = env.EZ_TELEGRAM_ENABLED
  if (legacy !== undefined && legacy !== 'true' && legacy !== 'false') throw new Error('EZ_TELEGRAM_ENABLED must be true or false')
  const telegramBotToken = telegramToken(env)
  const telegramEnabled = Boolean(telegramBotToken)
  if (legacy !== undefined && (legacy === 'false') === telegramEnabled)
    throw new Error('EZ_TELEGRAM_ENABLED was removed; it contradicts the inferred Telegram transport (a token means enabled). Unset EZ_TELEGRAM_ENABLED, and remove any stale TELEGRAM_BOT_TOKEN to stay application-only.')
  if (!telegramEnabled && !env.EZ_APPLICATION_PORT) throw new Error('Application-only execution requires EZ_APPLICATION_PORT')

  if (env.EZ_CHANNEL_BACKEND_URL && !env.EZ_CHANNEL_BACKEND_TOKEN?.trim()) throw new Error('EZ_CHANNEL_BACKEND_TOKEN is required')
  if (env.EZ_APPLICATION_PORT && env.EZ_CHANNEL_BACKEND_URL) throw new Error('Application input requires the native Ez executor, not a channel backend')
  const isolation = resolveIsolation(env)
  const transport = env.EZ_EXECUTOR_TRANSPORT?.trim() || isolationTransport(isolation)
  const codexSandbox = env.EZ_CODEX_SANDBOX?.trim()
  if (codexSandbox && codexSandbox !== 'external') throw new Error('EZ_CODEX_SANDBOX must be external or unset')
  if (codexSandbox && (env.EZ_CHANNEL_BACKEND_URL || transport !== 'local')) throw new Error('External Codex sandbox requires native local execution')
  return {
    ...loadControlConfig(env),
    telegramEnabled,
    webLauncher: parseWebLauncher(env.EZ_TELEGRAM_WEB_APP),
    telegramBotToken,
    repairEnabled: repairEnabled(env.EZ_REPAIR_ENABLED),
    workspace: path.resolve(env.EZ_AGENT_WORKSPACE?.trim() || './agent'),
    executorTimeoutMs: 0,
    isolation,
    codexSandbox: codexSandbox === 'external' ? 'external' : undefined,
    codexAutoCompactTokens: !env.EZ_CODEX_AUTO_COMPACT_TOKENS?.trim() ? undefined : positiveInteger(env.EZ_CODEX_AUTO_COMPACT_TOKENS, 'EZ_CODEX_AUTO_COMPACT_TOKENS'),
    executorCli: env.EZ_EXECUTOR_CLI?.trim() || 'codex',
    applicationPort: env.EZ_APPLICATION_PORT ? positiveInteger(env.EZ_APPLICATION_PORT, 'EZ_APPLICATION_PORT') : undefined,
    applicationHost: env.EZ_APPLICATION_HOST?.trim() || '127.0.0.1',
    channelBackendUrl: env.EZ_CHANNEL_BACKEND_URL?.trim(),
    channelBackendToken: env.EZ_CHANNEL_BACKEND_TOKEN?.trim(),
    geminiApiKey: env.GEMINI_API_KEY?.trim(),
    speechVoiceEn: env.EZ_SPEECH_VOICE_EN?.trim(),
    speechVoiceEs: env.EZ_SPEECH_VOICE_ES?.trim(),
    openaiApiKey: env.OPENAI_API_KEY?.trim(),
  }
}
