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
import { randomUUID } from 'node:crypto'

const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}

test('maintenance wakeups use an independent ephemeral session after a relay restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-maintenance-session-')),control=new ControlStore(dir,1000),runs=new RunStore(dir)
 let launchSession='',onSessionCalls=0
 const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(_texts,options)=>{
  launchSession=options.sessionId ?? ''
  if(options.onSession){onSessionCalls++;await options.onSession('native-maintenance')}
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},10)'],{detached:process.platform!=='win32'})
  await once(child,'spawn')
  return {child,cleanup:async()=>{},stdout:''}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof relay.bot.botInfo
 relay.bot.api.config.use(async()=>({ok:true,result:{message_id:42}}) as never)
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  const execution={sessionId:randomUUID(),preset:initialPreset('codex')}
  await runs.create({id:'r_update_fixture',chatId:101,telegramUserId:101,texts:['maintenance'],execution})
  await relay.drainSources()
  await until(async()=> (await runs.get('r_update_fixture'))?.status==='completed')
  assert.notEqual(launchSession,execution.sessionId)
  assert.equal(onSessionCalls,0)
}finally{await relay.stop();await rm(dir,{recursive:true,force:true})}
})

test('chat replies through the real ingress/outbox while scheduled CLI remains alive; targeted cancellation',async()=>{
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
  const owner=(await control.status()).owner!,execution=await control.captureChoice(initialPreset('grok'))
  const due=Date.now()+2000
  await scheduler.save({id:'slow',name:'Slow',text:'Long work',trigger:{at:new Date(due).toISOString()},enabled:true,owner,execution})
  await scheduler.tick(owner,runs,due);await relay.drainSources()
  const [background]=await runs.list()
  assert.equal(background.status,'running')
  const update:Update={update_id:123,message:{message_id:123,date:0,text:'What is 17 × 19?',from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}}
  await relay.bot.handleUpdate(update);await relay.drainInbox(true);await relay.drainOutbox()
  assert.ok(replies.includes('323'))
  assert.equal((await runs.get(background.id))?.status,'running')
  assert.equal(children[0].exitCode,null)
  assert.equal(new Set(workspaces).size,2)
  // Pausing future dispatch doesn't kill active work; cancelling this run does.
  await scheduler.enable('slow',false);await relay.drainSources()
  assert.equal(children[0].exitCode,null)
  await scheduler.cancel(background.id);await relay.drainSources()
  await until(async()=> (await runs.get(background.id))?.status==='cancelled')
  assert.equal((await runs.list()).filter(r=>r.scheduled).length,1)
  for(let n=0;n<5;n++)await scheduler.save({id:'pool_'+n,name:'Pool',text:'Long work',trigger:{at:new Date(Date.now()+2000).toISOString()},enabled:true,owner,execution})
  await scheduler.tick(owner,runs,Date.now()+3000);await relay.drainSources()
  const queued=(await runs.list()).find(r=>r.scheduled && r.status==='queued')!
  assert.ok(queued)
  assert.equal((await runs.list()).filter(r=>r.scheduled && r.status==='running').length,4)
  await scheduler.enable(queued.scheduled!.id,false);await relay.drainSources()
  assert.equal((await runs.get(queued.id))?.status,'queued')
  await scheduler.enable(queued.scheduled!.id,true);await scheduler.cancel(queued.id);await relay.drainSources()
  assert.equal((await runs.get(queued.id))?.status,'cancelled')
  await relay.bot.handleUpdate({...update,update_id:124,message:{...update.message!,message_id:124,text:'/stop'}} as Update)
  await until(async()=>!(await runs.list()).some(r=>r.scheduled && r.status==='running'))
 }finally{
  await relay.stop()
  for(const child of children)if(child.exitCode===null && child.signalCode===null)await once(child,'close')
  await until(async()=>!(await runs.list()).some(r=>r.status==='running'))
  await rm(dir,{recursive:true,force:true})
 }
})
