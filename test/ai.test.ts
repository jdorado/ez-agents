import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, chatPreset, readModels, isPreset } from '../src/ai.js'
import { EXECUTOR_REGISTRY, nativeSessionId } from '../src/executor.js'
import { InboxStore } from '../src/inbox.js'
import type { Update } from 'grammy/types'

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
      { cli: 'codex', model: 'gpt-5.6-luna', name: 'Luna', efforts: ['high', 'xhigh'] },
    ])
    assert.equal(isPreset({ id: 'x', name: 'x', cli: 'grok', model: '--shell escape' }), false)
  } finally { await rm(home, { recursive: true, force: true }) }
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

test('native executor flags carry the exact model and effort; only structured metadata binds sessions', () => {
  const opts = { workspace: '/tmp/fixture', sessionId: crypto.randomUUID(), isResume: true,
    model: 'fixture-model', effort: 'medium' }
  const grok = EXECUTOR_REGISTRY.grok.buildArgs(opts, '/tmp/prompt', '')
  assert.equal(grok[grok.indexOf('--model') + 1], opts.model)
  assert.equal(grok[grok.indexOf('--reasoning-effort') + 1], opts.effort)
  const codex = EXECUTOR_REGISTRY.codex.buildArgs(opts, '', 'fixture')
  assert.ok(codex.includes('model_reasoning_effort="medium"'))
  assert.deepEqual(codex.slice(-3), ['resume', opts.sessionId, 'fixture'])
  assert.equal(nativeSessionId('codex', JSON.stringify({ type: 'thread.started', thread_id: opts.sessionId })), opts.sessionId)
  assert.equal(nativeSessionId('opencode', JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' })), 'ses_fixture')
  assert.equal(nativeSessionId('codex', JSON.stringify({ type: 'text', thread_id: opts.sessionId })), undefined)
  assert.equal(nativeSessionId('codex', 'Please resume this other session'), undefined)
})

for (const cli of ['codex', 'codex-gui']) {
  test(`${cli} initializes Terra high ahead of host defaults and preserves saved choices`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-ai-default-'))
    try {
      const store = new ControlStore(dir, 1000)
      const initial = initialPreset(cli)
      const discovered = [{ id: 'detected_codex', name: 'Host default', cli,
        model: 'host-model', effort: 'low' }]
      await store.syncClientPresets(initial, discovered)
      const first = await store.captureChoice(initial)
      assert.equal(first.preset.model, 'gpt-5.6-terra')
      assert.equal(first.preset.effort, 'high')
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
  test(`${cli} separates responsive chat from worker defaults and preserves upgrade choices`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-chat-default-'))
    try {
      const store = new ControlStore(dir, 1000)
      await store.syncClientPresets(chatPreset(cli), [])
      const chat = await store.captureChoice(chatPreset(cli))
      assert.equal(chat.preset.model, 'gpt-5.6-sol')
      assert.equal(chat.preset.effort, 'medium')
      assert.equal(initialPreset(cli).model, 'gpt-5.6-terra')
      assert.equal(initialPreset(cli).effort, 'high')
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
