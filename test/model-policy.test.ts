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

test('engine defaults stay omitted and explicit native settings survive every adapter', async () => {
 for(const cli of ['codex','codex-gui','grok','claude','opencode','agy']) {
  assert.deepEqual(executionDefaults(cli,{}),{})
  const preset={id:'chosen',name:'Chosen',cli,model:'native-model',effort:'ultra'}
  assert.deepEqual(executionDefaults(cli,preset),preset)
  await validateSelection(preset,[{cli,model:'native-model',name:'Native',efforts:['ultra']}],async()=>true)
  await assert.rejects(validateSelection({...preset,effort:'unsupported'},[{cli,model:'native-model',name:'Native',efforts:['ultra']}],async()=>true),/installed client catalog/)
  assert.throws(()=>executionDefaults(cli,{effort:'bad option'}),/Invalid reasoning effort/)
 }
 assert.deepEqual(executionOverrides('codex',{model:'old',effort:'max'},'new'),{model:'new',effort:undefined})
 const saved={id:'saved',name:'Saved',cli:'codex',model:'chosen',effort:'max'}
 assert.deepEqual(persistedPreset(saved),saved)
 const args=taskArguments('/unused',['broker'],'--literal')
 assert.equal(args.at(-1),'-');assert(!args.includes('--model'));assert(!args.some(s=>s.includes('model_reasoning_effort')))
 const explicit=taskArguments('/unused',['broker'],'text',undefined,saved)
 assert(explicit.includes('chosen'));assert(explicit.includes('model_reasoning_effort="max"'))
})

test('invalid setting syntax never mutates a saved choice', async () => {
 const dir=await mkdtemp(join(tmpdir(),'ez-native-setting-'))
 try {
  const control=new ControlStore(dir,1000),before=await control.aiState(initialPreset('codex'))
  await assert.rejects(control.savePreset({id:'bad',name:'Bad',cli:'codex',effort:'bad option'}),/Invalid AI preset/)
  assert.deepEqual(await control.aiState(initialPreset('codex')),before)
 }finally{await rm(dir,{recursive:true,force:true})}
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
