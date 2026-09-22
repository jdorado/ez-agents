import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, chatPreset, readModels, isPreset, readOpencodeModels, validateSelection, opencodeProviderAllowlist } from '../src/ai.js'
import { createAiMenu } from '../src/menu.js'
import { EXECUTOR_REGISTRY, nativeSessionId } from '../src/executor.js'
import { InboxStore } from '../src/inbox.js'
import { executionDefaults } from '../src/model-policy.js'
import type { Update } from 'grammy/types'

test('same-client model switch does not resume the previous native thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-model-switch-'))
  try {
    const store = new ControlStore(dir, 1000)
    const deepseek = { id: 'deepseek', name: 'DeepSeek', cli: 'codex', model: 'deepseek/flash', effort: 'max' }
    const luna = { id: 'luna', name: 'Luna', cli: 'codex', model: 'gpt-5.6-luna', effort: 'max' }
    const first = await store.captureChoice(initialPreset('codex'))
    await store.savePreset(deepseek)
    await store.selectPreset(deepseek.id, first.sessionId, false)
    const started = await store.captureChoice(initialPreset('codex'))
    await store.saveNativeSession(started.sessionId, 'native-deepseek')
    const same = await store.captureChoice(initialPreset('codex'))
    assert.equal(same.sessionId, started.sessionId)
    assert.equal((await store.executionSession(same)).nativeSessionId, 'native-deepseek')
    await store.savePreset(luna)
    await store.selectPreset(luna.id, started.sessionId, false)
    const next = await store.captureChoice(initialPreset('codex'))
    assert.notEqual(next.sessionId, started.sessionId)
    assert.equal(next.preset.model, luna.model)
    assert.equal((await store.executionSession(next)).hasStarted, false)
    assert.equal((await store.executionSession(next)).nativeSessionId, undefined)
    assert.equal((await store.executionSession(started)).nativeSessionId, 'native-deepseek')
    await store.saveNativeSession(next.sessionId, 'native-luna')
    const clientDefault = initialPreset('codex')
    await store.savePreset(clientDefault)
    await store.selectPreset(clientDefault.id, next.sessionId, false)
    const defaultChoice = await store.captureChoice(clientDefault)
    assert.notEqual(defaultChoice.sessionId, next.sessionId)
    assert.equal(defaultChoice.preset.model, undefined)
    await store.saveNativeSession(defaultChoice.sessionId, 'native-default')
    await store.selectPreset(deepseek.id, defaultChoice.sessionId, false)
    const explicitAgain = await store.captureChoice(clientDefault)
    assert.notEqual(explicitAgain.sessionId, defaultChoice.sessionId)
    assert.equal(explicitAgain.preset.model, deepseek.model)
    await store.saveNativeSession(explicitAgain.sessionId, 'native-explicit')
    const openrouter = { ...deepseek, id: 'openrouter-deepseek', name: 'OpenRouter DeepSeek', provider: 'openrouter' }
    await store.savePreset(openrouter)
    await store.selectPreset(openrouter.id, explicitAgain.sessionId, false)
    const providerChoice = await store.captureChoice(clientDefault)
    assert.notEqual(providerChoice.sessionId, explicitAgain.sessionId)
    assert.equal(providerChoice.preset.provider, 'openrouter')
    const args = EXECUTOR_REGISTRY.codex.buildArgs({
      workspace: dir, isResume: false, sessionId: next.sessionId,
    }, '', '')
    assert.equal(args.includes('resume'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('AI choices pin model, effort and session; defaults and CLI switches do not reroute old work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-'))
  try {
    const store = new ControlStore(dir, 1000)
    const first = await store.captureChoice(initialPreset('grok'))
    const preset = { id: 'fixture', name: 'Everyday', cli: 'codex', model: 'fixture-model', effort: 'medium' }
    await store.savePreset(preset)
    await store.defaultPreset(preset.id)
    assert.deepEqual(await store.captureChoice(initialPreset('grok')), first)
    await store.selectPreset(preset.id, first.sessionId, true)
    const second = await store.captureChoice(initialPreset('grok'))
    assert.notEqual(second.sessionId, first.sessionId)
    assert.deepEqual(second.preset, preset)
    assert.equal((await store.executionSession(first)).cli, 'grok')
    await store.markSessionStarted(first.sessionId)
    assert.equal((await store.executionSession(first)).hasStarted, true)
    const restarted = new ControlStore(dir, 1000)
    assert.deepEqual(await restarted.captureChoice(initialPreset('opencode')), second)
    await restarted.resetSession()
    assert.equal((await restarted.captureChoice(initialPreset('grok'))).preset.id, preset.id)
    assert.equal((await restarted.executionSession(second)).hasStarted, false)
    await assert.rejects(store.executionSession({ ...first, preset }), /matching CLI binding/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('AI selection keeps the three most recently used choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-recent-'))
  try {
    const store = new ControlStore(dir, 1000)
    let choice = await store.captureChoice(initialPreset('grok'))
    for (const id of ['first', 'second', 'third', 'fourth']) {
      await store.savePreset({ id, name: id, cli: 'codex', model: id, effort: 'medium' })
      await store.selectPreset(id, choice.sessionId, true)
      choice = await store.captureChoice(initialPreset('grok'))
    }
    assert.deepEqual((await store.status()).ai?.recentIds, ['fourth', 'third', 'second'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('inbox never batches messages across an AI switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-inbox-'))
  try {
    const store = new ControlStore(dir, 1000)
    const inbox = new InboxStore(dir)
    const first = await store.captureChoice(initialPreset('grok'))
    await inbox.accept({ update_id: 1 } as Update, first)
    await store.resetSession()
    const second = await store.captureChoice(initialPreset('grok'))
    await inbox.accept({ update_id: 2 } as Update, second)
    const batch = (await inbox.next(true))!
    assert.deepEqual(batch.entries.map((e) => e.update.update_id), [1])
    assert.deepEqual(batch.entries[0].execution, first)
    await inbox.finish(batch.id)
    assert.deepEqual((await inbox.next(true))!.entries[0].execution, second)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('legacy unbound sessions fail closed; native IDs cannot cross conversations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-legacy-'))
  try {
    const store = new ControlStore(dir, 1000)
    const legacy = await store.ensureActiveSession()
    await store.markSessionStarted(legacy.sessionId)
    const choice = await store.captureChoice(initialPreset('grok'))
    await assert.rejects(store.executionSession(choice), /matching CLI binding/)
    await store.resetSession()
    const next = await store.captureChoice(initialPreset('grok'))
    await store.saveNativeSession(next.sessionId, 'fixture_native')
    await assert.rejects(store.saveNativeSession(next.sessionId, 'different_native'), /changed unexpectedly/)
    await assert.rejects(store.saveNativeSession(next.sessionId, '../escape'), /Invalid native/)
    const state = JSON.parse(await readFile(join(dir, 'control-state.json'), 'utf8'))
    state.ai.presets[0].cli = 'sh'
    await writeFile(join(dir, 'control-state.json'), JSON.stringify(state))
    await assert.rejects(store.status(), /unsupported shape/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('model catalog projects native metadata only, excluding hidden entries and instructions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ez-catalog-'))
  try {
    await mkdir(join(home, '.codex'))
    await writeFile(join(home, '.codex/models_cache.json'), JSON.stringify({ models: [
      { slug: 'fixture-model', display_name: 'Fixture', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'bad value' }],
        model_messages: 'Untrusted instructions must not be imported', api_key: 'fixture-secret' },
      { slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }] },
      { slug: 'hidden-model', visibility: 'hide' },
    ] }))
    assert.deepEqual(await readModels(home, async (cli) => cli === 'codex'), [
      { cli: 'codex', model: 'fixture-model', name: 'Fixture', efforts: ['medium'] },
      { cli: 'codex', model: 'gpt-5.6-luna', name: 'Luna', efforts: ['high', 'xhigh', 'max'] },
    ])
    assert.equal(isPreset({ id: 'x', name: 'x', cli: 'grok', model: '--shell escape' }), false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Choose AI lists recent choices and installed clients before model and effort selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-menu-'))
  try {
    const store = new ControlStore(dir, 1000)
    const initial = initialPreset('grok')
    await store.aiState(initial)
    await store.savePreset({ id: 'recent', name: 'Recent', cli: 'codex', model: 'fixture-model', effort: 'medium' })
    const first = await store.captureChoice(initial)
    await store.selectPreset('recent', first.sessionId, true)
    const menu = createAiMenu(store, 'grok', async () => [
      { cli: 'codex', model: 'fixture-model', name: 'Fixture', efforts: ['medium', 'high'] },
      { cli: 'codex', model: 'second-model', name: 'Second', efforts: ['low'] },
      { cli: 'codex-gui', model: 'fixture-model', name: 'Desktop Fixture', efforts: ['medium'] },
      { cli: 'claude', name: 'claude · client default', efforts: [] },
    ], undefined, undefined, async (name) => name === 'codex')
    const replies: Array<{ text: string; buttons: Array<{ text: string; callback_data: string }> }> = []
    const context = (data?: string) => ({
      callbackQuery: data ? { data } : undefined,
      answerCallbackQuery: async () => ({}),
      reply: async (text: string, options?: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } }) => {
        replies.push({ text, buttons: options?.reply_markup?.inline_keyboard?.flat() ?? [] })
        return {} as never
      },
    })
    await menu.list(context() as never)
    assert.match(replies.at(-1)!.text, /recent choice|installed client/i)
    assert.deepEqual(replies.at(-1)!.buttons.map((button) => button.text), [
      '✓ Recent · codex · Recent', 'claude', 'codex', 'codex-gui (desktop)', 'Refresh available AIs',
    ])

    const client = replies.at(-1)!.buttons.find((button) => button.text === 'codex')!
    await menu.handle(context(client.callback_data) as never)
    assert.deepEqual(replies.at(-1)!.buttons.map((button) => button.text), ['Fixture', 'Second', 'Back to clients'])

    const model = replies.at(-1)!.buttons.find((button) => button.text === 'Fixture')!
    await menu.handle(context(model.callback_data) as never)
    assert.deepEqual(replies.at(-1)!.buttons.map((button) => button.text), ['medium', 'high', 'Back to models'])
    const effort = replies.at(-1)!.buttons.find((button) => button.text === 'high')!
    await menu.handle(context(effort.callback_data) as never)
    const state = await store.status()
    const selected = state.ai!.presets.find((preset) => preset.id === state.ai!.selectedId)!
    assert.deepEqual({ cli: selected.cli, model: selected.model, effort: selected.effort }, {
      cli: 'codex', model: 'fixture-model', effort: 'high',
    })
    assert.match(replies.at(-1)!.text, /Selected for this conversation/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Choose AI does not expose saved model choices without a catalog to validate them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-menu-empty-'))
  try {
    const store = new ControlStore(dir, 1000)
    await store.aiState(initialPreset('grok'))
    await store.savePreset({ id: 'saved', name: 'Saved model', cli: 'codex', model: 'fixture-model', effort: 'medium' })
    await store.savePreset({ id: 'saved-default', name: 'Saved client default', cli: 'claude' })
    const menu = createAiMenu(store, 'grok', async () => [])
    let reply = ''
    let keyboard: { inline_keyboard?: Array<Array<{ text: string }>> } | undefined
    await menu.list({ reply: async (text: string, options?: { reply_markup?: unknown }) => {
      reply = text
      keyboard = options?.reply_markup as typeof keyboard
      return {} as never
    } } as never)
    assert.match(reply, /current client setup only/)
    assert.ok(!keyboard?.inline_keyboard?.flat().some((button) => button.text.includes('Saved model')))
    assert.ok(!keyboard?.inline_keyboard?.flat().some((button) => button.text.includes('Saved client default')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('model catalog can read an agent-bound Codex home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ez-catalog-home-'))
  const codexHome = await mkdtemp(join(tmpdir(), 'ez-catalog-codex-'))
  try {
    await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }] },
    ] }))
    assert.deepEqual(await readModels(home, async (cli) => cli === 'codex', codexHome), [
      { cli: 'codex', model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low'] },
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('Choose AI lists the agent-bound Codex home instead of only the desktop fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-ai-menu-codex-home-'))
  const codexHome = await mkdtemp(join(tmpdir(), 'ez-ai-menu-cache-'))
  try {
    await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'fixture-bound-model', display_name: 'Bound Fixture', visibility: 'list',
        supported_reasoning_levels: [{ effort: 'medium' }] },
    ] }))
    const store = new ControlStore(dir, 1000)
    await store.aiState(initialPreset('codex'))
    // Default catalog (no explicit override): the menu must bind it to codexHome,
    // otherwise an empty process-home cache drops codex and only codex-gui lists.
    const menu = createAiMenu(store, 'codex', undefined, dir, codexHome,
      async (cli) => cli === 'codex' || cli === 'codex-gui')
    const replies: Array<{ text: string; buttons: Array<{ text: string; callback_data: string }> }> = []
    const context = (data?: string) => ({
      callbackQuery: data ? { data } : undefined,
      answerCallbackQuery: async () => ({}),
      reply: async (text: string, options?: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } }) => {
        replies.push({ text, buttons: options?.reply_markup?.inline_keyboard?.flat() ?? [] })
        return {} as never
      },
    })
    await menu.list(context() as never)
    assert.deepEqual(replies.at(-1)!.buttons.map((button) => button.text), [
      'codex', 'codex-gui (desktop)', 'Refresh available AIs',
    ])
    const client = replies.at(-1)!.buttons.find((button) => button.text === 'codex')!
    await menu.handle(context(client.callback_data) as never)
    assert.deepEqual(replies.at(-1)!.buttons.map((button) => button.text), ['Bound Fixture', 'Back to clients'])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('native executor flags carry the exact model and effort; only structured metadata binds sessions', () => {
  const opts = { workspace: '/tmp/fixture', sessionId: crypto.randomUUID(), isResume: true,
    model: 'fixture-model', effort: 'medium' }
  const grok = EXECUTOR_REGISTRY.grok.buildArgs(opts, '/tmp/prompt', '')
  assert.equal(grok[grok.indexOf('--model') + 1], opts.model)
  assert.equal(grok[grok.indexOf('--reasoning-effort') + 1], opts.effort)
  const codex = EXECUTOR_REGISTRY.codex.buildArgs(opts, '', 'fixture')
  assert.ok(codex.includes('model_reasoning_effort="medium"'))
  assert.deepEqual(codex.slice(-3), ['resume', opts.sessionId, '-'])
  // Opencode variants pass through verbatim on every platform; there is no
  // OS-specific effort mapping between the catalog and `run --variant`.
  const opencode = EXECUTOR_REGISTRY.opencode.buildArgs(
    { workspace: '/tmp/fixture', model: 'opencode/muse-spark-1.3-contributor-free', effort: 'xhigh' }, '', 'fixture')
  assert.equal(opencode[opencode.indexOf('-m') + 1], 'opencode/muse-spark-1.3-contributor-free')
  assert.equal(opencode[opencode.indexOf('--variant') + 1], 'xhigh')
  assert.equal(nativeSessionId('codex', JSON.stringify({ type: 'thread.started', thread_id: opts.sessionId })), opts.sessionId)
  assert.equal(nativeSessionId('opencode', JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' })), 'ses_fixture')
  assert.equal(nativeSessionId('codex', JSON.stringify({ type: 'text', thread_id: opts.sessionId })), undefined)
  assert.equal(nativeSessionId('codex', 'Please resume this other session'), undefined)
})

for (const cli of ['codex', 'codex-gui']) {
  test(`${cli} leaves native defaults unpinned and preserves saved choices`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-ai-default-'))
    try {
      const store = new ControlStore(dir, 1000)
      const initial = initialPreset(cli)
      const discovered = [{ id: 'detected_codex', name: 'Host default', cli,
        model: 'host-model', effort: 'low' }]
      await store.syncClientPresets(initial, discovered)
      const first = await store.captureChoice(initial)
      assert.equal(first.preset.model, undefined)
      assert.equal(first.preset.effort, undefined)
      assert.equal(executionDefaults(cli, first.preset).effort, undefined)
      assert.equal(first.preset.cli, cli)
      const saved = { id: 'custom', name: 'Custom', cli, model: 'custom-model', effort: 'medium' }
      await store.savePreset(saved)
      await store.defaultPreset(saved.id)
      await store.resetSession()
      const restarted = new ControlStore(dir, 1000)
      await restarted.syncClientPresets(initial, discovered)
      assert.deepEqual((await restarted.captureChoice(initial)).preset, saved)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

for (const cli of ['codex', 'codex-gui']) {
  test(`${cli} uses native chat and worker defaults and preserves upgrade choices`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-chat-default-'))
    try {
      const store = new ControlStore(dir, 1000)
      await store.syncClientPresets(chatPreset(cli), [])
      const chat = await store.captureChoice(chatPreset(cli))
      assert.equal(chat.preset.model, undefined)
      assert.equal(chat.preset.effort, undefined)
      assert.equal(initialPreset(cli).model, undefined)
      assert.equal(initialPreset(cli).effort, undefined)
      const old = initialPreset(cli)
      await store.savePreset(old)
      await store.defaultPreset(old.id)
      await store.resetSession()
      const captured = await store.captureChoice(old)
      await store.syncClientPresets(chatPreset(cli), [])
      assert.deepEqual(await store.captureChoice(chatPreset(cli)), captured)
      assert.equal((await store.aiState(chatPreset(cli))).presets.filter(p => p.id === 'chat-default').length, 1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('upgrades expose responsive chat without replacing an existing default or queued snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-chat-upgrade-'))
  try {
    const store = new ControlStore(dir, 1000), old = initialPreset('codex')
    const captured = await store.captureChoice(old)
    await store.syncClientPresets(chatPreset('codex'), [])
    assert.deepEqual(await store.captureChoice(chatPreset('codex')), captured)
    const state = await store.aiState(chatPreset('codex'))
    assert.equal(state.defaultId, old.id)
    assert.ok(state.presets.some(p => p.id === 'chat-default'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('opencode catalog projects installed models with variants as efforts', async () => {
  const verbose = [
    'opencode/big-pickle',
    JSON.stringify({ id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', variants: {} }),
    'opencode/ling-free',
    JSON.stringify({ id: 'ling-free', providerID: 'opencode', name: 'Ling Free',
      variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, 'bad option': {} } }),
    'openrouter/~aliased/model',
    JSON.stringify({ id: 'model', providerID: 'openrouter', name: 'Aliased', variants: {} }),
  ].join('\n')
  const catalog = await readOpencodeModels(async (args) => {
    assert.deepEqual(args, ['models', '--verbose'])
    return verbose
  })
  assert.deepEqual(catalog, [
    { cli: 'opencode', model: 'opencode/big-pickle', name: 'Big Pickle · opencode/big-pickle', efforts: [] },
    { cli: 'opencode', model: 'opencode/ling-free', name: 'Ling Free · opencode/ling-free', efforts: ['low', 'medium'] },
  ])
})

test('opencode catalog falls back to the plain list, then to the client default', async () => {
  const plain = await readOpencodeModels(async (args) => {
    if (args.includes('--verbose')) throw new Error('no verbose metadata')
    return 'opencode/alpha\nopenrouter/~aliased/model\nnot a model line\n'
  })
  assert.deepEqual(plain, [{ cli: 'opencode', model: 'opencode/alpha', name: 'opencode/alpha', efforts: [] }])
  assert.deepEqual(await readOpencodeModels(async () => { throw new Error('opencode unavailable') }), [])
  const fallback = await readModels(undefined, async (cli) => cli === 'opencode', undefined as never,
    async () => { throw new Error('opencode unavailable') })
  assert.deepEqual(fallback, [{ cli: 'opencode', name: 'opencode · client default', efforts: [] }])
  const listed = await readModels(undefined, async (cli) => cli === 'opencode', undefined as never,
    async () => 'opencode/alpha\n')
  assert.deepEqual(listed, [{ cli: 'opencode', model: 'opencode/alpha', name: 'opencode/alpha', efforts: [] }])
})

test('opencode provider allowlist scopes the catalog to Go and never falls back outside it', async () => {
  assert.equal(opencodeProviderAllowlist({}), undefined)
  assert.equal(opencodeProviderAllowlist({ EZ_OPENCODE_PROVIDERS: '  ' }), undefined)
  assert.deepEqual(opencodeProviderAllowlist({ EZ_OPENCODE_PROVIDERS: 'opencode-go' }), ['opencode-go'])
  assert.deepEqual(opencodeProviderAllowlist({ EZ_OPENCODE_PROVIDERS: ' opencode-go ,openrouter,opencode-go ' }), ['opencode-go', 'openrouter'])
  for (const bad of ['Bad Name!', 'has space', 'UPPER', 'a'.repeat(33), ',,,', 'ok,,bad name'])
    assert.throws(() => opencodeProviderAllowlist({ EZ_OPENCODE_PROVIDERS: bad }), /one to sixteen unique provider IDs/)
  const verbose = [
    'opencode/mimo-free',
    JSON.stringify({ id: 'mimo-free', providerID: 'opencode', name: 'Mimo Free', variants: {} }),
    'opencode-go/muse-spark-1.3-contributor',
    JSON.stringify({ id: 'muse-spark-1.3-contributor', providerID: 'opencode-go', name: 'Muse Spark 1.3 Contributor',
      variants: { high: {}, xhigh: {} } }),
    'openrouter/some/model',
    JSON.stringify({ id: 'some/model', providerID: 'openrouter', name: 'Some', variants: {} }),
  ].join('\n')
  const runner = async () => verbose
  const prior = process.env.EZ_OPENCODE_PROVIDERS
  try {
    process.env.EZ_OPENCODE_PROVIDERS = 'opencode-go'
    const scoped = await readModels(undefined, async (cli) => cli === 'opencode', undefined as never, runner)
    assert.deepEqual(scoped.map((m) => m.model), ['opencode-go/muse-spark-1.3-contributor'])
    await assert.rejects(
      validateSelection({ id: 'free', name: 'Free', cli: 'opencode', model: 'opencode/mimo-free' }, scoped, async () => true),
      /installed client catalog/)
    process.env.EZ_OPENCODE_PROVIDERS = 'missing-provider'
    assert.deepEqual(await readModels(undefined, async (cli) => cli === 'opencode', undefined as never, runner), [])
    delete process.env.EZ_OPENCODE_PROVIDERS
    assert.equal((await readModels(undefined, async (cli) => cli === 'opencode', undefined as never, runner)).length, 3)
  } finally {
    if (prior === undefined) delete process.env.EZ_OPENCODE_PROVIDERS
    else process.env.EZ_OPENCODE_PROVIDERS = prior
  }
})
test('explicit host binding allowlist overrides the process environment', async () => {
  const runner = async () => 'opencode/a\nopencode-go/b\n'
  const only = (models: { cli: string; model?: string }[]) => models.filter((m) => m.cli === 'opencode').map((m) => m.model)
  const prior = process.env.EZ_OPENCODE_PROVIDERS
  try {
    process.env.EZ_OPENCODE_PROVIDERS = 'opencode'
    assert.deepEqual(only(await readModels(undefined, async () => true, undefined as never, runner)), ['opencode/a'])
    assert.deepEqual(only(await readModels(undefined, async () => true, undefined as never, runner, undefined, ['opencode-go'])), ['opencode-go/b'])
    assert.deepEqual(only(await readModels(undefined, async () => true, undefined as never, runner, undefined, undefined)), ['opencode/a'])
  } finally {
    if (prior === undefined) delete process.env.EZ_OPENCODE_PROVIDERS
    else process.env.EZ_OPENCODE_PROVIDERS = prior
  }
})

test('opencode model and variant selections validate against the installed catalog', async () => {
  const catalog = [
    { cli: 'opencode', model: 'opencode/ling-free', name: 'Ling Free · opencode/ling-free', efforts: ['low', 'medium'] },
    { cli: 'opencode', model: 'opencode/big-pickle', name: 'Big Pickle · opencode/big-pickle', efforts: [] },
  ]
  const available = async (cli: string) => cli === 'opencode'
  await validateSelection({ id: 'choice', name: 'Ling', cli: 'opencode', model: 'opencode/ling-free', effort: 'low' }, catalog, available)
  await validateSelection({ id: 'default', name: 'Default', cli: 'opencode', model: 'opencode/big-pickle' }, catalog, available)
  await assert.rejects(
    validateSelection({ id: 'bad', name: 'Bad', cli: 'opencode', model: 'opencode/ling-free', effort: 'max' }, catalog, available),
    /installed client catalog/)
  await assert.rejects(
    validateSelection({ id: 'missing', name: 'Missing', cli: 'opencode', model: 'opencode/unknown' }, catalog, available),
    /installed client catalog/)
})
