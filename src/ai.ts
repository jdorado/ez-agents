import { assertEffort, allowedEffort } from './model-policy.js'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { CliUnavailableError, executorEnvironment, executorInvocation, executorKey, resolveExecutor } from './executor.js'
import { desktopCodexPath } from './desktop-bridge.js'
import { AUTH_PROFILE_CLIS, claudeAuthEnvironment, cliHome, isAuthProfile, listAuthProfiles } from './auth-profile.js'

export type AiPreset = { id: string; name: string; cli: string; provider?: string; authProfile?: string; model?: string; effort?: string }
// Optional ordered fallbacks are tried only for a scheduled occurrence that never started work.
export type ExecutionChoice = { sessionId: string; preset: AiPreset; fallbacks?: AiPreset[] }
export const MAX_FALLBACKS = 3
export type ModelChoice = { cli: string; provider?: string; authProfile?: string; model?: string; name: string; efforts: string[] }
type Engine = { cli?: string; authProfile?: string }
// A native conversation belongs to one client and one credential home.
export const sameEngine = (a: Engine, b: Engine) => a.cli === b.cli && a.authProfile === b.authProfile
export const sameChoice = (a: Omit<AiPreset, 'id' | 'name'>, b: Omit<AiPreset, 'id' | 'name'>) =>
  sameEngine(a, b) && a.provider === b.provider && a.model === b.model && a.effort === b.effort
const safe = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(s)
const knownClis = ['grok', 'codex', 'codex-gui', 'claude', 'opencode', 'pi']
const nativeEffort = (cli: string, effort: string) =>
  cli === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) : true
export const isPreset = (p: unknown): p is AiPreset => {
  if (!p || typeof p !== 'object') return false
  const v = p as AiPreset
  return safe(v.id) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 80 &&
    knownClis.includes(v.cli) &&
    (v.provider === undefined || safe(v.provider)) && (v.model === undefined || safe(v.model)) && (v.effort === undefined || safe(v.effort)) &&
    (v.authProfile === undefined || (isAuthProfile(v.authProfile) && AUTH_PROFILE_CLIS.includes(v.cli)))
}
export const isExecutionChoice = (v: unknown): v is ExecutionChoice => {
  const c = v as ExecutionChoice | undefined
  return Boolean(c && /^[0-9a-f-]{36}$/i.test(c.sessionId) && isPreset(c.preset) &&
    (c.fallbacks === undefined || (Array.isArray(c.fallbacks) && c.fallbacks.length > 0 && c.fallbacks.length <= MAX_FALLBACKS && c.fallbacks.every(isPreset))))
}
export const presetLabel = (p: AiPreset) => `${p.cli}${p.authProfile ? `@${p.authProfile}` : ''}${p.provider ? ` (${p.provider})` : ''} · ${p.model || 'client default'} · ${p.effort || 'default effort'}`
// OpenCode encodes its provider in the native provider/model identifier.
export const presetProvider = (p: AiPreset) => p.cli === 'opencode' ? p.model?.split('/')[0] : p.provider
// The seed delegates model selection to the native client. Project its resolved
// settings for status without pinning future conversations to that snapshot.
export const statusPreset = (preset: AiPreset, discovered: AiPreset[]): AiPreset =>
  ['codex','codex-gui'].includes(preset.cli) && !preset.provider && !preset.model && !preset.effort
    ? discovered.find((candidate) => candidate.cli === preset.cli) ?? preset
    : preset
export const initialPreset = (cli: string): AiPreset => {
  const key = executorKey(cli)
  return {id:'initial', name:`${resolveExecutor(key).name} · current setup`, cli:key,...(key==='opencode' && process.env.OPENCODE_MODEL ? {model:process.env.OPENCODE_MODEL} : {})}
}
export const persistedPreset = (preset: AiPreset): AiPreset => preset
export const chatPreset = (cli: string): AiPreset => ({...initialPreset(cli),id:'chat-default',name:'Current engine'})

export const installed = async (cli: string): Promise<boolean> => {
  if (cli === 'codex-gui') return Boolean(await desktopCodexPath())
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    try { await access(join(directory, cli), constants.X_OK); return true } catch {}
  }
  return false
}

// Read only metadata from native client catalogs. Never import prompts, credentials,
// provider configuration, or model instructions into relay context.
// The optional runner injects `opencode models` output in tests; production
// spawns the installed CLI with the whitelisted executor environment.
export const readOpencodeModels = async (run?: (args: string[]) => Promise<string>, dataHome?: string): Promise<ModelChoice[]> => {
  const exec = run ?? (async (args: string[]) => {
    const invocation = executorInvocation('opencode', args)
    return (await promisify(execFile)(invocation.command, invocation.args, { env: { ...executorEnvironment(), ...(dataHome ? { XDG_DATA_HOME: dataHome } : {}) }, timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout
  })
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  try {
    const stdout = await exec(['models', '--verbose'])
    // Verbose output alternates a `provider/model` identifier line with its
    // pretty-printed JSON metadata (name, variants). Split on identifier lines
    // so variant keys can be projected as selectable efforts.
    const segments = stdout.split(/^([A-Za-z0-9_.\-]+\/[A-Za-z0-9_./:~\-]+)$/m)
    const entries: ModelChoice[] = []
    for (let index = 1; index + 1 < segments.length; index += 2) {
      const id = segments[index].trim()
      if (!safe(id)) continue
      let meta: Record<string, unknown>
      try { meta = record(JSON.parse(segments[index + 1])) } catch { continue }
      const friendly = typeof meta.name === 'string' ? meta.name.trim() : ''
      const efforts = Object.keys(record(meta.variants))
        .filter((effort) => safe(effort) && allowedEffort(effort, id, 'opencode'))
      entries.push({ cli: 'opencode', model: id,
        name: (friendly ? `${friendly} · ${id}` : id).slice(0, 80), efforts })
    }
    if (entries.length) return entries
  } catch { /* fall through to the plain list, then the client default */ }
  try {
    const stdout = await exec(['models'])
    const entries: ModelChoice[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const id = line.trim()
      if (!id || !safe(id)) continue
      entries.push({ cli: 'opencode', model: id, name: id.slice(0, 80), efforts: [] })
    }
    if (entries.length) return entries
  } catch { /* unavailable metadata stays client default */ }
  return []
}

// User-curated entries live in the agent's own setup (control/ai-models.json),
// never in the repo. They pin models the native catalogs may not currently
// serve (e.g. paid tiers) and merge ahead of discovered entries, so selection
// validation accepts them.
export const readCuratedModels = async (controlDir?: string): Promise<ModelChoice[]> => {
  if (!controlDir) return []
  const curated: ModelChoice[] = []
  const seen = new Set<string>()
  try {
    const raw = JSON.parse(await readFile(join(controlDir, 'ai-models.json'), 'utf8'))
    if (!Array.isArray(raw)) return []
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const entry = candidate as Record<string, unknown>
      if (typeof entry.cli !== 'string' || !knownClis.includes(entry.cli)) continue
      if (entry.provider !== undefined && !safe(entry.provider)) continue
      if (entry.model !== undefined && !safe(entry.model)) continue
      const key = `${entry.cli}‖${entry.provider ?? ''}‖${entry.model ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      curated.push({
        cli: entry.cli,
        ...(entry.provider !== undefined ? { provider: entry.provider as string } : {}),
        ...(entry.model !== undefined ? { model: entry.model as string } : {}),
        name: (typeof entry.name === 'string' && entry.name ? entry.name : String(entry.model ?? entry.cli)).slice(0, 80),
        efforts: (Array.isArray(entry.efforts) ? entry.efforts : [])
          .filter((effort): effort is string => safe(effort))
          .filter((effort) => allowedEffort(effort, typeof entry.model === 'string' ? entry.model : undefined, entry.cli as string) && nativeEffort(entry.cli as string, effort)),
      })
    }
  } catch { return [] }
  return curated
}

// Let the installed native client refresh its own catalog. No conversation or
// prompt is submitted; CODEX_HOME is the same agent binding used for execution.
export const readCodexCatalog = async (codexHome: string, run?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>): Promise<unknown> => {
  const env = { ...executorEnvironment(), CODEX_HOME: codexHome }
  const args = ['debug', 'models']
  try {
    const stdout = run ? await run(args, env) : await (async () => {
      const invocation = executorInvocation('codex', args)
      return (await promisify(execFile)(invocation.command, invocation.args, {
        cwd: codexHome, env, timeout: 8000, maxBuffer: 4 * 1024 * 1024,
      })).stdout
    })()
    const catalog = JSON.parse(stdout)
    if (catalog && Array.isArray(catalog.models) && catalog.models.length) return catalog
  } catch { /* Older/offline native clients retain their last known catalog. */ }
  try { return JSON.parse(await readFile(join(codexHome, 'models_cache.json'), 'utf8')) } catch { return {} }
}

// Claude has no catalog command; its installed help is the native metadata for
// the selectable model aliases and effort levels. No session or inference runs.
// Unparseable or unavailable help keeps the client default, never guessed names.
export const claudeCatalogModels = async (run?: (args: string[]) => Promise<string>): Promise<ModelChoice[]> => {
  const fallback = [{ cli: 'claude', name: 'claude · client default', efforts: [] as string[] }]
  let help: string
  try {
    help = run ? await run(['--help']) : await (async () => {
      const invocation = executorInvocation('claude', ['--help'])
      return (await promisify(execFile)(invocation.command, invocation.args, { env: executorEnvironment(), timeout: 8000, maxBuffer: 1024 * 1024 })).stdout
    })()
  } catch { return fallback }
  const option = (flag: string) => help.split(/\r?\n(?=\s*(?:-\w, )?--)/).find((block) => block.trimStart().replace(/^-\w, /, '').startsWith(`${flag} `))?.replace(/\s+/g, ' ') ?? ''
  const aliases = [...(option('--model').match(/\(e\.g\. ([^)]*)\)/)?.[1] ?? '').matchAll(/'([a-z][a-z0-9-]{0,31})'/g)].map((match) => match[1])
  const levels = (option('--effort').match(/\(([a-z][a-z0-9, -]*)\)\s*$/)?.[1] ?? '').split(',').map((level) => level.trim())
    .filter((level) => safe(level) && allowedEffort(level, undefined, 'claude'))
  if (!aliases.length) return fallback
  return [...fallback, ...[...new Set(aliases)].map((alias) => ({ cli: 'claude', model: alias, name: `claude · ${alias}`, efforts: levels }))]
}

export const readModels = async (home = homedir(), available = installed, codexHome = join(home, '.codex'), opencodeRunner?: (args: string[]) => Promise<string>, opencodeDataHome?: string, opencodeAllowlist?: string[], curationDir?: string, codexRunner?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>, claudeRunner?: (args: string[]) => Promise<string>): Promise<ModelChoice[]> => {
  const models: ModelChoice[] = []
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const efforts = (value: unknown, key: string, model?: string, cli?: string): string[] =>
    (Array.isArray(value) ? value : []).map((e: unknown) => record(e)[key]).filter(safe).filter(effort => allowedEffort(effort, model, cli))
  const json = async (file: string) => {
    try { return record(JSON.parse(await readFile(file, 'utf8'))) } catch { return {} }
  }
  if (await available('grok')) {
    const cache = await json(join(home, '.grok', 'models_cache.json'))
    for (const entry of Object.values(record(cache.models))) {
      const info = record(record(entry).info)
      if (info.hidden || !safe(info.id)) continue
      models.push({ cli: 'grok', model: info.id, name: String(info.name || info.id).slice(0, 80),
        efforts: efforts(info.reasoning_efforts, 'value', info.id, 'grok') })
    }
  }
  if (await available('codex')) {
    const cache = record(await readCodexCatalog(codexHome, codexRunner))
    for (const entry of Array.isArray(cache.models) ? cache.models : []) {
      const info = record(entry)
      if (info.visibility !== 'list' || !safe(info.slug)) continue
      models.push({ cli: 'codex', model: info.slug, name: String(info.display_name || info.slug).slice(0, 80),
        efforts: efforts(info.supported_reasoning_levels, 'effort', info.slug, 'codex') })
    }
  }
  if (await available('codex-gui')) {
    const desktop = models.filter((model) => model.cli === 'codex').map((model) => ({
      ...model, cli: 'codex-gui', name: `codex-gui · ${model.name}`.slice(0, 80),
    }))
    models.push(...(desktop.length ? desktop : [{ cli: 'codex-gui', name: 'codex-gui · desktop', efforts: [] }]))
  }
  if (await available('claude')) models.push(...await claudeCatalogModels(claudeRunner))
  const allow = opencodeAllowlist ?? opencodeProviderAllowlist()
  if (await available('opencode')) models.push(...await opencodeCatalogModels(opencodeRunner, opencodeDataHome, allow))
  // Pi has separate provider configuration. OpenCode's catalog cannot
  // establish which models Pi can execute.
  if (!allow && await available('pi')) models.push({ cli: 'pi', name: 'Pi · client default', efforts: [] })
  const curated = await readCuratedModels(curationDir)
  const profiles = await listAuthProfiles(curationDir)
  // Each provisioned profile offers its client's entries under its own home.
  const withProfiles = (listed: ModelChoice[]) => [...listed, ...profiles.flatMap(({ cli, authProfile }) =>
    listed.filter((model) => model.cli === cli).map((model) => ({ ...model, authProfile, name: `${authProfile} · ${model.name}`.slice(0, 80) })))]
  if (!curated.length) return withProfiles(models)
  const scoped: ModelChoice[] = []
  for (const entry of curated) {
    if (!(await available(entry.cli))) continue
    if (['opencode', 'pi'].includes(entry.cli) && allow &&
        (entry.model === undefined || !allow.includes(entry.model.split('/')[0]))) continue
    scoped.push(entry)
  }
  const key = (m: { cli: string; provider?: string; model?: string }) => `${m.cli}‖${m.provider ?? ''}‖${m.model ?? ''}`
  const curatedKeys = new Set(scoped.map(key))
  return withProfiles([...scoped, ...models.filter((m) => !curatedKeys.has(key(m)))])
}
export const opencodeCatalogModels = async (
  opencodeRunner?: (args: string[]) => Promise<string>,
  opencodeDataHome?: string,
  opencodeAllowlist?: string[],
): Promise<ModelChoice[]> => {
  const discovered = await readOpencodeModels(opencodeRunner, opencodeDataHome)
  const allow = opencodeAllowlist ?? opencodeProviderAllowlist()
  const scoped = allow ? discovered.filter((m) => m.model && allow.includes(m.model.split('/')[0])) : discovered
  if (scoped.length) return scoped
  // A set allowlist that matches nothing offers no choice rather than falling
  // back outside the allowed providers.
  if (allow) return []
  return [{ cli: 'opencode', name: 'opencode · client default', efforts: [] as string[] }]
}

// Optional deployment-scoped restriction of the OpenCode catalog to named
// providers (e.g. EZ_OPENCODE_PROVIDERS=opencode-go). Unset means unfiltered.
// Reads process env directly like OPENCODE_MODEL; malformed values fail fast
// so /ai reports the misconfiguration instead of a silently wrong list.
const providerId = (p: unknown): p is string => typeof p === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(p)
export const validateOpencodeProviders = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > 16 || new Set(value).size !== value.length || value.some((p) => !providerId(p)))
    throw new Error('opencode provider allowlist must be one to sixteen unique provider IDs')
  return value as string[]
}
export const opencodeProviderAllowlist = (env: NodeJS.ProcessEnv = process.env): string[] | undefined => {
  const raw = env.EZ_OPENCODE_PROVIDERS?.trim()
  if (!raw) return undefined
  return validateOpencodeProviders([...new Set(raw.split(',').map((p) => p.trim()).filter(Boolean))])
}

export const validateSelection = async (p: AiPreset, catalog: ModelChoice[], available = installed): Promise<void> => {
  assertEffort(p.effort, p.model, p.cli)
  if (!isPreset(p)) throw new Error('This CLI is not installed.')
  if (!(await available(p.cli))) throw new CliUnavailableError('This CLI is not installed.')
  if (!p.provider && !p.authProfile && !p.model && !p.effort) return
  if (p.authProfile && !p.provider && !p.model && !p.effort) {
    if (!catalog.some((m) => sameEngine(m, p))) throw new Error('This auth profile is not provisioned for the selected CLI.')
    return
  }
  const model = catalog.find((m) => sameEngine(m, p) && m.provider === p.provider && m.model === p.model)
  if (!model || (p.effort && !model.efforts.includes(p.effort)))
    throw new Error('This model/effort is not in the installed client catalog. Refresh the client and try again; no fallback was selected.')
}

export type AuthProfileStatus = { cli: string; authProfile: string | null; provisioned: boolean; sharesHostLogin: boolean
  credentialFiles: string[]; loggedIn: boolean | null; method: string | null }
type StatusRunner = (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>
const nativeStatus: StatusRunner = (command, args, env, cwd) => new Promise((resolve) => {
  const invocation = executorInvocation(command, args)
  execFile(invocation.command, invocation.args, { env, cwd, timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr) }))
})
const credentialNames: Record<string, string[]> = { codex: ['auth.json'], claude: ['oauth-token', '.credentials.json'] }

// Read-only auth diagnostics per credential home. Native status runs with the
// same home and credential environment as execution; only whitelisted fields
// are projected, never tokens, account identifiers or raw native output.
export const authProfileStatus = async (controlDir: string, available = installed, run = nativeStatus,
  isolated = process.env.EZ_ISOLATION === 'isolated'): Promise<AuthProfileStatus[]> => {
  const homes: { cli: string; authProfile?: string }[] = [...AUTH_PROFILE_CLIS.map((cli) => ({ cli })), ...await listAuthProfiles(controlDir)]
  const statuses: AuthProfileStatus[] = []
  for (const { cli, authProfile } of homes) {
    if (!authProfile && !(await available(cli))) continue
    const home = cliHome(controlDir, cli, authProfile)
    const provisioned = await access(home).then(() => true, () => false)
    const credentialFiles: string[] = []
    for (const name of credentialNames[cli]) if (await access(join(home, name)).then(() => true, () => false)) credentialFiles.push(name)
    let loggedIn: boolean | null = null, method: string | null = null
    if (provisioned) {
      try {
        if (cli === 'codex') {
          const result = await run('codex', ['login', 'status'], { ...executorEnvironment(), CODEX_HOME: home }, home)
          loggedIn = result.code === null ? null : result.code === 0
          // Codex prints its login status on stderr.
          const text = result.stdout + result.stderr
          method = loggedIn ? /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'api-key' : 'other' : null
        } else {
          const result = await run('claude', ['auth', 'status', '--json'], { ...executorEnvironment(), ...await claudeAuthEnvironment(home, authProfile, isolated) }, home)
          const status = result.code === null ? undefined : JSON.parse(result.stdout) as { loggedIn?: unknown; authMethod?: unknown }
          loggedIn = status ? status.loggedIn === true : null
          method = loggedIn && safe(status?.authMethod) ? status.authMethod : null
        }
      } catch { loggedIn = false }
    }
    statuses.push({ cli, authProfile: authProfile ?? null, provisioned, sharesHostLogin: !isolated && !authProfile, credentialFiles, loggedIn, method })
  }
  return statuses
}
