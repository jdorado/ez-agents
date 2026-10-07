import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Update } from 'grammy/types'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { Scheduler } from '../src/scheduler.js'
import { initialPreset } from '../src/ai.js'
import type { ExecutorOptions } from '../src/executor.js'

const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}

test('executor admission rejects a legacy queued schedule with no model before spawning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-missing-task-model-')),control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
 let launches=0
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async()=>{
  launches++;throw new Error('Must not launch')
 })
 relay.bot.api.config.use(async()=>({ok:true,result:{message_id:42}}) as never)
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,execution=await control.captureChoice({...initialPreset('codex'),model:'saved-model'})
  const due=Date.now()+2000
  const saved=await scheduler.save({id:'legacy',name:'Legacy',text:'Work',owner,execution,enabled:true,trigger:{at:new Date(due).toISOString()}},true)
  const run=await runs.create({id:'r_schedule_legacy',chatId:101,telegramUserId:101,texts:['Work'],
   execution:{...execution,preset:{...execution.preset,model:undefined}},
   scheduled:{id:saved.id,revision:saved.revision,dueAt:new Date(due).toISOString(),pairedAt:owner.pairedAt}})
  await relay.drainSources()
  assert.equal((await runs.get(run.id))?.status,'failed');assert.equal(launches,0)
  assert.equal((await scheduler.get(saved.id)).execution!.preset.model,'saved-model')
 }finally{await relay.stop();await rm(dir,{recursive:true,force:true})}
})

test('manual task trigger launches its saved model in a fresh native session after chat switches AI',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-trigger-launch-')),control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
 let launched:ExecutorOptions | undefined
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(_texts,options)=>{
  launched=options
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},10)'],{detached:process.platform!=='win32'})
  await once(child,'spawn');return {child,cleanup:async()=>{},stdout:''}
 })
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,chat=await control.captureChoice(initialPreset('codex'))
  await control.savePreset({id:'chat',name:'Chat',cli:'codex',model:'gpt-6-luna',effort:'max'})
  await control.selectPreset('chat',chat.sessionId)
  const saved=await scheduler.save({id:'daily',name:'Daily',text:'Saved work',owner,execution:{sessionId:chat.sessionId,preset:{id:'daily',name:'Daily model',cli:'codex',model:'gpt-6-astra',effort:'medium'}},enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}},true)
  const run=await scheduler.trigger(saved.id,saved.revision,'launch-smoke',owner,runs)
  await relay.drainSources();await until(async()=> (await runs.get(run.id))?.status==='completed')
  assert.equal(launched?.model,'gpt-6-astra');assert.equal(launched?.effort,'medium')
  assert.equal(launched?.nativeSession,true);assert.equal(launched?.isResume,false)
  assert.notEqual(launched?.sessionId,chat.sessionId)
  assert.equal((await control.status()).ai?.selectedId,'chat')
 }finally{await relay.stop();await rm(dir,{recursive:true,force:true})}
})

// Adversarial: the relay must not reserve wrapper semantics for an
// update-shaped run id or a stale attention notice.
test('a wrapper-shaped run id has no maintenance treatment and a stale notice is inert',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-no-maintenance-session-')),control=new ControlStore(dir,1000),runs=new RunStore(dir)
 let launchSession='',onSessionCalls=0,launches=0
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(_texts,options)=>{
  launches++
  launchSession=options.sessionId ?? ''
  if(options.onSession){onSessionCalls++;await options.onSession('native-review')}
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},10)'],{detached:process.platform!=='win32'})
  await once(child,'spawn')
  return {child,cleanup:async()=>{},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof relay.bot.botInfo
 relay.bot.api.config.use(async()=>({ok:true,result:{message_id:42}}) as never)
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const execution=await control.captureChoice(initialPreset('codex'))
  await runs.create({id:'r_update_fixture',chatId:101,telegramUserId:101,texts:['maintenance'],execution})
  await relay.drainSources()
  await until(async()=> (await runs.get('r_update_fixture'))?.status==='completed')
  assert.equal(launchSession,execution.sessionId)
  assert.equal(onSessionCalls,1)
  await writeFile(join(dir,'update-attention.json'),JSON.stringify({id:'a'.repeat(64)}))
  await relay.drainSources()
  assert.equal(launches,1)
  assert.equal((await runs.list()).length,1)
 }finally{await relay.stop();await rm(dir,{recursive:true,force:true})}
})

test('Slack application replies beside schedules configured to stay serial',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-slack-scheduled-')),runs=new RunStore(dir),scheduler=new Scheduler(dir),control=new ControlStore(dir,1000)
 const children=new Map<string,ReturnType<typeof spawn>>()
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture',scheduledConcurrency:1},async(_texts,options)=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32'})
  children.set(options.runId,child);await once(child,'spawn')
  if(!options.runId.startsWith('r_schedule_'))await runs.enqueueMessage(options.runId,'Slack reply')
  return {child,cleanup:async()=>{},stdout:''}
 })
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,execution=await control.captureChoice({...initialPreset('grok'),model:'fixture-model'})
  const due=Date.now()+10000
  for(const id of ['first','second'])await scheduler.save({id,name:id,text:'Long work',trigger:{at:new Date(due).toISOString()},enabled:true,owner,execution})
  await scheduler.tick(owner,runs,due);await relay.drainSources()
  const scheduled=(await runs.list()).filter(run=>run.scheduled)
  assert.deepEqual(scheduled.map(run=>run.status),['running','queued'])
  const binding=(await relay.applicationChannel.bindings.register('slack','s'.repeat(48),owner))!
  const scope='slack:T_FIXTURE:C_FIXTURE'
  const first=await relay.applicationChannel.submit(binding.bindingId,{requestId:'event-1',scope,text:'Top twenty'})
  await until(async()=>children.has(first.id));await relay.drainOutbox()
  assert.equal((await relay.applicationChannel.snapshot(binding.bindingId,first.id)).messages[0].text,'Slack reply')
  assert.equal((await runs.get(scheduled[0].id))?.status,'running')
  const second=await relay.applicationChannel.submit(binding.bindingId,{requestId:'event-2',scope,text:'Next question'})
  await relay.drainSources()
  assert.equal((await runs.get(second.id))?.status,'queued')
  assert.equal(children.size,2)
  // Revoking the channel stops only its foreground work; background authority
  // and the original one-occurrence-per-schedule limit remain intact.
  await relay.applicationChannel.bindings.register('slack',null,owner)
  await relay.drainSources()
  await until(async()=> (await runs.get(first.id))?.status==='cancelled')
  await relay.drainSources()
  assert.equal((await runs.get(second.id))?.status,'cancelled')
  assert.equal((await runs.get(scheduled[0].id))?.status,'running')
  assert.equal((await runs.get(scheduled[1].id))?.status,'queued')
 }finally{
  await relay.stop()
  await until(async()=>!(await runs.list()).some(run=>run.status==='running'))
  await rm(dir,{recursive:true,force:true})
 }
})

test('owner chat replies while a scheduled CLI keeps running; targeted cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-scheduler-relay-')), children:ReturnType<typeof spawn>[]=[]
 const runs=new RunStore(dir),scheduler=new Scheduler(dir),control=new ControlStore(dir,1000)
 const replies:string[]=[], workspaces:string[]=[]
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture'},async(texts,options)=>{
  workspaces.push(options.workspace)
  const background=options.runId.startsWith('r_schedule_')
  const child=spawn(process.execPath,['-e',background ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>{},100)'],{detached:process.platform!=='win32'})
  children.push(child);await once(child,'spawn')
  if(!background)await runs.enqueueMessage(options.runId,'323')
  return {child,cleanup:async()=>{},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof relay.bot.botInfo
 relay.bot.api.config.use(async(_prev,method,payload)=>{if(method==='sendMessage')replies.push((payload as {text:string}).text);return {ok:true,result:{message_id:42}} as never})
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,execution=await control.captureChoice({...initialPreset('grok'),model:'fixture-model'})
  const due=Date.now()+2000
  await scheduler.save({id:'slow',name:'Slow',text:'Long work',trigger:{at:new Date(due).toISOString()},enabled:true,owner,execution})
  await scheduler.tick(owner,runs,due);await relay.drainSources()
  const [background]=await runs.list()
  assert.equal(background.status,'running')
  const update:Update={update_id:123,message:{message_id:123,date:0,text:'What is 17 × 19?',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}}
  await relay.bot.handleUpdate(update);await relay.drainInbox(true)
  await until(async()=>children.length===2)
  await relay.drainOutbox()
  assert.ok(replies.includes('323'))
  assert.equal((await runs.get(background.id))?.status,'running')
  assert.equal(children[0].exitCode,null)
  assert.deepEqual(workspaces,[dir,dir])
  // Pausing future dispatch doesn't kill active work; cancelling this run does.
  await scheduler.enable('slow',false);await relay.drainSources()
  assert.equal(children[0].exitCode,null)
  await scheduler.cancel(background.id);await relay.drainSources()
  await until(async()=> (await runs.get(background.id))?.status==='cancelled')
  assert.deepEqual(workspaces,[dir,dir])
  assert.equal((await runs.list()).filter(r=>r.scheduled).length,1)
 }finally{
  await relay.stop()
  for(const child of children)if(child.exitCode===null && child.signalCode===null)await once(child,'close')
  await until(async()=>!(await runs.list()).some(r=>r.status==='running'))
  await rm(dir,{recursive:true,force:true})
 }
})

for(const limit of [undefined,2])test(`scheduled admission bounds independent native jobs at ${limit ?? 6} and releases a cancelled slot`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-parallel-schedules-')),control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
 const children=new Map<string,ReturnType<typeof spawn>>(),optionsSeen:ExecutorOptions[]=[]
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'grok',telegramBotToken:'fixture',scheduledConcurrency:limit},async(_texts,options)=>{
  optionsSeen.push(options)
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32'})
  children.set(options.runId,child);await once(child,'spawn');return {child,cleanup:async()=>{},stdout:''}
 })
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!,execution=await control.captureChoice({...initialPreset('grok'),model:'saved-model',effort:'medium'})
  const jobs: Awaited<ReturnType<Scheduler['trigger']>>[]=[]
  for(let n=0;n<(limit ?? 6)+1;n++){
   const saved=await scheduler.save({id:`job${n}`,name:`Job${n}`,text:'Finite test',owner,execution,enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}},true)
   jobs.push(await scheduler.trigger(saved.id,saved.revision,`key${n}`,owner,runs))
  }
  await Promise.all([relay.drainSources(),relay.drainSources()])
  assert.equal((await runs.list()).filter(r=>r.status==='running').length,limit ?? 6)
  assert.equal((await runs.get(jobs.at(-1)!.id))?.status,'queued')
  assert.equal(new Set(optionsSeen.map(o=>o.sessionId)).size,limit ?? 6)
  for(const options of optionsSeen){assert.equal(options.model,'saved-model');assert.equal(options.effort,'medium');assert.equal(options.nativeSession,true);assert.equal(options.isResume,false)}
  const foreground=await runs.create({id:'tg_parallel_chat',chatId:101,telegramUserId:101,texts:['Owner chat'],execution})
  await relay.drainSources();assert.equal((await runs.get(foreground.id))?.status,'running')
  assert.equal(children.size,(limit ?? 6)+1)
  await scheduler.cancel(jobs[0].id);await relay.drainSources()
  await until(async()=> (await runs.get(jobs[0].id))?.status==='cancelled')
  await relay.drainSources();assert.equal((await runs.get(jobs.at(-1)!.id))?.status,'running')
  for(const job of jobs.slice(1))assert.equal((await runs.get(job.id))?.status,'running')
 }finally{
  await relay.stop()
  await until(async()=>!(await runs.list()).some(r=>r.status==='running'))
  await rm(dir,{recursive:true,force:true})
 }
})
