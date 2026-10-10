import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ControlStore} from '../src/control-state.js'
import {executorJobEnv} from '../src/executor.js'
import {initialPreset} from '../src/ai.js'

test('explicit CLI/model selection preserves installation default and rejects unavailable choices',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-ai-cli-'))
 try{
  const controlDir=path.join(root,'control')
  await mkdir(path.join(controlDir,'cli','codex'),{recursive:true});await mkdir(path.join(root,'bin'))
  await writeFile(path.join(root,'bin/codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
  await writeFile(path.join(controlDir,'cli','codex','models_cache.json'),JSON.stringify({models:[{slug:'test-model',visibility:'list',supported_reasoning_levels:[{effort:'high'}]}]}))
  const store=new ControlStore(controlDir,900000);await store.aiState(initialPreset('grok'))
  const env={...process.env,HOME:root,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,EZ_CONTROL_DIR:controlDir}
  const bin=fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs',import.meta.url))
  const call=(model:string)=>spawnSync(process.execPath,[bin,'select','--cli','codex','--model',model,'--effort','high'],{env,encoding:'utf8'})
  const result=call('test-model');assert.equal(result.status,0,result.stderr)
  const state=await store.status();assert.equal(state.ai?.defaultId,'initial')
  assert.equal(state.ai?.presets.find(p=>p.id===state.ai?.selectedId)?.cli,'codex')
  assert.equal(state.activeSession?.cli,'codex')
  const setDefault=spawnSync(process.execPath,[bin,'default'],{env,encoding:'utf8'})
  assert.equal(setDefault.status,0,setDefault.stderr)
  const updated=await store.status()
  assert.equal(updated.ai?.defaultId,updated.ai?.selectedId)
  assert.equal(updated.activeSession?.sessionId,state.activeSession?.sessionId)
  assert.notEqual(call('unavailable').status,0)
  assert.deepEqual(await store.status(),updated)
 }finally{await rm(root,{recursive:true,force:true})}
})


test('AI help is available without a bound control directory or installed engines',()=>{
 const bin=fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs',import.meta.url))
 const {EZ_CONTROL_DIR,...env}=process.env
 const result=spawnSync(process.execPath,[bin,'--help'],{env:{...env,PATH:''},encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
 assert.match(result.stdout,/select --cli/)
})

test('an agent can select a declared provider and model without putting the key in control state',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-ai-provider-'))
 try{
  const controlDir=path.join(root,'control'),binDir=path.join(root,'bin')
  await mkdir(path.join(controlDir,'host-executor'),{recursive:true});await mkdir(binDir)
  await writeFile(path.join(binDir,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
  await writeFile(path.join(controlDir,'host-executor','models.json'),JSON.stringify([{cli:'codex',provider:'openrouter',model:'google/gemini-3.8-flash',name:'Gemini',efforts:[]}]))
  const store=new ControlStore(controlDir,900000);await store.aiState(initialPreset('codex'))
  const env=executorJobEnv({runId:'fixture',controlDir,binDir,catalogTransport:'host'},{...process.env,HOME:root,PATH:binDir+path.delimiter+process.env.PATH,OPENROUTER_API_KEY:'must-not-persist'})
  const bin=fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs',import.meta.url))
  const result=spawnSync(process.execPath,[bin,'select','--cli','codex','--provider','openrouter','--model','google/gemini-3.8-flash'],{env,encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const state=await store.status(),selected=state.ai?.presets.find(p=>p.id===state.ai?.selectedId)
  assert.equal(selected?.provider,'openrouter');assert.equal(selected?.model,'google/gemini-3.8-flash')
  assert.equal(JSON.stringify(state).includes('must-not-persist'),false)
  assert.equal(env.EZ_EXECUTOR_TRANSPORT,undefined)
  assert.equal(env.EZ_ISOLATION,undefined)
 }finally{await rm(root,{recursive:true,force:true})}
})


test('isolated AI CLI ignores a legacy host catalog and discovers its own Sonnet',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-ai-local-catalog-'))
 try{
  const controlDir=path.join(root,'control'),binDir=path.join(root,'bin')
  await mkdir(path.join(controlDir,'host-executor'),{recursive:true});await mkdir(binDir)
  const stale=JSON.stringify([{cli:'codex',model:'host-only',name:'Host only',efforts:[]}])
  await writeFile(path.join(controlDir,'host-executor','models.json'),stale)
  await writeFile(path.join(binDir,'claude'),"#!/bin/sh\nprintf '%s\n' \"  --model <model> Model (e.g. 'sonnet', 'opus')\" \"  --effort <level> Effort (low, high)\"\n",{mode:0o700})
  const env={...process.env,HOME:root,PATH:binDir,EZ_CONTROL_DIR:controlDir,EZ_ISOLATION:'isolated',EZ_EXECUTOR_TRANSPORT:'local'}
  const bin=fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs',import.meta.url))
  const result=spawnSync(process.execPath,[bin,'list'],{env,encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  const catalog=JSON.parse(result.stdout)
  assert.ok(catalog.some((m:{cli:string;model:string})=>m.cli==='claude'&&m.model==='sonnet'))
  assert.ok(!catalog.some((m:{model:string})=>m.model==='host-only'))
 }finally{await rm(root,{recursive:true,force:true})}
})
