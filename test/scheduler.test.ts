import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat, readdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Scheduler, scheduledRunId } from '../src/scheduler.js'
import { RunStore } from '../src/runs.js'
import { nextOccurrence, validateTrigger, type Trigger } from '../src/schedule-time.js'

const next=(t:Trigger,after:string)=>{
 const at=nextOccurrence(validateTrigger(t),Date.parse(after));return at===null ? null : new Date(at).toISOString()
}
test('calendar scheduling: weekdays, Tuesday, intervals, ends, leap years, timezone and DST',()=>{
 const start='2026-01-01T00:00:00Z'
 assert.equal(next({cron:'30 9 * * 1-5',timezone:'Asia/Dubai',start},'2026-09-04T05:30:00Z'),'2026-09-07T05:30:00.000Z')
 assert.equal(next({cron:'0 9 * * 2',timezone:'Asia/Dubai',start},'2026-09-08T05:00:00Z'),'2026-09-15T05:00:00.000Z')
 assert.equal(next({cron:'0 9 29 2 *',timezone:'UTC',start},start),'2028-02-29T09:00:00.000Z')
 assert.equal(next({cron:'30 2 * * *',timezone:'America/New_York',start},'2026-03-08T00:00:00Z'),'2026-03-09T06:30:00.000Z')
 assert.equal(next({cron:'30 1 * * *',timezone:'America/New_York',start},'2026-11-01T05:30:00Z'),'2026-11-02T06:30:00.000Z')
 assert.equal(next({cron:'0 9 * * *',timezone:'Asia/Kathmandu',start},start),'2026-01-01T03:15:00.000Z')
 assert.equal(next({everySeconds:3600,start,until:'2026-01-01T02:00:00Z'},'2026-01-01T01:00:00Z'),'2026-01-01T02:00:00.000Z')
 assert.equal(next({everySeconds:3600,start,until:'2026-01-01T02:00:00Z'},'2026-01-01T02:00:00Z'),null)
 assert.equal(next({at:'2027-09-09T09:00:00+04:00'},start),'2027-09-09T05:00:00.000Z')
 for(const t of [{at:'2027-01-01'}, {cron:'0 25 * * *',timezone:'UTC',start},{cron:'*/0 * * * *',timezone:'UTC',start},{cron:'0 9 * * *',timezone:'Bad/Zone',start},{everySeconds:1,start}])assert.throws(()=>validateTrigger(t))
})
const fixture=async(t:any)=>{
 const dir=await mkdtemp(join(tmpdir(),'ez-schedules-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const scheduler=new Scheduler(dir), runs=new RunStore(dir), now=Date.now()+10000
 const owner={telegramUserId:101,telegramChatId:101,pairedAt:new Date().toISOString()}
 const input={id:'test',name:'Test',text:'Do the work',owner,execution:{sessionId:randomUUID(),preset:{id:'fixture',name:'Fixture',cli:'codex',model:'fixture-model'}},enabled:true,trigger:{at:new Date(now).toISOString()}}
 return {dir,scheduler,runs,now,owner,input}
}
test('durable dispatch survives cursor-write crash without duplicating an occurrence',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input)
 // Simulate the durable run write succeeding and the cursor update being interrupted.
 await f.runs.create({id:scheduledRunId(s,f.now),chatId:101,telegramUserId:101,texts:[s.text],execution:s.execution,
  scheduled:{id:s.id,revision:s.revision,dueAt:new Date(f.now).toISOString(),pairedAt:f.owner.pairedAt}})
 await f.scheduler.tick(f.owner,f.runs,f.now+1000)
 assert.equal((await f.runs.list()).length,1)
 await f.runs.patch(scheduledRunId(s,f.now),{status:'completed'})
 await new Scheduler(f.dir).tick(f.owner,f.runs,f.now+2000)
 await new Scheduler(f.dir).tick(f.owner,f.runs,f.now+3000)
 assert.equal((await f.runs.list()).length,1)
 assert.equal((await stat(join(f.dir,'schedules/test.json'))).mode & 0o777,0o600)
})
test('missed recurrences coalesce; an active occurrence cannot overlap another',async t=>{
 const f=await fixture(t)
 await f.scheduler.save({...f.input,trigger:{everySeconds:60,start:new Date(f.now).toISOString()}})
 await f.scheduler.tick(f.owner,f.runs,f.now+600000)
 const [first]=await f.runs.list();assert.equal((await f.runs.list()).length,1)
 await f.scheduler.tick(f.owner,f.runs,f.now+700000)
 assert.equal((await f.runs.list()).length,1)
 await f.runs.patch(first.id,{status:'completed'})
 await f.scheduler.tick(f.owner,f.runs,f.now+800000)
 assert.equal((await f.runs.list()).length,2)
})
test('recurring edits preserve a future cursor or start the changed rule in the future',async t=>{
 const f=await fixture(t), start=new Date(Date.now()-86400000).toISOString()
 const original=await f.scheduler.save({...f.input,trigger:{everySeconds:60,start}},true)
 const future=nextOccurrence(original.trigger,Date.now()+120000)!
 await writeFile(join(f.dir,`schedules/${original.id}.${original.revision}.cursor`),JSON.stringify({next:future}))
 const same=await f.scheduler.save({...f.input,text:'Edited text',trigger:original.trigger})
 assert.notEqual(same.revision,original.revision)
 assert.equal(await f.scheduler.pendingOccurrence(same),future)
 await f.scheduler.tick(f.owner,f.runs,future-1)
 assert.equal((await f.runs.list()).length,0)
 await f.scheduler.tick(f.owner,f.runs,future)
 const [first]=await f.runs.list()
 assert.equal(first.scheduled?.dueAt,new Date(future).toISOString())
 assert.equal(first.texts[1],'Edited text')
 await f.runs.patch(first.id,{status:'completed'})

 const changed=await f.scheduler.save({...f.input,text:'Changed cadence',trigger:{everySeconds:120,start}})
 const nextDue=await f.scheduler.pendingOccurrence(changed)
 assert.ok(nextDue !== null && nextDue >= Date.now())
 await f.scheduler.tick(f.owner,f.runs,nextDue-1)
 assert.equal((await f.runs.list()).length,1,'edit must not replay the old start')
 await f.scheduler.tick(f.owner,f.runs,nextDue)
 const second=(await f.runs.list()).find(r=>r.scheduled?.revision===changed.revision)
 assert.equal(second?.scheduled?.dueAt,new Date(nextDue).toISOString())
 assert.equal(second?.texts[1],'Changed cadence')
})
test('an explicit one-time edit still dispatches at its requested time',async t=>{
 const f=await fixture(t), first=await f.scheduler.save(f.input,true)
 const due=Date.now()+2000
 const edited=await f.scheduler.save({...f.input,trigger:{at:new Date(due).toISOString()},text:'Run now'})
 assert.notEqual(first.revision,edited.revision)
 await f.scheduler.tick(f.owner,f.runs,due)
 assert.equal((await f.runs.list()).find(r=>r.scheduled?.revision===edited.revision)?.texts[1],'Run now')
})
test('an unreadable prior cursor rejects an edit without publishing its revision',async t=>{
 const f=await fixture(t), start=new Date(Date.now()-86400000).toISOString()
 const saved=await f.scheduler.save({...f.input,trigger:{everySeconds:60,start}},true)
 await writeFile(join(f.dir,`schedules/${saved.id}.${saved.revision}.cursor`),'{broken')
 await assert.rejects(f.scheduler.save({...f.input,text:'Edited',trigger:saved.trigger}))
 assert.equal((await f.scheduler.get(saved.id)).revision,saved.revision)
})
test('pause, edit, removal, owner revocation, corrupt records and traversal fail closed',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input)
 await f.scheduler.enable(s.id,false);await f.scheduler.tick(f.owner,f.runs,f.now)
 assert.equal((await f.runs.list()).length,0)
 await f.scheduler.enable(s.id,true)
 await f.scheduler.tick({...f.owner,pairedAt:'new pairing'},f.runs,f.now)
 assert.equal((await f.runs.list()).length,0)
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [run]=await f.runs.list()
 assert.equal(await f.scheduler.current(run,f.owner),true)
 await f.scheduler.save({...f.input,text:'Edited'})
 assert.equal(await f.scheduler.current(run,f.owner),false)
 await f.scheduler.remove(s.id);assert.equal(await f.scheduler.current(run,f.owner),false)
 await writeFile(join(f.dir,'schedules/broken.json'),'{')
 await f.scheduler.tick(f.owner,f.runs,f.now)
 await assert.rejects(f.scheduler.get('../bad'))
 await assert.rejects(f.scheduler.remove('../bad'))
 await assert.rejects(f.scheduler.cancel('../bad'))
 await f.scheduler.cancel(run.id);assert.equal(await f.scheduler.cancelled(run.id),true)
})
test('startup quarantines an interrupted spawn before PID persistence; explicit edit releases its schedule',async t=>{
 const f=await fixture(t),s=await f.scheduler.save({...f.input,trigger:{everySeconds:60,start:new Date(f.now).toISOString()}})
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [run]=await f.runs.list();await f.runs.patch(run.id,{status:'running'})
 await new Scheduler(f.dir).recover(f.runs)
 assert.equal((await f.runs.get(run.id))?.interrupted,true)
 assert.equal((await f.runs.get(run.id))?.status,'failed')
 assert.equal(await readFile(join(f.dir,'host-executor',run.id+'.cancel'),'utf8'),'')
 await f.scheduler.tick(f.owner,f.runs,f.now+600000)
 assert.equal((await f.runs.list()).length,1)
 await f.scheduler.save({...s,trigger:{everySeconds:60,start:new Date(f.now+700000).toISOString()}})
 await f.scheduler.tick(f.owner,f.runs,f.now+700000)
 assert.equal((await f.runs.list()).length,2)
})

test('a failed reviewer stops its revision even while the original failure remains; explicit edit resumes', async t => {
 const f=await fixture(t)
 const s=await f.scheduler.save({...f.input,when:'unreviewed-failures',trigger:{everySeconds:60,start:new Date(f.now).toISOString()}})
 await f.runs.create({id:'r_original',chatId:101,telegramUserId:101,texts:['Original work']})
 await f.runs.patch('r_original',{status:'failed'})
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const review=(await f.runs.list()).find(r=>r.scheduled)!
 await f.runs.patch(review.id,{status:'failed',exitCode:1})
 for(const offset of [60000,120000,600000])await new Scheduler(f.dir).tick(f.owner,f.runs,f.now+offset)
 assert.equal((await f.runs.list()).length,2)
 assert.equal((await f.runs.get('r_original'))?.status,'failed')
 await f.scheduler.enable(s.id,false);await f.scheduler.enable(s.id,true)
 await f.scheduler.tick(f.owner,f.runs,f.now+700000)
 assert.equal((await f.runs.list()).length,2,'toggling enabled must not replay a failed reviewer')
 await f.scheduler.save({...s,text:'Review after the owner repaired the prerequisite'})
 await f.scheduler.tick(f.owner,f.runs,f.now+800000)
 assert.equal((await f.runs.list()).length,3)
})

test('ordinary recurring work still runs after a non-interrupted failure', async t => {
 const f=await fixture(t)
 await f.scheduler.save({...f.input,trigger:{everySeconds:60,start:new Date(f.now).toISOString()}})
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [run]=await f.runs.list();await f.runs.patch(run.id,{status:'failed'})
 await f.scheduler.tick(f.owner,f.runs,f.now+60000)
 assert.equal((await f.runs.list()).length,2)
})

test('missing models cannot be saved, dispatched or triggered; legacy settings remain readable for repair',async t=>{
 const f=await fixture(t)
 const missing={...f.input,execution:{...f.input.execution,preset:{...f.input.execution.preset,model:undefined}}}
 await assert.rejects(f.scheduler.save(missing),/saved explicit model/)
 const saved=await f.scheduler.save(f.input,true),next=await f.scheduler.pendingOccurrence(saved)
 const file=join(f.dir,'schedules/test.json')
 await writeFile(file,JSON.stringify({...saved,execution:missing.execution}))
 const legacy=await f.scheduler.get(saved.id)
 assert.equal(legacy.execution!.preset.model,undefined)
 await f.scheduler.tick(f.owner,f.runs,f.now)
 assert.equal((await f.runs.list()).length,0)
 assert.equal(await f.scheduler.pendingOccurrence(legacy),next,'blocked dispatch must preserve the pending occurrence')
 await assert.rejects(f.scheduler.trigger(saved.id,saved.revision,'legacy',f.owner,f.runs),/saved explicit model/)
 const repaired=await f.scheduler.save({...legacy,execution:f.input.execution})
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [run]=await f.runs.list()
 assert.equal(run.execution?.preset.model,f.input.execution.preset.model)
 assert.equal(run.scheduled?.revision,repaired.revision)
})

// Safe updates: an edit never invalidates an occurrence that is already queued
// or running, and definition writes serialize with dispatch on the schedule lock.
test('edit applies only from the expected revision and keeps a concurrent pause',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input,true), list=()=>f.runs.list()
 const first=await f.scheduler.edit({...f.input,text:'First'},s.revision,list)
 await assert.rejects(f.scheduler.edit({...f.input,text:'Stale'},s.revision,list),/changed since revision/)
 assert.equal((await f.scheduler.get(s.id)).text,'First')
 const racing=await Promise.allSettled(['A','B'].map(text=>f.scheduler.edit({...f.input,text},first.revision,list)))
 const won=racing.filter(r=>r.status==='fulfilled')
 assert.equal(won.length,1,'two edits from one revision cannot both apply')
 assert.match(String((racing.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/changed since revision/)
 const latest=await f.scheduler.get(s.id)
 assert.equal(latest.revision,(won[0] as PromiseFulfilledResult<typeof latest>).value.revision)
 // Pause keeps the revision; an edit read before it must not resume the task.
 await f.scheduler.enable(s.id,false)
 assert.equal((await f.scheduler.edit({...f.input,enabled:true,text:'After pause'},latest.revision,list)).enabled,false)
 assert.deepEqual((await readdir(join(f.dir,'schedules'))).filter(name=>name.endsWith('.lock')),[])
})
test('edit refuses a busy task; a staged edit lets queued and running occurrences finish on captured settings',async t=>{
 const f=await fixture(t), list=()=>f.runs.list()
 const s=await f.scheduler.save({...f.input,trigger:{everySeconds:60,start:new Date(f.now).toISOString()}},true)
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [queued]=await f.runs.list()
 const changed={...f.input,text:'New instructions',trigger:s.trigger,execution:{...f.input.execution,preset:{...f.input.execution.preset,model:'new-model'}}}
 await assert.rejects(f.scheduler.edit(changed,s.revision,list),new RegExp(`queued or running occurrences \\(${queued.id}\\)`))
 assert.equal((await f.scheduler.get(s.id)).revision,s.revision)
 assert.equal(await f.scheduler.current(queued,f.owner),true,'a refused edit leaves the queued occurrence admissible')
 await f.runs.patch(queued.id,{status:'running'})
 const staged=await f.scheduler.edit(changed,s.revision,list,true)
 assert.deepEqual(staged.continuingRunIds,[queued.id])
 // Admission and fallback advancement keep accepting the captured occurrence.
 assert.equal(await f.scheduler.current(queued,f.owner),true)
 const captured=(await f.runs.get(queued.id))!
 assert.equal(captured.texts[1],'Do the work');assert.equal(captured.execution?.preset.model,'fixture-model')
 assert.equal((await f.scheduler.listTasksReadOnly(await f.runs.list()))[0].runState,'running')
 await f.scheduler.tick(f.owner,f.runs,f.now+600000)
 assert.equal((await f.runs.list()).length,1,'the staged revision waits for the running occurrence')
 await f.runs.patch(queued.id,{status:'completed'})
 await f.scheduler.tick(f.owner,f.runs,f.now+600000)
 const next=(await f.runs.list()).find(r=>r.id!==queued.id)!
 assert.equal(next.scheduled?.revision,staged.revision)
 assert.equal(next.texts[1],'New instructions');assert.equal(next.execution?.preset.model,'new-model')
 await f.runs.patch(next.id,{status:'completed'})
 const idle=await f.scheduler.edit({...changed,text:'Idle edit'},staged.revision,list)
 assert.equal(idle.continuingRunIds,undefined)
 assert.equal(await f.scheduler.current(queued,f.owner),false)
})
test('a dispatch never lands between an edit check and its write',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input,true)
 // The edit holds the lock while it reads the ledger: a concurrent tick skips the task.
 const applied=await f.scheduler.edit({...f.input,text:'Edited'},s.revision,async()=>{
  await f.scheduler.tick(f.owner,f.runs,f.now)
  return f.runs.list()
 })
 assert.equal((await f.runs.list()).length,0)
 await f.scheduler.tick(f.owner,f.runs,f.now)
 const [run]=await f.runs.list()
 assert.equal(run.scheduled?.revision,applied.revision);assert.equal(run.texts[1],'Edited')
 assert.equal(await f.scheduler.current(run,f.owner),true)
 // The dispatcher holds the lock while it queues: an edit started then sees the occurrence.
 const g=await fixture(t), saved=await g.scheduler.save(g.input,true)
 let editing:Promise<unknown>|undefined, staging:Promise<unknown>|undefined
 const hooked=Object.assign(Object.create(g.runs) as RunStore,{create:async(...args:Parameters<RunStore['create']>)=>{
  editing=g.scheduler.edit({...g.input,text:'Too late'},saved.revision,()=>g.runs.list())
  staging=g.scheduler.edit({...g.input,text:'Staged'},saved.revision,()=>g.runs.list(),true)
  return g.runs.create(...args)
 }})
 await g.scheduler.tick(g.owner,hooked,g.now)
 const results=await Promise.allSettled([editing!,staging!])
 const [dispatched]=await g.runs.list()
 assert.equal(dispatched.scheduled?.revision,saved.revision)
 assert.ok(results.some(r=>r.status==='rejected' && /queued or running|changed since revision/.test(String(r.reason))),'an unstaged edit cannot replace a busy task')
 assert.equal(await g.scheduler.current(dispatched,g.owner),true,'the queued occurrence stays admissible')
})
test('concurrent dispatch, trigger and edit never leave an occurrence that admission would cancel',async t=>{
 const f=await fixture(t), jitter=()=>new Promise(resolve=>setTimeout(resolve,Math.random()*4))
 for(let i=0;i<30;i++){
  const id=`race-${i}`, stage=i%2===1
  const s=await f.scheduler.save({...f.input,id},true)
  const [,,edited]=await Promise.allSettled([
   jitter().then(()=>f.scheduler.tick(f.owner,f.runs,f.now)),
   jitter().then(()=>f.scheduler.trigger(id,s.revision,`key-${i}`,f.owner,f.runs)),
   jitter().then(()=>f.scheduler.edit({...f.input,id,text:`Edited ${i}`},s.revision,()=>f.runs.list(),stage)),
  ])
  const occurrences=(await f.runs.list()).filter(r=>r.scheduled?.id===id)
  assert.ok(occurrences.length<=1,'one queued or running occurrence per task')
  for(const run of occurrences)assert.equal(await f.scheduler.current(run,f.owner),true,`${id} ${run.scheduled?.revision} would be cancelled`)
  if(edited.status==='rejected')assert.match(String(edited.reason),/queued or running/)
  else if(!stage)assert.ok(occurrences.every(r=>r.scheduled?.revision===edited.value.revision))
  for(const run of occurrences)await f.runs.patch(run.id,{status:'completed'})
 }
 assert.deepEqual((await readdir(join(f.dir,'schedules'))).filter(name=>name.endsWith('.lock')),[])
})
test('a lock left by a crashed writer expires; a live one makes dispatch wait',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input,true), lock=join(f.dir,'schedules',`${s.id}.lock`)
 await writeFile(lock,'')
 await f.scheduler.tick(f.owner,f.runs,f.now)
 assert.equal((await f.runs.list()).length,0)
 const old=new Date(Date.now()-60000);await utimes(lock,old,old)
 await f.scheduler.tick(f.owner,f.runs,f.now)
 assert.equal((await f.runs.list()).length,1)
 await assert.rejects(stat(lock),{code:'ENOENT'})
})
test('a holder whose lock expired never releases the next holder',async t=>{
 const f=await fixture(t), lock=(f.scheduler as unknown as {lock:(id:string)=>Promise<()=>Promise<void>>}).lock.bind(f.scheduler)
 const file=join(f.dir,'schedules/test.lock'), first=await lock('test')
 const old=new Date(Date.now()-60000);await utimes(file,old,old)
 const second=await lock('test')
 await first();await stat(file)
 await second();await assert.rejects(stat(file),{code:'ENOENT'})
})
test('continuing occurrences must be valid record identifiers',async t=>{
 const f=await fixture(t), s=await f.scheduler.save(f.input,true)
 await writeFile(join(f.dir,'schedules/test.json'),JSON.stringify({...s,continuingRunIds:['../escape']}))
 await assert.rejects(f.scheduler.get('test'),/Invalid schedule record/)
})
