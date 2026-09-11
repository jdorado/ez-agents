import { assertEffort, allowedEffort } from './model-policy.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { InlineKeyboard, type Context } from 'grammy'
import { ControlStore } from './control-state.js'
import { chatPreset, presetLabel, readModels, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { discoverDefaults } from './client-defaults.js'

export const mainCommands = [
  { command: 'new', description: 'New conversation' },
  { command: 'ai', description: 'Choose AI' },
  { command: 'status', description: 'Work status' },
  { command: 'schedule', description: 'Schedule a background task' },
]

export const mainKeyboard = () => new InlineKeyboard()
  .text('New conversation', 'menu:new').text('Choose AI', 'menu:ai').row()
  .text('Work status', 'menu:status').text('Schedule task', 'menu:schedule')

// Short-lived opaque button IDs: no model names or executable arguments from callbacks.
// These are operational settings, not a second conversational/agent loop.
export const createAiMenu = (control: ControlStore, cli: string, catalog = readModels, workspace = process.cwd(), codexHome?: string) => {
  const initial = chatPreset(cli)
  const host = process.env.EZ_EXECUTOR_TRANSPORT === 'host'
  if (host) catalog = async () => JSON.parse(await readFile(path.join(process.env.EZ_CONTROL_DIR!, 'host-executor/models.json'),'utf8'))
  const refresh = async () => control.syncClientPresets(initial, host ? [] : await discoverDefaults(workspace, { codexHome }))
  const validate = async (preset: AiPreset) => {
    assertEffort(preset.effort)
    if (preset.id === initial.id) return
    if (preset.id.startsWith('detected_')) {
      const detected = await discoverDefaults(workspace, { codexHome })
      if (!detected.some((p) => p.id === preset.id)) throw new Error('Client settings changed. Refresh available AIs and select the updated choice.')
    } else await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : undefined)
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
  const list = async (ctx: Context, settings = false) => {
    const state = await control.aiState(initial)
    const keyboard = new InlineKeyboard()
    for (const preset of state.presets) button(keyboard,
      `${preset.id === (settings ? state.defaultId : state.selectedId) ? '✓ ' : ''}${preset.name}`,
      async (next) => {
        if (settings) {
          await validate(preset)
          await control.defaultPreset(preset.id)
          await next.reply(`Default: ${preset.name}. Applies to new conversations only.`)
        } else await choose(next, preset)
      })
    button(keyboard, 'Add AI…', (next) => available(next))
    if (settings) button(keyboard, 'Refresh available AIs', async (next) => {
      await refresh()
      await list(next, true)
    })
    await ctx.reply(settings ? 'Default for new conversations\nChoose a saved AI. Current work will not change.'
      : 'Choose AI\nChanging CLI starts a fresh conversation; files stay.', { reply_markup: keyboard })
  }
  const available = async (ctx: Context, page = 0) => {
    const models = await catalog()
    const keyboard = new InlineKeyboard()
    for (const model of models.slice(page * 8, page * 8 + 8)) {
      button(keyboard, `${model.cli} · ${model.name}`, async (next) => {
        if (!model.efforts.length) return save(next, model)
        const efforts = new InlineKeyboard()
        for (const effort of model.efforts.filter(allowedEffort)) button(efforts, effort, (last) => save(last, model, effort))
        await next.reply(`${model.name} — effort`, { reply_markup: efforts })
      })
    }
    if (page > 0) button(keyboard, 'Previous', (next) => available(next, page - 1))
    if (models.length > (page + 1) * 8) button(keyboard, 'Next', (next) => available(next, page + 1))
    await ctx.reply(models.length
      ? 'Installed client choices. Grok/Codex use their local model catalog; other clients use their own default. Adding saves the choice; it does not switch AI.'
      : 'No client catalog available. Open the installed CLI once, then try again.', { reply_markup: keyboard })
  }
  const save = async (ctx: Context, model: ModelChoice, effort?: string) => {
    const state = await control.aiState(initial)
    const existing = state.presets.find((p) => p.cli === model.cli && p.model === model.model && p.effort === effort)
    const preset: AiPreset = existing ?? { id: randomBytes(8).toString('hex'),
      name: `${model.name}${effort ? ` · ${effort}` : ''}`.slice(0, 80), cli: model.cli, model: model.model, effort }
    await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : undefined)
    await control.savePreset(preset)
    const keyboard = new InlineKeyboard()
    button(keyboard, 'Use now', (next) => choose(next, preset))
    button(keyboard, 'Make default', async (next) => {
      await control.defaultPreset(preset.id)
      await next.reply(`Default: ${preset.name}. Applies to new conversations only.`)
    })
    await ctx.reply(`Saved: ${preset.name}\n${presetLabel(preset)}`, { reply_markup: keyboard })
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
      if (!entry || entry.expires < Date.now()) await ctx.reply('Menu expired. Open /ai or /settings again.')
      else {
        buttons.delete(data.slice(3))
        try { await entry.action(ctx) }
        catch (error) { await ctx.reply(error instanceof Error ? error.message : 'AI selection failed.') }
      }
      return true
    },
  }
}
