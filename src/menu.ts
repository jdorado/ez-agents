import { assertEffort } from './model-policy.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { InlineKeyboard } from 'grammy'
import { ControlStore, type ControlGuard, type SessionState } from './control-state.js'
import { chatPreset, installed, persistedPreset, presetProvider, readModels, sameChoice, sameEngine, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { discoverDefaults } from './client-defaults.js'
import { claudeConfigHome } from './executor.js'

export const mainCommands = [
  { command: 'new', description: 'New conversation' },
  { command: 'ai', description: 'Current AI' },
  { command: 'status', description: 'Work status' },
  { command: 'usage', description: 'Account limits and reset times' },
  { command: 'tasks', description: 'Scheduled tasks' },
]

export const mainKeyboard = () => new InlineKeyboard()
  .text('New conversation', 'menu:new').row()
  .text('Work status', 'menu:status').text('Scheduled tasks', 'menu:scheduled-tasks')

// AI catalog and selection shared by application controls. The agent switches its own
// AI with ezenciel-agents-ai; there is no Telegram picker.
export const createAiMenu = (control: ControlStore, cli: string, catalog = readModels, workspace = process.cwd(), codexHome?: string,
  isInstalled = installed, opencodeDataHome?: string, closeSession?: (session: SessionState | null) => Promise<void>) => {
  const initial = chatPreset(cli)
  const host = process.env.EZ_EXECUTOR_TRANSPORT === 'host'
  if (host) catalog = async () => JSON.parse(await readFile(path.join(process.env.EZ_CONTROL_DIR!, 'host-executor/models.json'),'utf8'))
  // Local execution runs Codex with CODEX_HOME set to the agent-bound control
  // directory, but the default catalog probed the process home instead. Bind it
  // to the same agent-bound home so /ai lists the models Codex can actually run.
  else if (codexHome && catalog === readModels) catalog = () => readModels(undefined, isInstalled, codexHome, undefined, opencodeDataHome, undefined, process.env.EZ_CONTROL_DIR)
  const claudeHome = process.env.EZ_CONTROL_DIR ? claudeConfigHome(process.env.EZ_CONTROL_DIR) : undefined
  const refresh = async () => control.syncClientPresets(initial, host ? [] : await discoverDefaults(workspace, { codexHome, claudeHome }))
  const validate = async (preset: AiPreset) => {
    assertEffort(preset.effort, preset.model, preset.cli)
    if (preset.id === initial.id) return
    if (preset.id.startsWith('detected_')) {
      if (host) await validateSelection(preset, await catalog(), async name => (await catalog()).some(model => model.cli === name))
      else {
        const detected = await discoverDefaults(workspace, { codexHome, claudeHome })
        if (!detected.some((p) => p.id === preset.id)) throw new Error('Client settings changed. List the AI catalog again and select the updated choice.')
      }
    } else await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : isInstalled)
  }
  const select = async (preset: AiPreset, expectedSession: string | null, guard?: ControlGuard) => {
    await validate(preset)
    const session = await control.getActiveSession()
    const state = (await control.status()).ai
    if (!state) throw new Error('AI settings not initialized')
    const current = state.presets.find((p) => p.id === state.selectedId)!
    const fresh = !sameEngine(current, preset) || presetProvider(current) !== presetProvider(preset) || Boolean(session && !session.cli)
    if (!await control.selectPreset(preset.id, expectedSession, fresh, guard)) throw new Error('AI binding changed. Read the current AI before trying again.')
    if (fresh) await closeSession?.(session)
    return { preset, fresh }
  }
  const saveSelection = async (model: ModelChoice, effort?: string, guard?: ControlGuard) => {
    const state = (await control.status()).ai
    if (!state) throw new Error('AI settings not initialized')
    const candidate: AiPreset = { id: randomBytes(8).toString('hex'),
      name: `${model.name}${effort ? ` · ${effort}` : ''}`.slice(0, 80), cli: model.cli, provider:model.provider, ...(model.authProfile ? {authProfile:model.authProfile} : {}), model: model.model, effort }
    const stored = persistedPreset(candidate)
    const existing = state.presets.find((preset) => sameChoice(preset, stored))
    const preset = existing ?? candidate
    await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : isInstalled)
    // Private scopes persist their selection on the session, not the owner menu.
    if (!guard?.applicationScope) await control.savePreset(preset, guard)
    return preset
  }
  return {
    initial,
    refresh,
    validate,
    catalog: () => catalog(),
    select,
    saveSelection,
  }
}
