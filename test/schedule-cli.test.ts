import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
test('public scheduler CLI saves literal text, reads back, edits, pauses, and rejects external or finished callers',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedule-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const control=new ControlStore(dir,1000),runs=new RunStore(dir)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:'',EZ_EXECUTOR_CLI:'grok'}
 await assert.rejects(exec(process.execPath,[bin,'list'],{env}),/Pair an owner/)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const execution=await control.captureChoice(initialPreset('grok'))
 const run=await runs.create({chatId:101,telegramUserId:101,texts:['owner request'],execution})
 await runs.patch(run.id,{status:'running'});env.EZ_RUN_ID=run.id
 const context=JSON.parse((await exec(process.execPath,[bin,'context'],{env})).stdout)
 assert.deepEqual(context.run.texts,['owner request']);assert.deepEqual(context.busyReplies,[])
 await assert.rejects(exec(process.execPath,[bin,'context'],{env:{...env,EZ_RUN_ID:''}}),/active owner run/)
 const args=['create','test','--at','2027-09-09T09:00:00+04:00','--text','Literal $(do-not-execute) /goal objective']
 const saved=JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
 assert.equal(saved.text,args.at(-1));assert.equal(saved.execution.preset.cli,'grok')
 assert.equal(saved.execution.preset.model,undefined);assert.equal(saved.execution.preset.effort,undefined)
 await assert.rejects(exec(process.execPath,[bin,'create','blocked','--at','2027-09-09T09:00:00+04:00','--text','test','--model','gpt-5.6-terra','--effort','bad option'],{env}),/Invalid reasoning effort/)
 const astra=JSON.parse((await exec(process.execPath,[bin,'create','astra','--at','2027-09-09T10:00:00+04:00','--text','Astra task','--model','gpt-6-astra'],{env})).stdout)
 assert.equal(astra.execution.preset.model,'gpt-6-astra');assert.equal(astra.execution.preset.effort,undefined)
 const luna=JSON.parse((await exec(process.execPath,[bin,'create','luna','--at','2027-09-10T09:00:00+04:00','--text','Luna max task','--model','gpt-5.6-luna','--effort','max'],{env})).stdout)
 assert.equal(luna.execution.preset.model,'gpt-5.6-luna');assert.equal(luna.execution.preset.effort,'max')
 assert.equal(saved.nextEligibleAt,'2027-09-09T05:00:00.000Z')
 await assert.rejects(exec(process.execPath,[bin,...args],{env}),/exists/)
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'pause','test'],{env})).stdout).enabled,false)
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'resume','test'],{env})).stdout).enabled,true)
 await exec(process.execPath,[bin,'edit','test','--model','custom-model','--effort','low','--cron','0 9 * * 2','--timezone','Asia/Dubai','--text','Tuesday'],{env})
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout).text,'Tuesday')
 const explicit=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 assert.equal(explicit.execution.preset.model,'custom-model');assert.equal(explicit.execution.preset.effort,'low')
 await exec(process.execPath,[bin,'edit','test','--cron','0 9 * * 2','--timezone','Asia/Dubai','--text','Tuesday'],{env})
 assert.deepEqual(JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout).execution,explicit.execution)
 const external=await runs.create({chatId:101,telegramUserId:101,texts:[],execution,external:{sourceId:'source',bindingId:'binding',eventIds:['event']}})
 await runs.patch(external.id,{status:'running'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env:{...env,EZ_RUN_ID:external.id}}),/owner-authorized/)
 await assert.rejects(exec(process.execPath,[bin,'context'],{env:{...env,EZ_RUN_ID:external.id}}),/owner-authorized/)
 const task=await runs.create({taskId:'task_'+'a'.repeat(32),chatId:101,telegramUserId:101,texts:[]})
 await runs.patch(task.id,{status:'running'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env:{...env,EZ_RUN_ID:task.id}}),/owner-authorized/)
 const schedule=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 const interrupted=await runs.create({chatId:101,telegramUserId:101,texts:['old'],execution,scheduled:{id:'test',revision:schedule.revision,dueAt:new Date().toISOString(),pairedAt:schedule.owner.pairedAt}})
 await runs.patch(interrupted.id,{status:'failed',interrupted:true})
 const held=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 assert.equal(held.nextEligibleAt,null);assert.deepEqual(held.interruptedRunIds,[interrupted.id])
 await runs.patch(run.id,{status:'completed'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env}),/owner-authorized/)
})

test('executor PATH exposes the extensionless scheduler command',async()=>{
 const command=fileURLToPath(new URL('../bin/ezenciel-agents-schedule',import.meta.url))
 assert.match((await exec(command,['--help'])).stdout,/durable, asynchronous CLI task/)
})


test('deferred literal input retains owner-scoped conversation through source metadata',async t=>{
 const {Scheduler}=await import('../src/scheduler.js')
 const dir=await mkdtemp(join(tmpdir(),'ez-origin-context-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const control=new ControlStore(dir,1000),runs=new RunStore(dir)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const execution=await control.captureChoice(initialPreset('codex'))
 await runs.create({id:'tg_1',chatId:101,telegramUserId:101,texts:['Use the blue ledger'],execution})
 await runs.patch('tg_1',{status:'completed'})
 await runs.create({id:'tg_2',chatId:101,telegramUserId:101,texts:['Do the same for March'],execution})
 await runs.patch('tg_2',{status:'running',replyOnly:true})
 await new Scheduler(dir).save({id:'legacy-deferred',name:'Owner request',text:'Do the same for March',originRunId:'tg_2',owner:(await control.status()).owner!,execution,enabled:true,trigger:{at:new Date().toISOString()}},true)
 await new Scheduler(dir).tick((await control.status()).owner!,runs,Date.now()+2000)
 const worker=(await runs.list()).find(r=>r.scheduled)!
 assert.deepEqual(worker.texts,['Do the same for March']);assert.equal(worker.scheduled?.originRunId,'tg_2')
 await runs.patch(worker.id,{status:'running'})
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:worker.id}
 const result=JSON.parse((await exec(process.execPath,[bin,'context'],{env})).stdout)
 assert.ok(result.origin.recent.some((r:any)=>r.texts==='Use the blue ledger'))
 await runs.create({id:'other',chatId:999,telegramUserId:999,texts:['PRIVATE OTHER OWNER']})
 const {writeFile}=await import('node:fs/promises')
 await writeFile(join(dir,'runs',worker.id+'.json'),JSON.stringify({...worker,status:'running',scheduled:{...worker.scheduled,originRunId:'other'}}))
 await assert.rejects(exec(process.execPath,[bin,'context'],{env}),/outside this owner binding/)
})
