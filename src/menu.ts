import { assertEffort, allowedEffort } from './model-policy.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { InlineKeyboard, type Context } from 'grammy'
import { ControlStore, type ControlGuard, type SessionState } from './control-state.js'
import { chatPreset, installed, persistedPreset, presetLabel, presetProvider, readModels, sameChoice, sameEngine, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { discoverDefaults } from './client-defaults.js'
import { claudeConfigHome } from './executor.js'
import { escapeHtml } from './format.js'

export const mainCommands = [
  { command: 'new', description: 'New conversation' },
  { command: 'chats', description: 'Conversations' },
  { command: 'rename', description: 'Rename current conversation' },
  { command: 'ai', description: 'Choose AI' },
  { command: 'status', description: 'Work status' },
  { command: 'usage', description: 'Account limits and reset times' },
  { command: 'tasks', description: 'Scheduled tasks' },
]

export const mainKeyboard = () => new InlineKeyboard()
  .text('New conversation', 'menu:new').text('Conversations', 'menu:chats').row()
  .text('Choose AI', 'menu:ai').row()
  .text('Work status', 'menu:status').text('Scheduled tasks', 'menu:scheduled-tasks')

const clientLabel = (cli: string) => cli === 'codex-gui' ? 'codex-gui (desktop)' : cli

const matchesModel = (preset: AiPreset, model: ModelChoice) =>
  sameEngine(model, preset) && model.provider === preset.provider && (preset.model === undefined || model.model === preset.model) &&
  (preset.effort === undefined || model.efforts.includes(preset.effort))

// The catalog prefixes account and engine into model names (`claude3 · claude · opus`);
// the card shows them as their own rows, so only the model part is displayed.
const modelName = (model: ModelChoice) => {
  let name = model.name
  for (const prefix of [model.authProfile, model.cli]) if (prefix && name.startsWith(`${prefix} · `)) name = name.slice(prefix.length + 3)
  return name === 'client default' ? 'Default' : name
}
const supportedEfforts = (model: ModelChoice) => model.efforts.filter(effort => allowedEffort(effort, model.model, model.cli))
const sameModel = (a: ModelChoice, b: ModelChoice) => a.model === b.model && a.provider === b.provider
const keepOrDefaultEffort = (model: ModelChoice, wanted?: string) => {
  const supported = supportedEfforts(model)
  return wanted && supported.includes(wanted) ? wanted : supported.includes('high') ? 'high' : supported[0]
}
const chunks = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size))
// Rows of at most `max` buttons, split evenly (5 → 3+2) instead of leaving a lone button.
const balanced = <T,>(items: T[], max: number) => chunks(items, Math.ceil(items.length / Math.ceil(items.length / max) || 1))
const MODELS_PER_PAGE = 9

// The card's working selection: a catalog entry plus an effort, applied only on Apply.
type Draft = { model: ModelChoice; effort?: string; page: number }

// Short-lived opaque button IDs: no model names or executable arguments from callbacks.
// These are operational settings, not a second conversational/agent loop.
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
        if (!detected.some((p) => p.id === preset.id)) throw new Error('Client settings changed. Refresh available AIs and select the updated choice.')
      }
    } else await validateSelection(preset, await catalog(), host ? async name => (await catalog()).some(model => model.cli === name) : isInstalled)
  }
  const buttons = new Map<string, { expires: number; action: (ctx: Context) => Promise<void> }>()
  // Buttons of one rendered card; a re-render releases them so edits never leak entries.
  const issue = (keyboard: InlineKeyboard, owned: Set<string>, label: string, action: (ctx: Context) => Promise<void>, row = false) => {
    for (const [id, b] of buttons) if (b.expires < Date.now()) buttons.delete(id)
    if (buttons.size >= 300) buttons.delete(buttons.keys().next().value!)
    const id = randomBytes(8).toString('hex')
    buttons.set(id, { expires: Date.now() + 15 * 60_000, action })
    owned.add(id)
    keyboard.text(label.slice(0, 64), `ai:${id}`)
    if (row) keyboard.row()
  }
  const select = async (preset: AiPreset, expectedSession: string | null, guard?: ControlGuard) => {
    await validate(preset)
    const session = await control.getActiveSession()
    const state = (await control.status()).ai
    if (!state) throw new Error('AI settings not initialized')
    const current = state.presets.find((p) => p.id === state.selectedId)!
    const fresh = !sameEngine(current, preset) || presetProvider(current) !== presetProvider(preset) || Boolean(session && !session.cli)
    if (!await control.selectPreset(preset.id, expectedSession, fresh, guard)) throw new Error('AI binding changed. Refresh available AIs before trying again.')
    if (fresh) await closeSession?.(session)
    return { preset, fresh }
  }
  // The card edits itself in place when it was opened from a button; otherwise it is a new message.
  const show = async (ctx: Context, text: string, keyboard?: InlineKeyboard, html = false) => {
    const options = { ...(html ? { parse_mode: 'HTML' as const } : {}), ...(keyboard ? { reply_markup: keyboard } : {}) }
    if (!ctx.callbackQuery?.message) { await ctx.reply(text, options); return }
    try { await ctx.editMessageText(text, options) }
    catch (error) {
      if (!String((error as { description?: string })?.description).includes('message is not modified')) await ctx.reply(text, options)
    }
  }
  const choose = async (ctx: Context, preset: AiPreset) => {
    const session = await control.getActiveSession()
    const { fresh } = await select(preset, session?.sessionId ?? null)
    await show(ctx, `${preset.name}\n${presetLabel(preset)}\n${fresh
      ? 'Client or provider changed: fresh conversation. Files kept; queued work unchanged.'
      : 'Saved for this conversation. History kept; queued work unchanged.'}`)
  }
  const presetOf = (draft: Draft): AiPreset => ({ id: 'draft', name: modelName(draft.model), cli: draft.model.cli,
    ...(draft.model.provider ? { provider: draft.model.provider } : {}), ...(draft.model.authProfile ? { authProfile: draft.model.authProfile } : {}),
    ...(draft.model.model ? { model: draft.model.model } : {}), ...(draft.effort ? { effort: draft.effort } : {}) })
  // The default login first, then named logins in catalog order (sort() would push undefined last).
  const accountsOf = (models: ModelChoice[], cli: string) => {
    const logins = [...new Set(models.filter(model => model.cli === cli).map(model => model.authProfile))]
    return [...logins.filter(login => login === undefined), ...logins.filter(login => login !== undefined)]
  }
  const pick = (draft: Draft, model: ModelChoice): Draft => ({ model, page: 0, effort: keepOrDefaultEffort(model, draft.effort) })
  const toAccount = (models: ModelChoice[], draft: Draft, cli: string, authProfile?: string): Draft => {
    const list = models.filter(model => sameEngine(model, { cli, authProfile }))
    return pick(draft, list.find(model => sameModel(model, draft.model)) ?? list[0])
  }
  const toEngine = (models: ModelChoice[], draft: Draft, cli: string): Draft => {
    const accounts = accountsOf(models, cli)
    return toAccount(models, draft, cli, accounts.includes(draft.model.authProfile) ? draft.model.authProfile : accounts[0])
  }
  // One card: the current choice, then engine, account, model and effort rows that
  // only move the draft. Apply saves it through the same select/save path as before.
  const card = async (ctx: Context, models: ModelChoice[], draft: Draft, owned = new Set<string>()): Promise<void> => {
    for (const id of owned) buttons.delete(id)
    owned.clear()
    const state = await control.aiState(initial)
    const selected = state.presets.find((preset) => preset.id === state.selectedId)!
    const candidate = presetOf(draft)
    const same = sameChoice(selected, candidate)
    const fresh = !sameEngine(selected, candidate) || presetProvider(selected) !== presetProvider(candidate)
    const keyboard = new InlineKeyboard()
    const redraw = (next: Draft) => (again: Context) => card(again, models, next, owned)
    const recent = (state.recentIds ?? [])
      .map((id) => state.presets.find((preset) => preset.id === id))
      .filter((preset): preset is AiPreset => Boolean(preset))
      .filter((preset) => preset.id !== state.selectedId && models.some((model) => matchesModel(preset, model)))
      .slice(0, 3)
    for (const preset of recent) issue(keyboard, owned,
      `⏱ ${clientLabel(preset.cli)}${preset.authProfile ? `@${preset.authProfile}` : ''} · ${preset.model ?? 'default'}${preset.effort ? ` · ${preset.effort}` : ''}`,
      (next) => choose(next, preset), true)
    const engines = [...new Set(models.map((model) => model.cli))].sort((a, b) => clientLabel(a).localeCompare(clientLabel(b)))
    for (const row of balanced(engines, 3)) {
      for (const cli of row) issue(keyboard, owned, `${cli === draft.model.cli ? '✓ ' : ''}${clientLabel(cli)}`, redraw(toEngine(models, draft, cli)))
      keyboard.row()
    }
    const accounts = accountsOf(models, draft.model.cli)
    if (accounts.length > 1) for (const row of balanced(accounts, 4)) {
      for (const account of row) issue(keyboard, owned, `${account === draft.model.authProfile ? '✓ ' : ''}${account ?? 'default'}`,
        redraw(toAccount(models, draft, draft.model.cli, account)))
      keyboard.row()
    }
    const listed = models.filter((model) => sameEngine(model, draft.model))
    const pages = Math.ceil(listed.length / MODELS_PER_PAGE), page = Math.min(draft.page, Math.max(0, pages - 1))
    const visible = listed.slice(page * MODELS_PER_PAGE, (page + 1) * MODELS_PER_PAGE)
    // Long names get two buttons per row so a phone does not cut them off.
    for (const row of chunks(visible, visible.some((model) => modelName(model).length > 11) ? 2 : 3)) {
      for (const model of row) issue(keyboard, owned, `${model === draft.model ? '✓ ' : ''}${modelName(model)}`, redraw(pick(draft, model)))
      keyboard.row()
    }
    if (pages > 1) {
      issue(keyboard, owned, '‹ Models', redraw({ ...draft, page: (page + pages - 1) % pages }))
      issue(keyboard, owned, `${page + 1}/${pages} ›`, redraw({ ...draft, page: (page + 1) % pages }), true)
    }
    const efforts = supportedEfforts(draft.model)
    for (const row of balanced(efforts, 4)) {
      for (const effort of row) issue(keyboard, owned, `${effort === draft.effort ? '✓ ' : ''}${effort}`, redraw({ ...draft, effort }))
      keyboard.row()
    }
    if (!same) issue(keyboard, owned, 'Apply', async (next) => choose(next, await saveSelection(draft.model, draft.effort)))
    issue(keyboard, owned, '↻ Refresh', async (next) => { await refresh(); await list(next) })
    const rows = ['engine', ...(accounts.length > 1 ? ['account'] : []), 'model', ...(efforts.length ? ['effort'] : [])]
    await show(ctx, [
      '<b>🤖 Choose AI</b>',
      `Current: <code>${escapeHtml(presetLabel(selected))}</code>`,
      ...(same ? ['ℹ Already in use · saved per conversation'] : [
        `New: <code>${escapeHtml(presetLabel(candidate))}</code>`,
        fresh ? '⚠ Starts a new conversation · files kept; queued work unchanged' : 'ℹ History kept; queued work unchanged']),
      `<i>Rows: ${rows.join(' · ')}</i>`,
    ].join('\n'), keyboard, true)
  }
  const list = async (ctx: Context) => {
    const models = await catalog()
    const state = await control.aiState(initial)
    const selected = state.presets.find((preset) => preset.id === state.selectedId)!
    if (!models.length) {
      const keyboard = new InlineKeyboard()
      const current = state.presets.find((preset) => preset.id === initial.id)
      const owned = new Set<string>()
      if (current) issue(keyboard, owned, `✓ ${current.name}`, (next) => choose(next, current), true)
      issue(keyboard, owned, 'Refresh available AIs', async (next) => { await refresh(); await list(next) })
      await show(ctx, `Choose AI\nCurrent: ${presetLabel(selected)}\nNo client catalog available. Showing the current client setup only.`, keyboard)
      return
    }
    // Start on the current choice; a saved choice outside the catalog starts on the first entry.
    const match = models.find((model) => matchesModel(selected, model) && model.model === selected.model) ?? models.find((model) => matchesModel(selected, model)) ?? models[0]
    const effort = selected.effort && supportedEfforts(match).includes(selected.effort) ? selected.effort : undefined
    const index = models.filter((model) => sameEngine(model, match)).indexOf(match)
    await card(ctx, models, { model: match, effort, page: Math.floor(index / MODELS_PER_PAGE) })
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
