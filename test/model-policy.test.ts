import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executionDefaults, executionOverrides } from '../src/model-policy.js'
import { startExecutorJob } from '../src/executor.js'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, persistedPreset, readModels, validateSelection } from '../src/ai.js'
import { taskArguments } from '../src/task-executor.js'
import { runCodexSession } from '../src/codex-session.js'
import { runDesktopTurn } from '../src/desktop-bridge.js'

test('all non-Luna model selections and launches reject effort above high before spawning', async () => {
  for (const cli of ['codex', 'codex-gui', 'grok', 'claude', 'opencode', 'agy']) {
    for (const effort of ['xhigh', 'max', 'ultra', 'unknown']) {
      const preset = { id:'blocked', name:'Blocked', cli, model:'any-model', effort }
      await assert.rejects(validateSelection(preset, [], async () => true), /capped at high/)
      await assert.rejects(startExecutorJob([], { cli, effort, runId:'unused', controlDir:'/unused', workspace:'/unused', binDir:'/unused', timeoutMs:1 }), /capped at high/)
    }
  }
  await assert.rejects(runCodexSession({workspace:'/unused',controlDir:'/unused',prompt:'',goal:false,effort:'max'}), /capped at high/)
  await assert.rejects(runDesktopTurn({workspace:'/unused',controlDir:'/unused',binDir:'/unused',runId:'unused',prompt:'',effort:'ultra'}), /capped at high/)
})

test('Codex Luna accepts xhigh and max while every other model and CLI remains capped', async () => {
  for (const effort of ['xhigh', 'max']) {
    const luna = { id:'luna', name:'Luna', cli:'codex', model:'gpt-5.6-luna', effort }
    await validateSelection(luna, [{ cli:'codex', model:'gpt-5.6-luna', name:'Luna', efforts:['high','xhigh','max'] }], async () => true)
    assert.deepEqual(executionDefaults('codex', { model:'gpt-5.6-luna', effort }), { model:'gpt-5.6-luna', effort })
    assert.throws(() => executionDefaults('grok', { model:'gpt-5.6-luna', effort }), /capped at high/)
    assert.throws(() => executionDefaults('codex', { model:'gpt-5.6-terra', effort }), /capped at high/)
  }
})

test('restricted tasks pin Luna max, preserve explicit choices and reject higher effort', () => {
  const args = taskArguments('/unused', ['broker'], 'prompt')
  assert.equal(args[args.indexOf('--model')+1], 'gpt-5.6-luna')
  assert.ok(args.includes('model_reasoning_effort="max"'))
  const custom = taskArguments('/unused', ['broker'], 'prompt', undefined, {model:'custom-model',effort:'low'})
  assert.equal(custom[custom.indexOf('--model')+1], 'custom-model')
  assert.ok(custom.includes('model_reasoning_effort="low"'))
  assert.throws(() => taskArguments('/unused', ['broker'], 'prompt', undefined, {effort:'xhigh'}), /capped at high/)
  assert.deepEqual(executionDefaults('codex', {model:'custom-model',effort:'medium'}), {model:'custom-model',effort:'medium'})
  assert.deepEqual(executionDefaults('codex', {model:'gpt-6-astra'}), {model:'gpt-6-astra',effort:'high'})
  assert.deepEqual(executionDefaults('codex', {model:'gpt-5.6-terra'}), {model:'gpt-5.6-terra',effort:'high'})
  assert.deepEqual(executionDefaults('codex', {model:'gpt-5.6-luna'}), {model:'gpt-5.6-luna',effort:'max'})
  assert.deepEqual(executionDefaults('codex', {}), {model:'gpt-5.6-luna',effort:'max'})
  assert.deepEqual(executionOverrides('codex', {model:'gpt-5.6-luna',effort:'max'}, 'gpt-6-astra'), {model:'gpt-6-astra',effort:'high'})
  assert.deepEqual(executionOverrides('codex', {model:'gpt-5.6-luna',effort:'max'}, 'gpt-5.6-luna'), {model:'gpt-5.6-luna',effort:'max'})
  const stored = persistedPreset({id:'luna',name:'Luna',cli:'codex',model:'gpt-5.6-luna',effort:'max'})
  assert.equal(stored.effort, undefined)
  assert.deepEqual(executionDefaults('codex', stored), {id:'luna',name:'Luna',cli:'codex',model:'gpt-5.6-luna',effort:'max'})
})

test('preset persistence rejects above-high choices without changing current settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-effort-'))
  try {
    const control = new ControlStore(dir, 1000)
    const before = await control.aiState(initialPreset('codex'))
    await assert.rejects(control.savePreset({id:'bad',name:'Bad',cli:'codex',model:'any',effort:'max'}), /capped at high/)
    assert.deepEqual(await control.aiState(initialPreset('codex')), before)
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('non-Codex catalog defaults survive executor normalization and host revalidation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-adapter-defaults-'))
  try {
    const available = async (cli: string) => ['claude', 'opencode', 'agy'].includes(cli)
    const catalog = await readModels(dir, available)
    for (const choice of catalog) {
      const preset = {id:'selected', name:choice.name, cli:choice.cli, model:choice.model}
      await validateSelection(preset, catalog, available)
      const normalized = executionDefaults(choice.cli, preset)
      assert.deepEqual(normalized, preset)
      await validateSelection(normalized, catalog, available)
    }
  } finally { await rm(dir,{recursive:true,force:true}) }
})
