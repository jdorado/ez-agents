import { CODEX_DEFAULT_MODEL, DEFAULT_EFFORT, CODEX_CHAT_MODEL, CHAT_EFFORT, assertEffort, allowedEffort } from './model-policy.js'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { executorKey, resolveExecutor } from './executor.js'
import { desktopCodexPath } from './desktop-bridge.js'

export type AiPreset = { id: string; name: string; cli: string; model?: string; effort?: string }
export type ExecutionChoice = { sessionId: string; preset: AiPreset }
export type ModelChoice = { cli: string; model?: string; name: string; efforts: string[] }
const safe = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(s)
export const isPreset = (p: unknown): p is AiPreset => {
  if (!p || typeof p !== 'object') return false
  const v = p as AiPreset
  return safe(v.id) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 80 &&
    ['grok', 'codex', 'codex-gui', 'claude', 'opencode', 'agy'].includes(v.cli) &&
    (v.model === undefined || safe(v.model)) && (v.effort === undefined || safe(v.effort))
}
export const isExecutionChoice = (v: unknown): v is ExecutionChoice => {
  const c = v as ExecutionChoice | undefined
  return Boolean(c && /^[0-9a-f-]{36}$/i.test(c.sessionId) && isPreset(c.preset))
}
export const presetLabel = (p: AiPreset) => `${p.cli} · ${p.model || 'client default'} · ${p.effort || (
  ['codex', 'codex-gui'].includes(p.cli) && p.model === 'gpt-5.6-luna' ? DEFAULT_EFFORT : 'default effort'
)}`
// The seed delegates model selection to the native client. Project its resolved
// settings for status without pinning future conversations to that snapshot.
export const statusPreset = (preset: AiPreset, discovered: AiPreset[]): AiPreset =>
  preset.cli === 'codex' && !preset.model && !preset.effort
    ? discovered.find((candidate) => candidate.cli === preset.cli) ?? preset
    : preset
export const initialPreset = (cli: string): AiPreset => {
  const key = executorKey(cli)
  return {
    id: 'initial', name: `${resolveExecutor(key).name} · current setup`, cli: key,
    ...(key === 'codex' || key === 'codex-gui'
      ? { model: CODEX_DEFAULT_MODEL, effort: DEFAULT_EFFORT } : {}),
    ...(key === 'opencode'
      ? { model: process.env.OPENCODE_MODEL || 'opencode/nemotron-3.5-lightning-free' } : {}),
  }
}

// Keep persisted state readable by older releases. Luna/max is an execution
// default; the launcher resolves an omitted Luna effort back to max.
export const persistedPreset = (preset: AiPreset): AiPreset => {
  if (!['codex', 'codex-gui'].includes(preset.cli) || preset.model !== 'gpt-5.6-luna' || preset.effort !== 'max') return preset
  const { effort: _effort, ...rollbackReadable } = preset
  return rollbackReadable
}

// Conversation defaults are independent of durable work and explicit saved choices.
export const chatPreset = (cli: string): AiPreset => {
  const preset = initialPreset(cli)
  return ['codex', 'codex-gui'].includes(preset.cli)
    ? { ...preset, id: 'chat-default', name: 'Responsive chat', model: CODEX_CHAT_MODEL, effort: CHAT_EFFORT }
    : preset
}

export const installed = async (cli: string): Promise<boolean> => {
  if (cli === 'codex-gui') return Boolean(await desktopCodexPath())
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    try { await access(join(directory, cli), constants.X_OK); return true } catch {}
  }
  return false
}

// Read only metadata from native client catalogs. Never import prompts, credentials,
// provider configuration, or model instructions into relay context.
export const readModels = async (home = homedir(), available = installed, codexHome = join(home, '.codex')): Promise<ModelChoice[]> => {
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
  for (const cli of ['claude', 'opencode', 'agy'])
    if (await available(cli)) models.push({ cli, name: `${cli} · client default`, efforts: [] })
  return models
}

export const validateSelection = async (p: AiPreset, catalog: ModelChoice[], available = installed): Promise<void> => {
  assertEffort(p.effort, p.model, p.cli)
  if (!isPreset(p) || !(await available(p.cli))) throw new Error('This CLI is not installed.')
  if (!p.model && !p.effort && p.cli !== 'agy') return
  const model = catalog.find((m) => m.cli === p.cli && m.model === p.model)
  if (!model || (p.effort && !model.efforts.includes(p.effort)))
    throw new Error('This model/effort is not in the installed client catalog. Refresh the client and try again; no fallback was selected.')
}
