import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ControlStore} from '../src/control-state.js'
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
  assert.notEqual(call('unavailable').status,0)
  assert.deepEqual(await store.status(),state)
 }finally{await rm(root,{recursive:true,force:true})}
})
