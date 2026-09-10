export const CODEX_DEFAULT_MODEL = 'gpt-5.6-terra'
export const DEFAULT_EFFORT = 'high'
export const allowedEffort = (effort?: string) => effort === undefined ||
  ['none', 'minimal', 'low', 'medium', 'high'].includes(effort)
export function assertEffort(effort?: string) {
  if (!allowedEffort(effort)) throw new Error('Reasoning effort is capped at high; choose none, minimal, low, medium or high.')
}
export function executionDefaults<T extends { model?: string; effort?: string }>(cli: string, options: T): T {
  assertEffort(options.effort)
  return { ...options,
    ...(['codex', 'codex-gui'].includes(cli) ? { model: options.model || CODEX_DEFAULT_MODEL } : {}),
    ...(['codex', 'codex-gui', 'claude', 'grok', 'opencode'].includes(cli)
      ? { effort: options.effort || DEFAULT_EFFORT } : {}),
  }
}
