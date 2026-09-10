import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { TelegramSource } from '../src/telegram-source.js'
import { ControlStore } from '../src/control-state.js'
import { EventSources } from '../src/event-sources.js'
import { Tasks } from '../src/tasks.js'
import { ApprovalStore } from '../src/approval.js'
import { RunStore } from '../src/runs.js'
import { requireOwnerExecution } from '../src/execution-authority.js'
import { ownerRun } from './helpers/owner-run.js'

test('Telegram uses the existing persistent conversation grant, restricted context, receipts and revocation',async t=>{
  const dir=await mkdtemp('/tmp/ez-tg-test-'),sent:any[]=[]
  await ownerRun(dir,'owner')
  const source=new TelegramSource(dir,'999',async(chat,text)=>{sent.push({chat,text});return [sent.length]})
  t.after(async()=>{await source.stop();await rm(dir,{recursive:true,force:true})})
  await source.start((await new ControlStore(dir,900000).status()).owner!)
  const tasks=new Tasks(dir),runs=new RunStore(dir),sources=new EventSources(dir)
  const message=(chat=-101)=>({message_id:1,date:Math.ceil(Date.now()/1000),chat:{id:chat,type:'group',title:'Family'},text:'Hi Annie'} as any)
  const sender={id:202,is_bot:false,first_name:'Family member'}
  assert.equal(await source.capture(1,{...message(),message_id:2},sender),false)
  await assert.rejects(tasks.ownerCall('owner','propose',{sourceId:'telegram',conversationId:'-101',purpose:'Family chat',context:'Only family-group context',hours:24,untilRevoked:true}),/incoming-only/)
  const proposed=await tasks.ownerCall('owner','propose',{sourceId:'telegram',conversationId:'-101',purpose:'Family chat',context:'Only family-group context',hours:24,waitForIncoming:true,untilRevoked:true}) as any
  const approval=new ApprovalStore(dir)
  assert.match((await approval.getDecision(proposed.id))!.prompt,/until owner revocation/)
  await tasks.decide(proposed.id)
  assert.equal(await source.capture(2,message(),sender),false)
  await approval.recordDecision(proposed.id,'approved',101);await tasks.decide(proposed.id)
  assert.equal((await runs.list()).length,1) // No opening send or run.
  assert.equal(await source.capture(3,message(),sender),true)
  assert.equal(await source.capture(3,message(),sender),true) // Durable duplicate intake.
  assert.equal(await source.capture(4,message(-202),sender),false)
  const registration=(await sources.list())[0],batch=await sources.batch(registration)
  assert.equal(batch.events.length,1)
  const task=(await tasks.get(proposed.id))!
  assert.equal(task.version,3)
  const run=await runs.create({id:'event_group_test',taskId:task.id,chatId:101,telegramUserId:101,texts:[],external:{sourceId:registration.id,bindingId:registration.bindingId,eventIds:batch.events.map(e=>e.id)}})
  await runs.patch(run.id,{status:'running'})
  await assert.rejects(requireOwnerExecution(dir,run.id),/blocked/)
  const context:any=await tasks.workerCall(run.id,'context',{})
  assert.equal(context.context,'Only family-group context');assert.equal(context.expiresAt,null)
  assert.match(context.incoming[0].text,/Family member/)
  await tasks.workerCall(run.id,'send',{text:'Hello!',key:'reply',conversationId:'-202'})
  await tasks.workerCall(run.id,'send',{text:'Hello!',key:'reply'})
  assert.deepEqual(sent,[{chat:-101,text:'Hello!'}])
  await assert.rejects(tasks.workerCall(run.id,'send',{text:'Changed',key:'reply'}),/different text/)
  await assert.rejects(source.call('task-send',{accountId:'wrong',conversationId:'-101',key:'x',text:'no'}),/binding/)
  await assert.rejects(tasks.ownerCall(run.id,'propose',{}),/blocked/)
  // Persistent grants survive more than 30 total replies, with per-run keys.
  for(let i=0;i<31;i++) {
    const next=await runs.create({id:`event_followup_${i}`,taskId:task.id,chatId:101,telegramUserId:101,texts:[],external:run.external})
    await runs.patch(next.id,{status:'running'})
    await tasks.workerCall(next.id,'send',{text:`Reply ${i}`,key:'reply'})
    await runs.patch(next.id,{status:'completed'})
  }
  assert.equal(sent.length,32)
  // Update IDs may move backwards after idle; local cursors must still advance.
  await sources.advance(registration,batch.cursor)
  assert.equal(await source.capture(1,{...message(),message_id:2},sender),true)
  assert.equal((await sources.batch(registration)).events[0].id,'tg_n101_2')
  const call=source.call.bind(source)
  source.call=async(command,args)=>{if(command==='task-unwatch')throw new Error('Provider offline');return call(command,args)}
  await assert.rejects(tasks.ownerCall('owner','revoke',{taskId:task.id}))
  assert.equal((await tasks.get(task.id))!.unwatchPending,true)
  await assert.rejects(tasks.ownerCall('owner','propose',{sourceId:'telegram',conversationId:'-101',purpose:'Family chat',context:'Only group context',hours:24,waitForIncoming:true,untilRevoked:true}),/already has a task/)
  source.call=call
  await new Tasks(dir).decide(task.id) // Reconciles after a restart or outage.
  assert.equal((await tasks.get(task.id))!.unwatchPending,undefined)
  await tasks.ownerCall('owner','revoke',{taskId:task.id}) // Idempotent.

  await assert.rejects(tasks.workerCall(run.id,'send',{text:'After revoke',key:'late'}),/inactive/)
  assert.equal(sent.length,32)
  assert.equal(await source.capture(5,message(),sender),false)
})
