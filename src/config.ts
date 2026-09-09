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
  executorCli: string
  geminiApiKey?: string
  openaiApiKey?: string
}

const positiveInteger = (value: string | undefined, name: string, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
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

  return {
    ...loadControlConfig(env),
    telegramBotToken,
    workspace: path.resolve(env.EZ_AGENT_WORKSPACE?.trim() || './agent'),
    executorTimeoutMs: 0,
    executorCli: env.EZ_EXECUTOR_CLI?.trim() || 'agy',
    geminiApiKey: env.GEMINI_API_KEY?.trim(),
    openaiApiKey: env.OPENAI_API_KEY?.trim(),
  }
}
