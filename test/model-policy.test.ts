import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executionDefaults } from '../src/model-policy.js'
import { startExecutorJob } from '../src/executor.js'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, readModels, validateSelection } from '../src/ai.js'
import { taskArguments } from '../src/task-executor.js'
import { runCodexSession } from '../src/codex-session.js'
import { runDesktopTurn } from '../src/desktop-bridge.js'

test('all model selections and launches reject effort above high before spawning', async () => {
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

test('restricted tasks pin Terra high, preserve explicit choices and reject higher effort', () => {
  const args = taskArguments('/unused', ['broker'], 'prompt')
  assert.equal(args[args.indexOf('--model')+1], 'gpt-5.6-terra')
  assert.ok(args.includes('model_reasoning_effort="high"'))
  const custom = taskArguments('/unused', ['broker'], 'prompt', undefined, {model:'custom-model',effort:'low'})
  assert.equal(custom[custom.indexOf('--model')+1], 'custom-model')
  assert.ok(custom.includes('model_reasoning_effort="low"'))
  assert.throws(() => taskArguments('/unused', ['broker'], 'prompt', undefined, {effort:'xhigh'}), /capped at high/)
  assert.deepEqual(executionDefaults('codex', {model:'custom-model',effort:'medium'}), {model:'custom-model',effort:'medium'})
  assert.deepEqual(executionDefaults('codex', {}), {model:'gpt-5.6-terra',effort:'high'})
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
