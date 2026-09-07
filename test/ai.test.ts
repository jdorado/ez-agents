import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, readModels, isPreset } from '../src/ai.js'
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
      { slug: 'hidden-model', visibility: 'hide' },
    ] }))
    assert.deepEqual(await readModels(home, async (cli) => cli === 'codex'), [
      { cli: 'codex', model: 'fixture-model', name: 'Fixture', efforts: ['medium'] },
    ])
    assert.equal(isPreset({ id: 'x', name: 'x', cli: 'grok', model: '--shell escape' }), false)
  } finally { await rm(home, { recursive: true, force: true }) }
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
