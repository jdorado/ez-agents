import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ControlStore} from '../src/control-state.js'
import {executorJobEnv} from '../src/executor.js'
import {initialPreset} from '../src/ai.js'
import {randomBytes} from 'node:crypto'
import {ApplicationChannel,applicationScope} from '../src/application-channel.js'
import {createAiMenu} from '../src/menu.js'
import {RunStore} from '../src/runs.js'
import {serveDeliverySocket} from '../src/delivery-socket.js'

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
  const {EZ_RUN_ID:_owner,...env}=executorJobEnv({runId:'fixture',controlDir,binDir,catalogTransport:'host'},{...process.env,HOME:root,PATH:binDir+path.delimiter+process.env.PATH,OPENROUTER_API_KEY:'must-not-persist'})
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

test('inside a Slack channel turn the agent switches that channel only, from its next message',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-ai-self-switch-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const controlDir=path.join(root,'control')
 await mkdir(path.join(controlDir,'host-executor'),{recursive:true})
 const models=[{cli:'codex',model:'fixture-model',name:'Fixture',efforts:['low','high']}]
 await writeFile(path.join(controlDir,'host-executor','models.json'),JSON.stringify(models))
 const control=new ControlStore(controlDir,1000)
 await control.requestPairing(42,42);const owner=await control.approveOwner(42)
 const menu=createAiMenu(control,'codex',async()=>models,root,undefined,async()=>true)
 const channel=new ApplicationChannel({controlDir,initial:menu.initial,aiControls:menu,wake:()=>{},cancel:async()=>{}})
 t.after(()=>channel.stop())
 const binding=(await channel.bindings.register('slack',randomBytes(32).toString('base64url'),owner))!
 const shared=await control.captureChoice(menu.initial)
 const before=await control.status()
 const run=await channel.submit(binding.bindingId,{requestId:'switch-me',scope:'C123',text:'use fixture high'})
 const runs=new RunStore(controlDir);await runs.patch(run.id,{status:'running'})
 const relay=await serveDeliverySocket(controlDir,async op=>op.op==='get' ? runs.get(op.payload.runId) : null)
 t.after(()=>relay.stop())
 const bin=fileURLToPath(new URL('../bin/ezenciel-agents-ai.mjs',import.meta.url))
 const binDir=path.join(root,'bin');await mkdir(binDir)
 await writeFile(path.join(binDir,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
 const env={...process.env,HOME:root,PATH:binDir,EZ_CONTROL_DIR:controlDir,EZ_AI_CATALOG:'host',EZ_RUN_ID:run.id}
 // The stub relay lives in this process, so the CLI must not block its event loop.
 const run$=(effort:string)=>new Promise<{status:number|null;stdout:string;stderr:string}>(resolve=>{
  const child=spawn(process.execPath,[bin,'select','--cli','codex','--model','fixture-model','--effort',effort],{env});let stdout='',stderr=''
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',status=>resolve({status,stdout,stderr}))})
 const result=await run$('high')
 assert.equal(result.status,0,result.stderr)
 assert.equal(JSON.parse(result.stdout).conversation,'kept')
 const scoped=await control.applicationSession(applicationScope(binding.bindingId,'C123'))
 assert.equal(scoped?.sessionId,run.execution!.sessionId)
 assert.equal(scoped?.preset?.model,'fixture-model');assert.equal(scoped?.preset?.effort,'high')
 const after=await control.status()
 assert.equal(after.activeSession?.sessionId,shared.sessionId)
 assert.equal(after.ai?.selectedId,before.ai?.selectedId)
 const next=await channel.submit(binding.bindingId,{requestId:'next',scope:'C123',text:'next'})
 assert.equal(next.execution!.preset.effort,'high')
 await runs.patch(run.id,{status:'completed'})
 assert.notEqual((await run$('low')).status,0)
})
