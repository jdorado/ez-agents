import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chown, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
import { serveTestLedger } from './helpers/ledger.js'
import { Scheduler } from '../src/scheduler.js'
import { Scripts } from '../src/scripts.js'
import { callDeliverySocket, socketPathFor } from '../src/delivery-socket.js'
const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
test('public scheduler CLI saves literal text, reads back, edits, pauses, and rejects external or finished callers',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedule-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 // The schedule CLI child reaches the relay memory ledger through the socket.
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const control=new ControlStore(dir,1000),runs=new RunStore(dir)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:'',EZ_EXECUTOR_CLI:'grok'}
 await assert.rejects(exec(process.execPath,[bin,'list'],{env}),/Pair an owner/)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const execution=await control.captureChoice(initialPreset('grok'))
 const run=await runs.create({chatId:101,telegramUserId:101,texts:['owner request'],execution})
 await runs.patch(run.id,{status:'running'});env.EZ_RUN_ID=run.id
  const context=JSON.parse((await exec(process.execPath,[bin,'context'],{env})).stdout)
  assert.deepEqual(context.run.texts,['owner request']);assert.equal(context.busyReplies,undefined)
 await assert.rejects(exec(process.execPath,[bin,'context'],{env:{...env,EZ_RUN_ID:''}}),/active owner run/)
 await assert.rejects(exec(process.execPath,[bin,'create','missing-model','--now','--text','Do work'],{env}),/saved explicit model/)
 const args=['create','test','--model','fixture-model','--at','2027-09-09T09:00:00+04:00','--text','Literal $(do-not-execute) /goal objective']
 const saved=JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
 assert.equal(saved.text,args.at(-1));assert.equal(saved.execution.preset.cli,'grok')
 assert.equal(saved.execution.preset.model,'fixture-model');assert.equal(saved.execution.preset.effort,undefined)
 await assert.rejects(exec(process.execPath,[bin,'create','blocked','--at','2027-09-09T09:00:00+04:00','--text','test','--model','gpt-5.6-terra','--effort','bad option'],{env}),/Invalid reasoning effort/)
 const astra=JSON.parse((await exec(process.execPath,[bin,'create','astra','--at','2027-09-09T10:00:00+04:00','--text','Astra task','--model','gpt-6-astra'],{env})).stdout)
 assert.equal(astra.execution.preset.model,'gpt-6-astra');assert.equal(astra.execution.preset.effort,undefined)
 const luna=JSON.parse((await exec(process.execPath,[bin,'create','luna','--at','2027-09-10T09:00:00+04:00','--text','Luna max task','--model','gpt-5.6-luna','--effort','max'],{env})).stdout)
 assert.equal(luna.execution.preset.model,'gpt-5.6-luna');assert.equal(luna.execution.preset.effort,'max')
 assert.equal(saved.nextEligibleAt,'2027-09-09T05:00:00.000Z')
 await assert.rejects(exec(process.execPath,[bin,...args],{env}),/exists/)
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'pause','test'],{env})).stdout).enabled,false)
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'resume','test'],{env})).stdout).enabled,true)
 const resumed=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 await exec(process.execPath,[bin,'edit','test','--expected-revision',resumed.revision,'--model','custom-model','--effort','low','--cron','0 9 * * 2','--timezone','Asia/Dubai','--text','Tuesday'],{env})
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout).text,'Tuesday')
 const explicit=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 assert.equal(explicit.execution.preset.model,'custom-model');assert.equal(explicit.execution.preset.effort,'low')
 await exec(process.execPath,[bin,'edit','test','--expected-revision',explicit.revision,'--cron','0 9 * * 2','--timezone','Asia/Dubai','--text','Tuesday'],{env})
 assert.deepEqual(JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout).execution,explicit.execution)
 const external=await runs.create({chatId:101,telegramUserId:101,texts:[],execution,external:{sourceId:'source',bindingId:'binding',eventIds:['event']}})
 await runs.patch(external.id,{status:'running'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env:{...env,EZ_RUN_ID:external.id}}),/owner-authorized/)
 await assert.rejects(exec(process.execPath,[bin,'context'],{env:{...env,EZ_RUN_ID:external.id}}),/owner-authorized/)
 const task=await runs.create({taskId:'task_'+'a'.repeat(32),chatId:101,telegramUserId:101,texts:[]})
 await runs.patch(task.id,{status:'running'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env:{...env,EZ_RUN_ID:task.id}}),/owner-authorized/)
 const schedule=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 const pending=Date.parse('2027-09-22T05:00:00Z')
 await writeFile(join(dir,'schedules',`test.${schedule.revision}.cursor`),JSON.stringify({next:pending}))
 assert.equal(JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout).nextEligibleAt,new Date(pending).toISOString())
 const interrupted=await runs.create({chatId:101,telegramUserId:101,texts:['old'],execution,scheduled:{id:'test',revision:schedule.revision,dueAt:new Date().toISOString(),pairedAt:schedule.owner.pairedAt}})
 await runs.patch(interrupted.id,{status:'failed',interrupted:true})
 const held=JSON.parse((await exec(process.execPath,[bin,'show','test'],{env})).stdout)
 assert.equal(held.nextEligibleAt,null);assert.deepEqual(held.interruptedRunIds,[interrupted.id])
 await runs.patch(run.id,{status:'completed'})
 await assert.rejects(exec(process.execPath,[bin,'list'],{env}),/owner-authorized/)
})

test('edit keeps a paused agent or script schedule paused and an enabled one enabled',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedule-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const control=new ControlStore(dir,1000),workspace=join(dir,'workspace')
 await control.requestPairing(101,101);await control.approveOwner(101)
 await mkdir(workspace);await writeFile(join(workspace,'guard.mjs'),'')
 await new Scripts(dir).save({id:'guard',owner:(await control.status()).owner!,workspace,entry:'guard.mjs',interpreter:'node',args:[],timeoutSeconds:60},true)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:''}
 const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
 const tasks={agent:(text:string)=>['--model','gpt-6-astra','--text',text],script:(name:string)=>['--script','guard','--name',name]}
 for(const [id,task] of Object.entries(tasks)){
  const created=await cli('create',id,...task('Original'),'--every-seconds','3600')
  await cli('pause',id)
  // Changing only the instructions, even with --now, must not resume or dispatch it.
  const paused=await cli('edit',id,'--expected-revision',created.revision,...task('Changed'),'--now')
  assert.equal(paused.enabled,false);assert.equal(paused.nextEligibleAt,null)
  assert.equal((await cli('show',id)).enabled,false)
  await cli('resume',id)
  assert.equal((await cli('edit',id,'--expected-revision',paused.revision,...task('Again'),'--every-seconds','3600')).enabled,true)
 }
})

test('edit compares the read revision, refuses busy tasks unless staged and needs the relay',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedule-safe-edit-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const control=new ControlStore(dir,1000),runs=new RunStore(dir)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:''}
 const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
 const task=(text:string)=>['--model','gpt-6-astra','--every-seconds','3600','--text',text]
 assert.match((await exec(process.execPath,[bin,'--help'])).stdout,/edit ID --expected-revision REVISION \[--stage\]/)
 await assert.rejects(exec(process.execPath,[bin,'create','daily','--stage',...task('Original')],{env}),/apply to edit only/)
 const created=await cli('create','daily',...task('Original'))
 await assert.rejects(exec(process.execPath,[bin,'edit','daily',...task('Blind')],{env}),/requires --expected-revision/)
 const edited=await cli('edit','daily','--expected-revision',created.revision,...task('Edited'))
 await assert.rejects(exec(process.execPath,[bin,'edit','daily','--expected-revision',created.revision,...task('Stale')],{env}),/changed since revision/)
 const queued=await runs.create({chatId:101,telegramUserId:101,texts:['[schedule]','Edited'],execution:edited.execution,
  scheduled:{id:'daily',revision:edited.revision,dueAt:new Date().toISOString(),pairedAt:edited.owner.pairedAt}})
 await assert.rejects(exec(process.execPath,[bin,'edit','daily','--expected-revision',edited.revision,...task('Busy')],{env}),/queued or running occurrences \(r_/)
 assert.equal((await cli('show','daily')).revision,edited.revision)
 const staged=await cli('edit','daily','--expected-revision',edited.revision,'--stage',...task('Staged'))
 assert.deepEqual(staged.continuingRunIds,[queued.id]);assert.equal(staged.text,'Staged')
 await ledger.stop()
 await assert.rejects(exec(process.execPath,[bin,'edit','daily','--expected-revision',staged.revision,'--stage',...task('Offline')],{env}),/Relay unavailable/)
 assert.equal((await cli('show','daily')).revision,staged.revision)
})

test('a root operator command acts as the control directory owner and cannot follow a planted symlink',{skip:process.geteuid?.()!==0},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedule-root-')),target=await mkdtemp(join(tmpdir(),'ez-root-target-')),runtime=20000
 t.after(()=>Promise.all([rm(dir,{recursive:true,force:true}),rm(target,{recursive:true,force:true})]))
 const control=new ControlStore(dir,1000);await control.requestPairing(101,101);await control.approveOwner(101)
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const workspace=join(dir,'workspace');await mkdir(workspace);await writeFile(join(workspace,'guard.mjs'),'')
 // The runtime user owns its control directory, as the container entrypoint provisions it.
 await chown(dir,runtime,runtime);for(const name of await readdir(dir))await chown(join(dir,name),runtime,runtime)
 await chown(join(workspace,'guard.mjs'),runtime,runtime)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:'',EZ_AGENT_WORKSPACE:workspace}
 const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[bin,...args],{env,cwd:workspace})).stdout)
 const task=['--model','gpt-6-astra','--every-seconds','3600','--text','Root operator']
 const created=await cli('create','daily',...task)
 const edited=await cli('edit','daily','--expected-revision',created.revision,...task)
 await cli('script','register','guard','--file','guard.mjs','--interpreter','node')
 for(const path of ['schedules','schedules/daily.json',`schedules/daily.${edited.revision}.cursor`,'scripts/guard.json'])
  assert.equal((await stat(join(dir,path))).uid,runtime,path)
 // An agent can replace its own control subdirectory; root must not write through it.
 await rm(join(dir,'schedules'),{recursive:true});await symlink(target,join(dir,'schedules'))
 await assert.rejects(exec(process.execPath,[bin,'create','other',...task],{env}),/EACCES|permission denied/)
 assert.deepEqual(await readdir(target),[]);assert.equal((await stat(target)).uid,0)
})

test('executor PATH exposes the extensionless scheduler command',async()=>{
 const command=fileURLToPath(new URL('../bin/ezenciel-agents-schedule',import.meta.url))
  assert.match((await exec(command,['--help'])).stdout,/Creates a scheduled task/)
})

test('trigger uses saved task settings after a chat switch, preserves cadence and reconciles its request key',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-trigger-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const owner=(await control.status()).owner!
 const execution={sessionId:crypto.randomUUID(),preset:{id:'task',name:'Saved task',cli:'codex',model:'gpt-6-astra',effort:'medium'}}
 const saved=await scheduler.save({id:'daily',name:'Daily',text:'Literal /goal task',owner,execution,enabled:true,trigger:{cron:'5 7 * * 1-5',timezone:'America/New_York',start:'2027-01-01T00:00:00Z'}},true)
 const next=await scheduler.pendingOccurrence(saved)
 const chat=await control.captureChoice({...initialPreset('codex'),model:'fixture-model'})
 await control.savePreset({id:'chat',name:'Chat',cli:'codex',model:'gpt-6-luna',effort:'max'})
 await control.selectPreset('chat',chat.sessionId)
 assert.equal((await control.status()).ai?.selectedId,'chat')
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:''}
 const args=[bin,'trigger','daily','--key','smoke-1']
 const first=JSON.parse((await exec(process.execPath,args,{env})).stdout)
 assert.equal(first.status,'queued');assert.deepEqual(first.execution.preset,execution.preset)
 assert.notEqual(first.execution.sessionId,execution.sessionId)
 assert.equal(first.scheduled.id,saved.id);assert.equal(first.scheduled.revision,saved.revision)
 assert.equal(first.texts[1],saved.text)
 assert.deepEqual(await scheduler.get('daily'),saved);assert.equal(await scheduler.pendingOccurrence(saved),next)
 const retry=JSON.parse((await exec(process.execPath,args,{env})).stdout)
 assert.equal(retry.id,first.id);assert.equal((await runs.list()).length,1)
 await assert.rejects(exec(process.execPath,[bin,'trigger','daily','--key','different'],{env}),/queued or running/)
 await assert.rejects(exec(process.execPath,[...args,'--model','gpt-6-luna'],{env}),/overrides are not allowed/)
 await runs.patch(first.id,{status:'completed'})
 const parallel=await Promise.allSettled(['smoke-2','smoke-3'].map(key=>callDeliverySocket(socketPathFor(dir),{op:'triggerSchedule',payload:{scheduleId:'daily',revision:saved.revision,key}})))
 assert.equal(parallel.filter(r=>r.status==='fulfilled').length,1,'concurrent trigger keys cannot overlap')
 for(const run of await runs.list())await runs.patch(run.id,{status:'completed'})
 const restricted=await runs.create({chatId:101,telegramUserId:101,texts:[],execution,external:{sourceId:'source',bindingId:'binding',eventIds:['event']}})
 await runs.patch(restricted.id,{status:'running'})
 await assert.rejects(callDeliverySocket(socketPathFor(dir),{op:'triggerSchedule',payload:{scheduleId:'daily',revision:saved.revision,key:'restricted',callerRunId:restricted.id}}),/blocked/)
 await assert.rejects(callDeliverySocket(socketPathFor(dir),{op:'triggerSchedule',payload:{scheduleId:'daily',revision:'stale',key:'stale'}}),/changed/)
 await assert.rejects(exec(process.execPath,[bin,'trigger','daily','--key','../bad'],{env}),/Invalid record identifier/)
 await scheduler.enable('daily',false)
 await assert.rejects(exec(process.execPath,[bin,'trigger','daily','--key','paused'],{env}),/disabled/)
 await scheduler.enable('daily',true)
 await control.revokeOwner();await control.requestPairing(202,202);await control.approveOwner(202)
 await assert.rejects(exec(process.execPath,[bin,'trigger','daily','--key','wrong-owner'],{env}),/ownership mismatch/)
})


test('deferred literal input retains owner-scoped conversation through source metadata',async t=>{
 const {Scheduler}=await import('../src/scheduler.js')
 const dir=await mkdtemp(join(tmpdir(),'ez-origin-context-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
 const control=new ControlStore(dir,1000),runs=new RunStore(dir)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const execution=await control.captureChoice({...initialPreset('codex'),model:'fixture-model'})
 await runs.create({id:'tg_1',chatId:101,telegramUserId:101,texts:['Use the blue ledger'],execution})
 await runs.patch('tg_1',{status:'completed'})
 await runs.create({id:'tg_2',chatId:101,telegramUserId:101,texts:['Do the same for March'],execution})
 await runs.patch('tg_2',{status:'running',replyOnly:true})
 await new Scheduler(dir).save({id:'legacy-deferred',name:'Owner request',text:'Do the same for March',originRunId:'tg_2',owner:(await control.status()).owner!,execution,enabled:true,trigger:{at:new Date(Date.now()+1000).toISOString()}},true)
 await new Scheduler(dir).tick((await control.status()).owner!,runs,Date.now()+2000)
 const worker=(await runs.list()).find(r=>r.scheduled)!
  assert.match(worker.texts[0],/^\[schedule legacy-deferred due .+\]$/);assert.equal(worker.texts[1],'Do the same for March');assert.equal(worker.scheduled?.originRunId,'tg_2')
 await runs.patch(worker.id,{status:'running'})
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:worker.id}
  const result=JSON.parse((await exec(process.execPath,[bin,'context'],{env})).stdout)
  assert.equal(result.run.texts[1],'Do the same for March')
  assert.equal(result.origin.id,'tg_2')
 await runs.create({id:'other',chatId:999,telegramUserId:999,texts:['PRIVATE OTHER OWNER']})
 const tampered=await runs.create({id:'tg_tampered',chatId:101,telegramUserId:101,texts:worker.texts,execution,scheduled:{...worker.scheduled!,originRunId:'other'}})
 await runs.patch(tampered.id,{status:'running'})
 await assert.rejects(exec(process.execPath,[bin,'context'],{env:{...env,EZ_RUN_ID:tampered.id}}),/outside this owner binding/)
})
