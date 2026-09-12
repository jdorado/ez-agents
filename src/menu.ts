import { assertEffort, allowedEffort } from './model-policy.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { InlineKeyboard, type Context } from 'grammy'
import { ControlStore } from './control-state.js'
import { chatPreset, installed, persistedPreset, presetLabel, readModels, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { discoverDefaults } from './client-defaults.js'

export const mainCommands = [
  { command: 'new', description: 'New conversation' },
  { command: 'ai', description: 'Choose AI' },
  { command: 'status', description: 'Work status' },
]

export const mainKeyboard = () => new InlineKeyboard()
  .text('New conversation', 'menu:new').text('Choose AI', 'menu:ai').row()
  .text('Work status', 'menu:status')

const clientLabel = (cli: string) => cli === 'codex-gui' ? 'codex-gui (desktop)' : cli

const matchesModel = (preset: AiPreset, model: ModelChoice) =>
  model.cli === preset.cli && (preset.model === undefined || model.model === preset.model) &&
  (preset.effort === undefined || model.efforts.includes(preset.effort))

// Short-lived opaque button IDs: no model names or executable arguments from callbacks.
// These are operational settings, not a second conversational/agent loop.
export const createAiMenu = (control: ControlStore, cli: string, catalog = readModels, workspace = process.cwd(), codexHome?: string,
  isInstalled = installed) => {
  const initial = chatPreset(cli)
  const host = process.env.EZ_EXECUTOR_TRANSPORT === 'host'
  if (host) catalog = async () => JSON.parse(await readFile(path.join(process.env.EZ_CONTROL_DIR!, 'host-executor/models.json'),'utf8'))
  const refresh = async () => control.syncClientPresets(initial, host ? [] : await discoverDefaults(workspace, { codexHome }))
  const validate = async (preset: AiPreset) => {
    assertEffort(preset.effort, preset.model, preset.cli)
    if (preset.id === initial.id) return
    if (preset.id.startsWith('detected_')) {
      const detected = await discoverDefaults(workspace, { codexHome })
      if (!detected.some((p) => p.id === preset.id)) throw new Error('Client settings changed. Refresh available AIs and select the updated choice.')
    } else await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : isInstalled)
  }
  const buttons = new Map<string, { expires: number; action: (ctx: Context) => Promise<void> }>()
  const button = (keyboard: InlineKeyboard, label: string, action: (ctx: Context) => Promise<void>) => {
    for (const [id, b] of buttons) if (b.expires < Date.now()) buttons.delete(id)
    if (buttons.size >= 300) buttons.delete(buttons.keys().next().value!)
    const id = randomBytes(8).toString('hex')
    buttons.set(id, { expires: Date.now() + 15 * 60_000, action })
    keyboard.text(label.slice(0, 64), `ai:${id}`).row()
  }
  const choose = async (ctx: Context, preset: AiPreset) => {
    await validate(preset)
    const session = await control.getActiveSession()
    const state = await control.aiState(initial)
    const current = state.presets.find((p) => p.id === state.selectedId)!
    const fresh = current.cli !== preset.cli || Boolean(session && !session.cli)
    await control.selectPreset(preset.id, session?.sessionId ?? null, fresh)
    await ctx.reply(`${preset.name}\n${presetLabel(preset)}\n${fresh
      ? 'CLI changed: fresh conversation. Files kept; queued work unchanged.'
      : 'Selected for this conversation. Queued work unchanged.'}`)
  }
  const list = async (ctx: Context) => {
    const models = await catalog()
    const state = await control.aiState(initial)
    const keyboard = new InlineKeyboard()
    if (models.length) {
      const recent = (state.recentIds ?? [])
        .map((id) => state.presets.find((preset) => preset.id === id))
        .filter((preset): preset is AiPreset => Boolean(preset))
        .filter((preset) => models.some((model) => matchesModel(preset, model)))
        .slice(0, 3)
      for (const preset of recent) button(keyboard,
        `${preset.id === state.selectedId ? '✓ ' : ''}Recent · ${clientLabel(preset.cli)} · ${preset.name}`,
        (next) => choose(next, preset))
      for (const cli of [...new Set(models.map((model) => model.cli))].sort((a, b) => clientLabel(a).localeCompare(clientLabel(b))))
        button(keyboard, clientLabel(cli), (next) => available(next, cli, 0, models))
    } else {
      const current = state.presets.find((preset) => preset.id === initial.id)
      if (current) button(keyboard, `✓ ${current.name}`, (next) => choose(next, current))
    }
    button(keyboard, 'Refresh available AIs', async (next) => {
      await refresh()
      await list(next)
    })
    await ctx.reply(models.length
      ? 'Choose AI\nUse a recent choice or select an installed client, then choose its model and reasoning level.'
      : 'Choose AI\nNo client catalog available. Showing the current client setup only.', { reply_markup: keyboard })
  }
  const available = async (ctx: Context, cli: string, page = 0, listed?: ModelChoice[]) => {
    const models = (listed ?? await catalog()).filter((model) => model.cli === cli)
    const keyboard = new InlineKeyboard()
    for (const model of models.slice(page * 8, page * 8 + 8)) {
      button(keyboard, model.name, async (next) => {
        const supportedEfforts = model.efforts.filter(effort => allowedEffort(effort, model.model, model.cli))
        if (!supportedEfforts.length) return save(next, model)
        const effortKeyboard = new InlineKeyboard()
        for (const effort of supportedEfforts) button(effortKeyboard, effort, (last) => save(last, model, effort))
        button(effortKeyboard, 'Back to models', (last) => available(last, cli, page, listed))
        await next.reply(`${clientLabel(cli)} · ${model.name}\nChoose reasoning level`, { reply_markup: effortKeyboard })
      })
    }
    if (page > 0) button(keyboard, 'Previous', (next) => available(next, cli, page - 1, listed))
    if (models.length > (page + 1) * 8) button(keyboard, 'Next', (next) => available(next, cli, page + 1, listed))
    button(keyboard, 'Back to clients', (next) => list(next))
    await ctx.reply(`${clientLabel(cli)}\nChoose a model`, { reply_markup: keyboard })
  }
  const save = async (ctx: Context, model: ModelChoice, effort?: string) => {
    const state = await control.aiState(initial)
    const candidate: AiPreset = { id: randomBytes(8).toString('hex'),
      name: `${model.name}${effort ? ` · ${effort}` : ''}`.slice(0, 80), cli: model.cli, model: model.model, effort }
    const stored = persistedPreset(candidate)
    const existing = state.presets.find((preset) => preset.cli === stored.cli && preset.model === stored.model && preset.effort === stored.effort)
    const preset = existing ?? candidate
    await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : isInstalled)
    await control.savePreset(preset)
    await choose(ctx, preset)
  }
  return {
    initial,
    refresh,
    list,
    async handle(ctx: Context): Promise<boolean> {
      const data = ctx.callbackQuery?.data
      if (!data?.startsWith('ai:')) return false
      const entry = buttons.get(data.slice(3))
      await ctx.answerCallbackQuery().catch(() => {})
      if (!entry || entry.expires < Date.now()) await ctx.reply('Menu expired. Open /ai again.')
      else {
        buttons.delete(data.slice(3))
        try { await entry.action(ctx) }
        catch (error) { await ctx.reply(error instanceof Error ? error.message : 'AI selection failed.') }
      }
      return true
    },
  }
}
