import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import type { Update } from 'grammy/types'
const until=async(check:()=>Promise<boolean>)=>{for(let n=0;n<150;n++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}
test('owner input queues literally without creating a second agent and rejects other senders',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ez-busy-relay-')),runs=new RunStore(root),control=new ControlStore(root,1000),children:ReturnType<typeof spawn>[]=[]
 const relay=createRelay({workspace:root,controlDir:root,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(_texts,opts)=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true});children.push(child);await once(child,'spawn')
  return {child,stdout:'',cleanup:async()=>{}}
 })
 relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
 relay.bot.api.config.use(async()=>({ok:true,result:true}) as any)
 const message=(id:number,from=101,type='private'):Update=>({update_id:id,message:{message_id:id,date:0,text:'status',from:{id:from,is_bot:false,first_name:'Fixture'},chat:{id:from,type}}} as Update)
 try{
  await control.requestPairing(101,101);await control.approveOwner(101)
  await relay.bot.handleUpdate(message(1));await relay.drainInbox(true)
  await relay.bot.handleUpdate(message(2));await relay.drainInbox(true)
  await relay.bot.handleUpdate(message(3));await relay.drainInbox(true)
  assert.equal((await runs.get('tg_2'))?.replyOnly,undefined)
  assert.equal((await runs.get('tg_3'))?.status,'queued')
  assert.equal(children.length,1)
  await relay.bot.handleUpdate(message(4,202));await relay.drainInbox(true)
  await relay.bot.handleUpdate(message(5,-42,'group'));await relay.drainInbox(true)
  assert.equal(children.length,1)
  children[0].kill()
  await until(async()=>children.length===2)
  assert.equal(children[1].exitCode,null)
  assert.equal(children[1].signalCode,null)
  assert.equal((await runs.get('tg_2'))?.replyOnly,undefined)
  assert.deepEqual((await runs.get('tg_2'))?.texts,['status'])
  await relay.bot.handleUpdate({...message(6),message:{...message(6).message!,text:'/stop'}} as Update)
  await until(async()=>children.every(c=>c.exitCode!==null || c.signalCode!==null))
 }finally{await relay.stop();for(const c of children)c.kill();await until(async()=>!(await runs.list()).some(r=>r.status==='running'));await rm(root,{recursive:true,force:true})}
})
