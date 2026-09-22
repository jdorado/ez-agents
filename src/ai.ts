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
export const isPreset = (p: unknown): p is AiPreset => {
  if (!p || typeof p !== 'object') return false
  const v = p as AiPreset
  return safe(v.id) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 80 &&
    ['grok', 'codex', 'codex-gui', 'claude', 'opencode', 'agy'].includes(v.cli) &&
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
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    try { await access(join(directory, cli), constants.X_OK); return true } catch {}
  }
  return false
}

// Read only metadata from native client catalogs. Never import prompts, credentials,
// provider configuration, or model instructions into relay context.
// The optional runner injects `opencode models` output in tests; production
// spawns the installed CLI with the whitelisted executor environment.
export const readOpencodeModels = async (run?: (args: string[]) => Promise<string>): Promise<ModelChoice[]> => {
  const exec = run ?? (async (args: string[]) =>
    (await promisify(execFile)('opencode', args, { env: executorEnvironment(), timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout)
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

export const readModels = async (home = homedir(), available = installed, codexHome = join(home, '.codex'), opencodeRunner?: (args: string[]) => Promise<string>): Promise<ModelChoice[]> => {
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
  if (await available('opencode')) {
    const discovered = await readOpencodeModels(opencodeRunner)
    models.push(...(discovered.length ? discovered : [{ cli: 'opencode', name: 'opencode · client default', efforts: [] as string[] }]))
  }
  return models
}

export const validateSelection = async (p: AiPreset, catalog: ModelChoice[], available = installed): Promise<void> => {
  assertEffort(p.effort, p.model, p.cli)
  if (!isPreset(p) || !(await available(p.cli))) throw new Error('This CLI is not installed.')
  if (!p.provider && !p.model && !p.effort && p.cli !== 'agy') return
  const model = catalog.find((m) => m.cli === p.cli && m.provider === p.provider && m.model === p.model)
  if (!model || (p.effort && !model.efforts.includes(p.effort)))
    throw new Error('This model/effort is not in the installed client catalog. Refresh the client and try again; no fallback was selected.')
}
