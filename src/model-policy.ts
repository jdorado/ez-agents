export const CODEX_CHAT_MODEL = 'gpt-5.6-sol'
export const CHAT_EFFORT = 'medium'
export const CODEX_DEFAULT_MODEL = 'gpt-5.6-terra'
export const DEFAULT_EFFORT = 'high'
export const allowedEffort = (effort?: string, model?: string, cli?: string) => effort === undefined ||
  ['none', 'minimal', 'low', 'medium', 'high'].includes(effort) ||
  (effort === 'xhigh' && model === 'gpt-5.6-luna' && ['codex', 'codex-gui'].includes(cli || ''))
export function assertEffort(effort?: string, model?: string, cli?: string) {
  if (!allowedEffort(effort, model, cli)) throw new Error('Reasoning effort is capped at high, except Codex Luna/xhigh; choose none, minimal, low, medium, high, or xhigh with gpt-5.6-luna.')
}
export function executionDefaults<T extends { model?: string; effort?: string }>(cli: string, options: T): T {
  assertEffort(options.effort, options.model, cli)
  return { ...options,
    ...(['codex', 'codex-gui'].includes(cli) ? { model: options.model || CODEX_DEFAULT_MODEL } : {}),
    ...(['codex', 'codex-gui'].includes(cli)
      ? { effort: options.effort || DEFAULT_EFFORT } : {}),
  }
}
