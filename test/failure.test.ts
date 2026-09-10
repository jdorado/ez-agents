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

test('failure capture, diagnosis, verified recovery and conditional quiet next tick through real CLI and relay',async()=>{
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
