import { presetLabel, presetProvider, type AiPreset, type ExecutionChoice } from './ai.js'

// Ordered task setups for one scheduled occurrence. Core advances only on typed
// evidence: a missing CLI or a provider rejection before any model output or
// tool item, or a usage limit the run ended on after work began (continued in a
// fresh session that is told so). Anything else stops the chain.
export type StartupCategory = 'cli-unavailable' | 'login-unavailable' | 'quota' | 'provider-rejected' | 'access-denied'
export type StartupRejection = { category: StartupCategory; resetAt?: string }
export type AttemptCategory = StartupCategory | 'quota-after-work-began' | 'after-work-began' | 'uncertain' | 'same-quota-scope' | 'same-login-scope'
export type SetupAttempt = {
  preset: AiPreset
  quotaScope: string
  outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  category?: AttemptCategory
  resetAt?: string
  exitCode?: number | null
  sessionId?: string
  startedAt?: string
  endedAt?: string
}

const categories: StartupCategory[] = ['cli-unavailable', 'login-unavailable', 'quota', 'provider-rejected', 'access-denied']

// A failed attempt's category and reset time, and whether the occurrence
// continues on the next setup. Once work began only a quota limit the run ended
// on continues; access denial, other failures and unknown outcomes stop.
export const attemptFailure = ({ workBegan, rejection }: { workBegan: boolean; rejection?: StartupRejection }): { category: AttemptCategory; resetAt?: string; continues: boolean } => {
  const resetAt = rejection?.resetAt ? { resetAt: rejection.resetAt } : {}
  if (!workBegan) return rejection ? { category: rejection.category, ...resetAt, continues: rejection.category !== 'access-denied' } : { category: 'uncertain', continues: false }
  return rejection?.category === 'quota' ? { category: 'quota-after-work-began', ...resetAt, continues: true } : { category: 'after-work-began', continues: false }
}

// Transport fact for a setup that continues an occurrence after an earlier setup
// stopped at its usage limit once work had begun. Facts only, no guidance.
export const continuationLine = (runId: string, attempts: SetupAttempt[]): string | undefined => {
  const limited = attempts.filter(a => a.category === 'quota-after-work-began')
  return limited.length ? `[run ${runId} continues: ${limited.map(a => `${presetLabel(a.preset)} began work in native session ${a.sessionId} and stopped at its usage limit${a.resetAt ? ` (resets ${a.resetAt})` : ''}`).join('; ')}. That work may be partly applied.]` : undefined
}

export const setupCandidates = (execution: ExecutionChoice): AiPreset[] => [execution.preset, ...(execution.fallbacks ?? [])]

// The owner provisions native profiles for separate provider accounts. Models
// in one login share its quota scope; another named login may be tried once.
// OpenCode/Pi still share their upstream provider scope.
export const quotaScope = (preset: AiPreset): string => {
  if (['opencode', 'pi'].includes(preset.cli)) {
    const provider = preset.cli === 'pi' ? preset.model?.split('/')[0] : presetProvider(preset)
    return provider ? `provider:${provider}` : preset.cli
  }
  const cli = preset.cli === 'codex-gui' ? 'codex' : preset.cli
  return preset.authProfile ? `${cli}@${preset.authProfile}` : cli
}

// The next untried setup, skipping a login that already rejected authentication
// or reached its quota in this occurrence. Each candidate is tried at most once.
export const nextSetup = (candidates: AiPreset[], attempts: SetupAttempt[]): { skipped: SetupAttempt[]; preset?: AiPreset } => {
  const exhausted = new Map(attempts.filter(a => ['quota', 'quota-after-work-began', 'login-unavailable'].includes(a.category!))
    .map(a => [a.quotaScope, a.category === 'login-unavailable' ? 'same-login-scope' as const : 'same-quota-scope' as const]))
  const skipped: SetupAttempt[] = []
  for (const preset of candidates.slice(attempts.length)) {
    const scope = quotaScope(preset)
    if (!exhausted.has(scope)) return { skipped, preset }
    const at = new Date().toISOString()
    skipped.push({ preset, quotaScope: scope, outcome: 'skipped', category: exhausted.get(scope), startedAt: at, endedAt: at })
  }
  return { skipped }
}

export class SetupsUnavailableError extends Error {}

export const unavailableSummary = (attempts: SetupAttempt[]): string =>
  `Every task setup was unavailable: ${attempts.map(a => `${presetLabel(a.preset)} (${a.category}${a.resetAt ? `, resets ${a.resetAt}` : ''})`).join('; ')}`

const epochSeconds = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined

const claudeErrors: Record<string, StartupCategory> = {
  rate_limit: 'quota', billing_error: 'quota',
  authentication_failed: 'login-unavailable', oauth_org_not_allowed: 'access-denied', account_on_hold: 'access-denied',
  verification_required: 'access-denied', cloud_credential_error: 'access-denied',
  overloaded: 'provider-rejected', server_error: 'provider-rejected', model_not_found: 'provider-rejected', invalid_request: 'provider-rejected',
}

const httpRejection = (status: unknown): StartupCategory | undefined =>
  typeof status !== 'number' ? undefined : status === 401 ? 'login-unavailable' : status === 429 ? 'quota' :
    status === 403 ? 'access-denied' : [400, 404].includes(status) || status >= 500 ? 'provider-rejected' : undefined

// Codex app-server `codexErrorInfo` of a failed turn.
export const codexRejection = (info: unknown): StartupCategory | undefined => {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') return 'quota'
  if (info === 'unauthorized') return 'login-unavailable'
  if (['serverOverloaded', 'internalServerError', 'badRequest', 'flexUnavailable'].includes(info as string)) return 'provider-rejected'
  if (!info || typeof info !== 'object') return undefined
  const status = (Object.values(info)[0] as { httpStatusCode?: unknown } | undefined)?.httpStatusCode
  return httpRejection(status)
}

// The latest reset among exhausted Codex rate-limit windows.
export const codexResetAt = (limits: any): string | undefined => {
  const resets = [limits?.primary, limits?.secondary].filter(w => w && w.usedPercent >= 100 && typeof w.resetsAt === 'number').map(w => w.resetsAt as number)
  return resets.length ? epochSeconds(Math.max(...resets)) : undefined
}

export const startupLine = (state: { workBegan: boolean; rejection?: StartupRejection }): string =>
  JSON.stringify({ type: 'ez.startup', workBegan: state.workBegan, ...(state.rejection ? { rejection: state.rejection } : {}) })

// Reads structured stdout only: Ez transport summaries (`ez.startup`) and
// Claude stream-json envelopes. Model text is never inspected. Any event that
// is not known pre-work metadata counts as work, so ambiguity never advances.
// The rejection is the one the run ended on: later work supersedes it, except
// an access denial, which always stops the chain.
export const startupObserver = () => {
  let buffer = '', workBegan = false, rejection: StartupRejection | undefined
  const reject = (value: StartupRejection) => { if (rejection?.category !== 'access-denied') rejection = value }
  const work = () => { workBegan = true; if (rejection?.category !== 'access-denied') rejection = undefined }
  const line = (text: string) => {
    if (!text.trim()) return
    let event: any
    try { event = JSON.parse(text) } catch { work(); return }
    // A summary is the sender's current state; one without a rejection means
    // work superseded an earlier one.
    if (event?.type === 'ez.startup') {
      if (event.workBegan === true) workBegan = true
      const r = event.rejection, reset = typeof r?.resetAt === 'string' ? Date.parse(r.resetAt) : NaN
      // Re-render the reset time: it reaches a continuation prompt, and
      // Date.parse also accepts arbitrary words around a date.
      if (r && categories.includes(r.category) && (r.resetAt === undefined || Number.isFinite(reset)))
        reject({ category: r.category, ...(r.resetAt === undefined ? {} : { resetAt: new Date(reset).toISOString() }) })
      else if (rejection?.category !== 'access-denied') rejection = undefined
      return
    }
    if (event?.type === 'thread.started' || event?.type === 'result' ||
        (event?.type === 'system' && event.subtype === 'init')) return
    if (event?.type === 'rate_limit_event') {
      const info = event.rate_limit_info
      if (info?.status === 'rejected') reject({ category: 'quota', ...(epochSeconds(info.resetsAt) ? { resetAt: epochSeconds(info.resetsAt) } : {}) })
      return
    }
    // Native API retry/error metadata is not model output. Do not inspect error
    // prose; only typed HTTP status can establish a rejected startup.
    if (event?.type === 'system' && ['api_error', 'api_retry'].includes(event.subtype)) {
      const category = httpRejection(event.subtype === 'api_retry' ? event.error_status : event.error?.status)
      if (category) { reject({ category }); return }
    }
    const category = event?.type === 'assistant' && typeof event.error === 'string' ? claudeErrors[event.error] : undefined
    if (category) reject({ category, ...(category === 'quota' && rejection?.resetAt ? { resetAt: rejection.resetAt } : {}) })
    else work()
  }
  return {
    write: (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const text of lines) line(text)
    },
    result: () => { line(buffer); buffer = ''; return { workBegan, rejection } },
    summary: () => startupLine({ workBegan, rejection }),
  }
}
