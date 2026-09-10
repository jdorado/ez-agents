import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { redactFailure, failureStamp, needsFailureReview } from '../src/failure.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'
import { Scheduler } from '../src/scheduler.js'
import { initialPreset } from '../src/ai.js'
import { createRelay } from '../src/index.js'
import { TelegramSource } from '../src/telegram-source.js'
import { packageVersion } from '../src/version.js'
import type { Update } from 'grammy/types'
const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
const until=async(check:()=>Promise<boolean>)=>{for(let n=0;n<200;n++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}

test('failure evidence is bounded and redacts configured credentials, headers, tokens, URLs and keys',()=>{
 const token='123456789:abcdefghijklmnopqrstuvwxyz123456789'
 const text=redactFailure('x'.repeat(5000)+'\nMissing input\nAuthorization: Bearer sensitive123\n{"api_key":"api-credential"}\npassword=private123\nhttps://alice:pass@example.com/file?token=abc#secret\nhttps://api.telegram.org/bot'+token+'/sendMessage\nCustomSecret\nsk-abcdefghijk\neyJabc.def.ghi\n-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----',['CustomSecret'])
 for(const value of ['sensitive123','api-credential','private123','alice','pass@','token=abc',token,'CustomSecret','sk-abcdefghijk','eyJabc.def.ghi','ABC'])assert.ok(!text.includes(value),value)
 assert.ok(text.includes('Missing input'));assert.ok(text.length<=4096)
})

test('failure review CLI is owner-bound, rejects stale reviews, and keeps failure evidence immutable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-failure-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const runs=new RunStore(dir),control=new ControlStore(dir,1000)
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_EXECUTOR_CLI:'grok',EZ_RUN_ID:''}
 const cli=(args:string[],overrides={})=>exec(process.execPath,[bin,...args],{env:{...env,...overrides}})
 await assert.rejects(cli(['failures']),/Pair an owner/)
 await control.requestPairing(101,101);await control.approveOwner(101)
 const execution=await control.captureChoice(initialPreset('grok'))
 await runs.create({id:'r_failed',chatId:101,telegramUserId:101,texts:['test'],execution})
 await runs.patch('r_failed',{status:'failed',endedAt:'2026-09-10T07:00:00.000Z',exitCode:7,failureReason:'executor-exit'})
 await runs.create({id:'r_other',chatId:202,telegramUserId:202,texts:['private']});await runs.patch('r_other',{status:'failed'})
 const failures=JSON.parse((await cli(['failures'])).stdout)
 assert.deepEqual(failures.runs.map((r:any)=>r.id),['r_failed'])
 assert.equal(failures.runs[0].failure.relayVersion,packageVersion)
 const review=['review','r_failed','--failed-at','2026-09-10T07:00:00.000Z','--status','resolved','--diagnosis','Missing input','--recovery','Created fixture','--outcome','Check exited zero']
 const stale=[...review];stale[3]='2026-09-10T06:00:00Z';await assert.rejects(cli(stale),/Failure changed/)
 await assert.rejects(cli(['run','r_other']),/Unknown owner/)
 await assert.rejects(cli(['run','../escape']),/Invalid/)
 await cli(review)
 assert.equal(JSON.parse((await cli(['failures'])).stdout).total,0)
 const record=JSON.parse((await cli(['run','r_failed'])).stdout)
 assert.equal(record.status,'failed');assert.equal(record.exitCode,7);assert.equal(record.failureReview.status,'resolved')
 assert.equal(JSON.parse((await cli(['failures','--all'])).stdout).total,1)
 await runs.patch('r_failed',{status:'failed',endedAt:'2026-09-10T08:00:00.000Z'})
 assert.equal(JSON.parse((await cli(['failures'])).stdout).total,1)
 for(const [id,extra] of [['r_external',{external:{sourceId:'s',bindingId:'b',eventIds:['e']}}],['r_task',{taskId:'task_'+'a'.repeat(32)}],['tg_1',{replyOnly:true}]] as const){
  await runs.create({id,chatId:101,telegramUserId:101,texts:['test'],...('taskId' in extra?{taskId:extra.taskId}:{}),...('external' in extra?{external:{...extra.external,eventIds:[...extra.external.eventIds]}}:{})})
  await runs.patch(id,{status:'running',...('replyOnly' in extra?{replyOnly:true}:{})})
  await assert.rejects(cli(review,{EZ_RUN_ID:id}),/owner-authorized/)
 }
 await writeFile(join(dir,'runs','r_bad.json'),'{broken')
 assert.equal(JSON.parse((await cli(['failures'])).stdout).total,1)
})

test('failure capture, diagnosis, verified recovery and conditional quiet next tick through real CLI and relay',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-failure-loop-')),runs=new RunStore(dir),control=new ControlStore(dir,1000),scheduler=new Scheduler(dir)
 const replies:string[]=[],children:ReturnType<typeof spawn>[]=[],fixture=join(dir,'fixture.txt')
 let reviews=0
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture-token'},async(_texts,options)=>{
  const scheduled=options.runId.startsWith('r_schedule_')
  if(scheduled){
   reviews++
   const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:options.runId,EZ_EXECUTOR_CLI:'grok'}
   const pending=JSON.parse((await exec(process.execPath,[bin,'failures'],{env})).stdout)
   assert.equal(pending.total,1);assert.match(pending.runs[0].failure.error,/Missing fixture/)
   await writeFile(fixture,'ready')
   await exec(process.execPath,['-e',`if(require('fs').readFileSync(process.argv[1],'utf8')!=='ready')process.exit(9)`,fixture])
   await runs.enqueueMessage(options.runId,'Fixture recovery verified')
   await exec(process.execPath,[bin,'review',pending.runs[0].id,'--failed-at',pending.runs[0].failedAt,'--status','resolved','--diagnosis','Missing fixture','--recovery','Created expected fixture','--outcome','Independent check exited zero'],{env})
  }
  const child=spawn(process.execPath,['-e',scheduled?'setTimeout(()=>{},30)':`setTimeout(()=>{console.error('Missing fixture; authorization: Bearer secret-value');process.exit(7)},30)`],{stdio:['pipe','pipe','pipe'],detached:true})
  children.push(child);await once(child,'spawn');return {child,cleanup:async()=>{if(options.runId==='tg_11')throw new Error('Cleanup after stop')},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
 relay.bot.api.config.use(async(_p,method,payload)=>{if(method==='sendMessage')replies.push((payload as any).text);return {ok:true,result:{message_id:replies.length}} as any})
 const originalPatch=RunStore.prototype.patch
 t.mock.method(RunStore.prototype,'patch',async function(this:RunStore,...args:Parameters<RunStore['patch']>){
  // Hold the PID write until the fast child has closed, reproducing slow disk
  // without a timer or depending on runner load. Stderr must already be captured.
  if(args[0]==='tg_10' && args[1].pid && children[0].exitCode===null) await once(children[0],'close')
  return originalPatch.apply(this,args)
 })
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,execution=await control.captureChoice(initialPreset('grok')),start=Date.now()+2000
  await scheduler.save({id:'review',name:'Review failures',text:'Review failures',trigger:{everySeconds:60,start:new Date(start).toISOString()},when:'unreviewed-failures',enabled:true,owner,execution})
  await scheduler.tick(owner,runs,start)
  assert.equal((await runs.list()).length,0,'no model job for an empty inbox')
  const update:Update={update_id:10,message:{message_id:10,date:0,text:'Run fixture',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}}
  await relay.bot.handleUpdate(update);await relay.drainInbox(true)
  await until(async()=>(await runs.get('tg_10'))?.status==='failed')
  const failed=(await runs.get('tg_10'))!
  assert.equal(failed.exitCode,7);assert.equal(failed.failure?.relayVersion,packageVersion);assert.ok(!failed.failure?.error.includes('secret-value'))
  await scheduler.tick(owner,runs,start+60000);await relay.drainSources()
  await until(async()=>(await runs.list()).some(r=>r.scheduled && r.status==='completed'))
  await relay.drainOutbox();assert.deepEqual(replies,['Fixture recovery verified'])
  assert.equal((await runs.get('tg_10'))?.status,'failed');assert.equal(needsFailureReview((await runs.get('tg_10'))!),false)
  await scheduler.tick(owner,runs,start+120000);await relay.drainSources();await relay.drainOutbox()
  assert.equal(reviews,1);assert.equal(replies.length,1)
  await relay.bot.handleUpdate({...update,update_id:11,message:{...update.message!,message_id:11}});await relay.drainInbox(true)
  await relay.bot.handleUpdate({...update,update_id:12,message:{...update.message!,message_id:12,text:'/stop'}})
  await until(async()=>(await runs.get('tg_11'))?.status==='cancelled')
  assert.equal(needsFailureReview((await runs.get('tg_11'))!),false)
 }finally{await relay.stop();for(const child of children)child.kill();await rm(dir,{recursive:true,force:true})}
})


test('relay shutdown waits for executor cleanup and final run state', async () => {
 const dir=await mkdtemp(join(tmpdir(),'ez-stop-finalize-')),control=new ControlStore(dir,1000),runs=new RunStore(dir)
 let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),cleaning=new Promise<void>(resolve=>{entered=resolve})
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture'},async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','pipe','pipe']})
  await once(child,'spawn')
  return {child,cleanup:async()=>{entered();await gate},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
 relay.bot.api.config.use(async()=>({ok:true,result:{message_id:1}} as any))
 try {
  await control.requestPairing(101,101);await control.approveOwner(101)
  await relay.bot.handleUpdate({update_id:90,message:{message_id:90,date:0,text:'fixture',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}})
  await relay.drainInbox(true)
  let stopped=false
  const stop=relay.stop().then(()=>{stopped=true})
  await cleaning
  assert.equal(stopped,false,'stop must not finish before cleanup')
  release();await stop
  assert.notEqual((await runs.get('tg_90'))?.status,'running')
 } finally {release();await relay.stop();await rm(dir,{recursive:true,force:true})}
})

for (const cleanupFails of [false,true]) test(`fatal polling conflict waits for shared shutdown without retrying (cleanup fails: ${cleanupFails})`, async t => {
 const dir=await mkdtemp(join(tmpdir(),'ez-polling-conflict-')),control=new ControlStore(dir,1000),runs=new RunStore(dir)
 let release!:()=>void,entered!:()=>void,releaseDelivery!:()=>void,sending!:()=>void,child:ReturnType<typeof spawn>|undefined,polls=0
 const gate=new Promise<void>(resolve=>{release=resolve}),cleaning=new Promise<void>(resolve=>{entered=resolve})
 const deliveryGate=new Promise<void>(resolve=>{releaseDelivery=resolve}),deliveryStarted=new Promise<void>(resolve=>{sending=resolve})
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture'},async()=>{
  child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','pipe','pipe']})
  await once(child,'spawn')
  return {child,cleanup:async()=>{entered();await gate;await control.status()},stdout:''}
 })
 const stopSource=TelegramSource.prototype.stop
 let sourceStops=0
 t.mock.method(TelegramSource.prototype,'stop',async function(this:TelegramSource){
  sourceStops++;await stopSource.call(this)
  if(cleanupFails) throw new Error('Synthetic shutdown failure')
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
 relay.bot.api.config.use(async(_prev,method)=>{
  if(method==='getUpdates') {
   polls++
   return {ok:false,error_code:409,description:'Conflict: another getUpdates request'} as any
  }
  if(method==='sendMessage') {sending();await deliveryGate}
  return {ok:true,result:{message_id:1}} as any
 })
 try {
  await control.requestPairing(101,101);await control.approveOwner(101)
  await relay.bot.handleUpdate({update_id:92,message:{message_id:92,date:0,text:'fixture',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}})
  await relay.drainInbox(true)
  const item=await runs.enqueueMessage('tg_92','Fixture reply')
  const delivery=relay.drainOutbox()
  await deliveryStarted
  let finished=false
  const start=assert.rejects(relay.start(),/409.*Conflict/).then(()=>{finished=true})
  await cleaning
  const stopping=relay.stop()
  assert.equal(relay.stop(),stopping,'concurrent stop calls share one promise')
  const stopped=cleanupFails?assert.rejects(stopping,/Synthetic shutdown failure/):stopping
  assert.equal(finished,false,'polling failure must wait for executor cleanup')
  release()
  await until(async()=>(await runs.get('tg_92'))?.status!=='running')
  assert.equal(finished,false,'polling failure must wait for the in-flight delivery receipt')
  releaseDelivery();await delivery;await start;await stopped
  assert.equal(relay.stop(),stopping,'finished shutdown remains idempotent')
  assert.equal(sourceStops,1)
  assert.deepEqual(JSON.parse(await readFile(join(dir,'outbox',`${item.id}.sent.json`),'utf8')).receipt.messageIds,[1])
  assert.equal(polls,1,'a conflict must not start another polling loop')
  assert.equal(relay.bot.isRunning(),false)
  assert.ok(child && (child.exitCode!==null || child.signalCode!==null))
  assert.notEqual((await runs.get('tg_92'))?.status,'running')
  await assert.rejects(readFile(join(dir,'control-state.lock')), {code:'ENOENT'})
  assert.equal((await control.status()).owner?.telegramUserId,101)
 } finally {release();releaseDelivery();child?.kill();await relay.stop().catch(()=>{});await rm(dir,{recursive:true,force:true})}
})

for (const intake of [true,false]) test(`relay shutdown terminates an in-flight ${intake?'intake':'scheduled'} launch`, async () => {
 const dir=await mkdtemp(join(tmpdir(),'ez-stop-launch-')),control=new ControlStore(dir,1000),runs=new RunStore(dir)
 let release!:()=>void,entered!:()=>void,child:ReturnType<typeof spawn>|undefined,cleaned=false
 const gate=new Promise<void>(resolve=>{release=resolve}),launching=new Promise<void>(resolve=>{entered=resolve})
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture'},async()=>{
  entered();await gate
  child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','pipe','pipe']})
  await once(child,'spawn')
  return {child,cleanup:async()=>{cleaned=true},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
 relay.bot.api.config.use(async()=>({ok:true,result:{message_id:1}} as any))
 try {
  await control.requestPairing(101,101);const owner=await control.approveOwner(101)
  if(intake) await relay.bot.handleUpdate({update_id:91,message:{message_id:91,date:0,text:'fixture',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}})
  else {
   const scheduler=new Scheduler(dir),at=Date.now()+1000,execution=await control.captureChoice(initialPreset('grok'))
   await scheduler.save({id:'fixture',name:'Fixture',text:'fixture',trigger:{at:new Date(at).toISOString()},enabled:true,owner,execution})
   await scheduler.tick(owner,runs,at)
  }
  const drain=intake?relay.drainInbox(true):relay.drainSources()
  await launching
  let stopped=false
  const stop=relay.stop().then(()=>{stopped=true})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(stopped,false,'stop must wait for the pending launch')
  release();await drain
  // Bound regressions without leaving a real child running on a failed check.
  await until(async()=>stopped)
  await stop
  assert.equal(cleaned,true)
  assert.ok(child && (child.exitCode!==null || child.signalCode!==null))
  assert.ok((await runs.list()).every(run=>run.status!=='running'))
 } finally {release();child?.kill();await relay.stop();await rm(dir,{recursive:true,force:true})}
})

test('group members can inspect failures and wake review without exposing other chats', async t => {
 const dir=await mkdtemp(join(tmpdir(),'ez-group-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const runs=new RunStore(dir),control=new ControlStore(dir,900000),scheduler=new Scheduler(dir)
 await control.requestPairing(101,-123,'Fixture');const owner=await control.approveOwner(-123,true)
 const execution=await control.captureChoice(initialPreset('grok'))
 await runs.create({id:'tg_1',chatId:-123,telegramUserId:202,texts:['failed'],execution})
 await runs.patch('tg_1',{status:'failed',endedAt:new Date().toISOString()})
 await runs.create({id:'tg_2',chatId:-124,telegramUserId:202,texts:['private'],execution})
 await runs.patch('tg_2',{status:'failed'})
 await runs.create({id:'tg_3',chatId:-123,telegramUserId:303,texts:['review'],execution})
 await runs.patch('tg_3',{status:'running'})
 const env={...process.env,EZ_CONTROL_DIR:dir,EZ_EXECUTOR_CLI:'grok',EZ_RUN_ID:'tg_3'}
 const result=JSON.parse((await exec(process.execPath,[bin,'failures'],{env})).stdout)
 assert.deepEqual(result.runs.map((r:any)=>r.id),['tg_1'])
 const at=Date.now()+1000
 await scheduler.save({id:'review',name:'Review',text:'Review failures',trigger:{at:new Date(at).toISOString()},when:'unreviewed-failures',enabled:true,owner,execution})
 await scheduler.tick(owner,runs,at)
 assert.equal((await runs.list()).filter(r=>r.scheduled).length,1)
 await assert.rejects(exec(process.execPath,[bin,'run','tg_2'],{env}),/Unknown owner/)
})
