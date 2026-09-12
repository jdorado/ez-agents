// Validate option syntax; the installed engine owns supported models and effort levels.
export const allowedEffort = (effort?: string, _model?: string, _cli?: string) => effort === undefined || /^[a-z][a-z0-9_-]{0,31}$/.test(effort)
export function assertEffort(effort?: string, model?: string, cli?: string) {
  if (!allowedEffort(effort,model,cli)) throw new Error('Invalid reasoning effort')
}
export function executionDefaults<T extends { model?: string; effort?: string }>(cli: string, options: T): T {
  assertEffort(options.effort,options.model,cli)
  return options
}

export function executionOverrides<T extends { model?: string; effort?: string }>(
  cli: string,
  base: T,
  model?: string,
  effort?: string,
): T {
  const options = {
    ...base,
    ...(model !== undefined ? { model, ...(effort === undefined ? { effort: undefined } : {}) } : {}),
    ...(effort !== undefined ? { effort } : {}),
  } as T
  return executionDefaults(cli, options)
}
