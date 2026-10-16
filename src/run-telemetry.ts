// Opt-in per-attempt run telemetry read from structured native client events:
// reported model, token counts, tool counts/durations and error categories.
// Only counts, tool names and category codes are kept. Prompts, model text,
// tool arguments/results, credentials and reasoning are never read into it,
// and no cost is derived. Missing or partial coverage is labelled, not guessed.
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type ToolStats = { calls: number; completed: number; errors: number; durationMs: number }
export type AttemptTelemetry = {
  coverage: 'complete' | 'partial' | 'none'
  gaps?: string[]
  model?: string
  // native-total: the client's own cumulative total for this invocation;
  // message-sum: deduplicated per-message usage when no total was reported.
  tokens?: TokenCounts & { source: 'native-total' | 'message-sum' }
  // Durations are observed stream intervals between a tool's start and result.
  tools?: ToolStats & { byName: Record<string, ToolStats> }
  errors?: string[]
}

const MAX_NAMES = 32
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
const code = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,80}$/.test(value) ? value : undefined
const toolName = (value: unknown): string => code(value) ?? 'unnamed'
const isCounts = (v: any): boolean => v && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isSafeInteger(v[key]) && v[key] >= 0)
const isStats = (v: any): boolean => v && ['calls', 'completed', 'errors', 'durationMs'].every(key => Number.isSafeInteger(v[key]) && v[key] >= 0)

// Revalidates a forwarded summary; anything outside the closed shape is dropped.
export const validTelemetry = (value: unknown): AttemptTelemetry | undefined => {
  const v = value as AttemptTelemetry
  if (!v || typeof v !== 'object' || !['complete', 'partial', 'none'].includes(v.coverage)) return undefined
  if (v.gaps !== undefined && !(Array.isArray(v.gaps) && v.gaps.length <= 16 && v.gaps.every(g => code(g)))) return undefined
  if (v.errors !== undefined && !(Array.isArray(v.errors) && v.errors.length <= 16 && v.errors.every(e => code(e)))) return undefined
  if (v.model !== undefined && !code(v.model)) return undefined
  if (v.tokens !== undefined && !(isCounts(v.tokens) && ['native-total', 'message-sum'].includes(v.tokens.source))) return undefined
  if (v.tools !== undefined && !(isStats(v.tools) && v.tools.byName && typeof v.tools.byName === 'object' &&
    Object.keys(v.tools.byName).length <= MAX_NAMES + 1 && Object.entries(v.tools.byName).every(([name, stats]) => code(name) && isStats(stats)))) return undefined
  // Rebuilt from the known keys: a forwarded summary may carry extra fields beside the counts, and none survive.
  const counts = (c: TokenCounts): TokenCounts => ({ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite })
  const stats = (c: ToolStats): ToolStats => ({ calls: c.calls, completed: c.completed, errors: c.errors, durationMs: c.durationMs })
  const clean: AttemptTelemetry = { coverage: v.coverage }
  if (v.gaps !== undefined) clean.gaps = [...v.gaps]
  if (v.model !== undefined) clean.model = v.model
  if (v.tokens !== undefined) clean.tokens = { ...counts(v.tokens), source: v.tokens.source }
  if (v.tools !== undefined) clean.tools = { ...stats(v.tools), byName: Object.fromEntries(Object.entries(v.tools.byName).map(([name, entry]) => [name, stats(entry)])) }
  if (v.errors !== undefined) clean.errors = [...v.errors]
  return clean
}

export const telemetryLine = (telemetry: AttemptTelemetry): string => JSON.stringify({ type: 'ez.telemetry', telemetry })

// Codex reports input including cached input; Claude reports them separately.
// Both are normalized to uncached input plus cache reads/writes.
const codexCounts = (usage: any): TokenCounts => {
  const cached = count(usage?.cached_input_tokens)
  return { input: Math.max(0, count(usage?.input_tokens) - cached), output: count(usage?.output_tokens), cacheRead: cached, cacheWrite: 0 }
}
const claudeCounts = (usage: any): TokenCounts => ({ input: count(usage?.input_tokens), output: count(usage?.output_tokens),
  cacheRead: count(usage?.cache_read_input_tokens), cacheWrite: count(usage?.cache_creation_input_tokens) })
const codexTools: Record<string, string> = { command_execution: 'command', file_change: 'file_change', web_search: 'web_search', mcp_tool_call: 'mcp' }

// Repeated and cumulative events are deduplicated: Claude repeats one
// message's usage per content block (keyed by message ID), native totals
// replace earlier totals, tools are keyed by their call ID, and a forwarded
// `ez.telemetry` summary from the producing side replaces local observation.
// `cumulativeSession` marks a resumed client whose total may span earlier turns.
export const telemetryObserver = (options: { cumulativeSession?: boolean } = {}, now = () => Date.now()) => {
  let buffer = '', observed = false, model: string | undefined, total: TokenCounts | undefined
  let forwarded: AttemptTelemetry | undefined
  const messages = new Map<string, TokenCounts>()
  const tools = new Map<string, { name: string; startedAt?: number; endedAt?: number; error: boolean }>()
  const errors = new Set<string>()
  const start = (id: unknown, name: string) => {
    const key = code(id)
    if (key && !tools.has(key)) tools.set(key, { name, startedAt: now(), error: false })
  }
  const end = (id: unknown, name: string, error: boolean) => {
    const key = code(id)
    if (!key) return
    const tool = tools.get(key) ?? { name, error: false }
    if (tool.endedAt !== undefined) return
    tools.set(key, { ...tool, endedAt: now(), error })
  }
  const line = (text: string) => {
    if (!text.trim()) return
    let event: any
    try { event = JSON.parse(text) } catch { return }
    if (!event || typeof event !== 'object') return
    if (event.type === 'ez.telemetry') { const summary = validTelemetry(event.telemetry); if (summary) forwarded = summary; return }
    if (event.type === 'ez.startup') return
    observed = true
    // Claude Code stream-json.
    if (event.type === 'system' && event.subtype === 'init') model = code(event.model) ?? model
    else if (event.type === 'system' && ['api_error', 'api_retry'].includes(event.subtype)) errors.add(event.subtype === 'api_retry' ? 'api-retry' : 'api-error')
    else if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') errors.add('quota')
    else if (event.type === 'assistant') {
      const error = code(event.error)
      if (error) errors.add(error)
      const id = code(event.message?.id)
      if (id && event.message?.usage && !event.isApiErrorMessage) messages.set(id, claudeCounts(event.message.usage))
      for (const block of Array.isArray(event.message?.content) ? event.message.content : [])
        if (block?.type === 'tool_use') start(block.id, toolName(block.name))
    } else if (event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : [])
        if (block?.type === 'tool_result') end(block.tool_use_id, tools.get(code(block.tool_use_id) ?? '')?.name ?? 'unnamed', block.is_error === true)
    } else if (event.type === 'result') {
      if (event.usage) total = claudeCounts(event.usage)
      if (event.is_error === true) errors.add(code(event.subtype) ?? 'result-error')
    }
    // Codex exec --json (also the shape codex-session.ts forwards for app-server items).
    else if ((event.type === 'item.started' || event.type === 'item.completed') && codexTools[event.item?.type]) {
      const name = event.item.type === 'mcp_tool_call' ? toolName(`mcp:${event.item.server}/${event.item.tool}`) : codexTools[event.item.type]
      if (event.type === 'item.started') start(event.item.id, name)
      else end(event.item.id, name, event.item.status === 'failed')
    } else if (event.type === 'turn.completed' && event.usage) total = codexCounts(event.usage)
    else if (event.type === 'turn.failed') errors.add('turn-failed')
    else if (event.type === 'error') errors.add('native-error')
  }
  const result = (): AttemptTelemetry => {
    if (forwarded) return forwarded
    const gaps: string[] = []
    let tokens: AttemptTelemetry['tokens']
    if (total) tokens = { ...total, source: 'native-total' }
    else if (messages.size) {
      const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      for (const usage of messages.values()) for (const key of Object.keys(sum) as (keyof TokenCounts)[]) sum[key] += usage[key]
      tokens = { ...sum, source: 'message-sum' }
      gaps.push('tokens-without-native-total')
    } else gaps.push('tokens')
    if (tokens && options.cumulativeSession) gaps.push('tokens-may-include-earlier-session-turns')
    if (!model) gaps.push('reported-model')
    const byName: Record<string, ToolStats> = {}
    const totals: ToolStats = { calls: 0, completed: 0, errors: 0, durationMs: 0 }
    let unmeasured = false
    for (const tool of tools.values()) {
      const name = byName[tool.name] || Object.keys(byName).length < MAX_NAMES ? tool.name : 'other'
      const stats = byName[name] ??= { calls: 0, completed: 0, errors: 0, durationMs: 0 }
      const done = tool.endedAt !== undefined
      const duration = done && tool.startedAt !== undefined ? Math.max(0, tool.endedAt! - tool.startedAt) : 0
      if (done && tool.startedAt === undefined) unmeasured = true
      for (const target of [stats, totals]) {
        target.calls++
        if (done) target.completed++
        if (tool.error) target.errors++
        target.durationMs += duration
      }
    }
    if (totals.completed < totals.calls) gaps.push('tools-incomplete')
    if (unmeasured) gaps.push('tool-durations-partial')
    const telemetry: AttemptTelemetry = {
      coverage: !observed ? 'none' : gaps.length ? 'partial' : 'complete',
      ...(gaps.length ? { gaps } : {}),
      ...(model ? { model } : {}),
      ...(tokens ? { tokens } : {}),
      ...(observed ? { tools: { ...totals, byName } } : {}),
      ...(errors.size ? { errors: [...errors].slice(0, 16) } : {}),
    }
    return telemetry
  }
  return {
    write: (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const text of lines) line(text)
    },
    // A client that reports its model outside the event stream (Codex app-server).
    model: (name: unknown) => { model = code(name) ?? model },
    result: () => { line(buffer); buffer = ''; return result() },
    summary: () => telemetryLine(result()),
  }
}
