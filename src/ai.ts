import { assertEffort, allowedEffort } from './model-policy.js'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { executorEnvironment, executorKey, resolveExecutor } from './executor.js'
import { desktopCodexPath } from './desktop-bridge.js'

export type AiPreset = { id: string; name: string; cli: string; provider?: string; model?: string; effort?: string }
export type ExecutionChoice = { sessionId: string; preset: AiPreset }
export type ModelChoice = { cli: string; provider?: string; model?: string; name: string; efforts: string[] }
const safe = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(s)
const knownClis = ['grok', 'codex', 'codex-gui', 'claude', 'opencode', 'agy', 'unreal-agent', 'pi']
const nativeEffort = (cli: string, effort: string) =>
  cli === 'unreal-agent' ? ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) :
  cli === 'pi' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) : true
export const isPreset = (p: unknown): p is AiPreset => {
  if (!p || typeof p !== 'object') return false
  const v = p as AiPreset
  return safe(v.id) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 80 &&
    knownClis.includes(v.cli) &&
    (v.provider === undefined || safe(v.provider)) && (v.model === undefined || safe(v.model)) && (v.effort === undefined || safe(v.effort))
}
export const isExecutionChoice = (v: unknown): v is ExecutionChoice => {
  const c = v as ExecutionChoice | undefined
  return Boolean(c && /^[0-9a-f-]{36}$/i.test(c.sessionId) && isPreset(c.preset))
}
export const presetLabel = (p: AiPreset) => `${p.cli}${p.provider ? ` (${p.provider})` : ''} · ${p.model || 'client default'} · ${p.effort || 'default effort'}`
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
  // Registry key and binary differ: `unreal-agent` runs via `unreal-agent-runner`.
  const command = cli === 'unreal-agent' ? 'unreal-agent-runner' : cli
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    try { await access(join(directory, command), constants.X_OK); return true } catch {}
  }
  return false
}

// Read only metadata from native client catalogs. Never import prompts, credentials,
// provider configuration, or model instructions into relay context.
// The optional runner injects `opencode models` output in tests; production
// spawns the installed CLI with the whitelisted executor environment.
export const readOpencodeModels = async (run?: (args: string[]) => Promise<string>, dataHome?: string): Promise<ModelChoice[]> => {
  const exec = run ?? (async (args: string[]) =>
    (await promisify(execFile)('opencode', args, { env: { ...executorEnvironment(), ...(dataHome ? { XDG_DATA_HOME: dataHome } : {}) }, timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout)
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

export const readModels = async (home = homedir(), available = installed, codexHome = join(home, '.codex'), opencodeRunner?: (args: string[]) => Promise<string>, opencodeDataHome?: string, opencodeAllowlist?: string[], curationDir?: string): Promise<ModelChoice[]> => {
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
    const cache = await json(join(codexHome, 'models_cache.json'))
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
  // Other adapters expose the authenticated client's default, not a guessed catalog.
  for (const cli of ['claude', 'agy'])
    if (await available(cli)) models.push({ cli, name: `${cli} · client default`, efforts: [] })
  const allow = opencodeAllowlist ?? opencodeProviderAllowlist()
  if (await available('opencode')) models.push(...await opencodeCatalogModels(opencodeRunner, opencodeDataHome, allow))
  // These clients have separate provider configuration. OpenCode's catalog
  // cannot establish which models either client can execute.
  for (const cli of ['unreal-agent', 'pi'])
    if (!allow && await available(cli)) models.push({ cli, name: `${cli === 'pi' ? 'Pi' : 'Unreal Agent'} · client default`, efforts: [] })
  const curated = await readCuratedModels(curationDir)
  if (!curated.length) return models
  const scoped: ModelChoice[] = []
  for (const entry of curated) {
    if (!(await available(entry.cli))) continue
    if (['opencode', 'unreal-agent', 'pi'].includes(entry.cli) && allow &&
        (entry.model === undefined || !allow.includes(entry.model.split('/')[0]))) continue
    scoped.push(entry)
  }
  const key = (m: { cli: string; provider?: string; model?: string }) => `${m.cli}‖${m.provider ?? ''}‖${m.model ?? ''}`
  const curatedKeys = new Set(scoped.map(key))
  return [...scoped, ...models.filter((m) => !curatedKeys.has(key(m)))]
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
  if (!isPreset(p) || !(await available(p.cli))) throw new Error('This CLI is not installed.')
  if (!p.provider && !p.model && !p.effort && p.cli !== 'agy') return
  const model = catalog.find((m) => m.cli === p.cli && m.provider === p.provider && m.model === p.model)
  if (!model || (p.effort && !model.efforts.includes(p.effort)))
    throw new Error('This model/effort is not in the installed client catalog. Refresh the client and try again; no fallback was selected.')
}
