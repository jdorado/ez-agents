import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Scheduler, scheduledRunId } from '../src/scheduler.js'
import { RunStore } from '../src/runs.js'
import { nextOccurrence, validateTrigger, type Trigger } from '../src/schedule-time.js'
import { taskWorkspace } from '../src/task-workspace.js'

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
 const input={id:'test',name:'Test',text:'Do the work',owner,execution:{sessionId:randomUUID(),preset:{id:'fixture',name:'Fixture',cli:'codex'}},enabled:true,trigger:{at:new Date(now).toISOString()}}
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
test('task workspaces are distinct and cannot escape through symlinks',async t=>{
 const f=await fixture(t)
 await writeFile(join(f.dir,'SOUL.md'),'Owner context')
 const first=await taskWorkspace(f.dir,'r_one'),second=await taskWorkspace(f.dir,'r_two')
 assert.notEqual(first,second)
 await assert.rejects(readFile(join(first,'SOUL.md'),'utf8'),{code:'ENOENT'})
 await assert.rejects(readFile(join(first,'AGENTS.md'),'utf8'),{code:'ENOENT'})
 await assert.rejects(taskWorkspace(f.dir,'../escape'))
 const other=join(f.dir,'other');await mkdir(other)
 await symlink(other,join(f.dir,'work/tasks/r_link'))
 await assert.rejects(taskWorkspace(f.dir,'r_link'))
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
