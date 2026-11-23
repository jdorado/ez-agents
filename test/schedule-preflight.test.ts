import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Scheduler,type Schedule} from '../src/scheduler.js'
import {RunStore} from '../src/runs.js'
import {validPreflight,combinePreflight} from '../src/schedule-preflight.js'
const packet=(eligible:boolean,fingerprint='a'.repeat(64))=>({eligible,fingerprint,count:eligible?1:0,observedAt:new Date().toISOString()})
test('preflight skips empty/unchanged work, admits saved worker once, and fails closed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'schedule-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let result=packet(false),failed=false
 const scheduler=new Scheduler(dir,async()=>{if(failed)throw Error('Provider unavailable');return result}),runs=new RunStore(dir)
 const owner={telegramUserId:42,telegramChatId:42,pairedAt:new Date().toISOString()},start=Date.now()+10000
 const input={id:'preflight',name:'Check',text:'Do role work',enabled:true,owner,execution:{sessionId:randomUUID(),preset:{id:'test',name:'test',cli:'codex',model:'fixture-model'}},trigger:{everySeconds:60,start:new Date(start).toISOString()},preflight:{on:'changed' as const,checks:[{alias:'provider-work',args:['--field','Role=RoleX']}]}}
 const s=await scheduler.save(input)
 await scheduler.tick(owner,runs,start);assert.equal((await runs.list()).length,0)
 result=packet(true,'b'.repeat(64));await scheduler.tick(owner,runs,start+60000)
 const [run]=await runs.list();assert.deepEqual(run.execution,s.execution)
 await scheduler.tick(owner,runs,start+120000);assert.equal((await runs.list()).length,1)
 await runs.patch(run.id,{status:'completed'});await scheduler.tick(owner,runs,start+180000);assert.equal((await runs.list()).length,1)
 failed=true;await scheduler.tick(owner,runs,start+240000);assert.equal((await runs.list()).length,1);assert.equal((await scheduler.preflightReceipt(s)).state,'unavailable')
 failed=false;result=packet(false);await assert.rejects(()=>scheduler.trigger(s.id,s.revision,'empty',owner,runs),/no eligible/)
 result=packet(true,'c'.repeat(64));await scheduler.tick(owner,runs,start+300000);assert.equal((await runs.list()).length,2)
 // An update or broker rebind holds admission: a preflight that fails meanwhile keeps its occurrence due.
 await runs.patch((await runs.list()).find(r=>r.status!=='completed')!.id,{status:'completed'})
 failed=true;await writeFile(join(dir,'upgrade-pause.json'),'{}');await scheduler.tick(owner,runs,start+360000);assert.equal((await runs.list()).length,2)
 failed=false;result=packet(true,'d'.repeat(64));await rm(join(dir,'upgrade-pause.json'));await scheduler.tick(owner,runs,start+361000);assert.equal((await runs.list()).length,3)
})
test('every preflight of one tick receives that tick\'s start; a manual trigger receives its own',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'schedule-preflight-since-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const seen:[string,number][]=[]
 const scheduler=new Scheduler(dir,async(id,_revision,since)=>{seen.push([id,since]);return packet(id==='lane-b','b'.repeat(64))}),runs=new RunStore(dir)
 const owner={telegramUserId:42,telegramChatId:42,pairedAt:new Date().toISOString()},start=Date.now()+10000
 const saved:Schedule[]=[]
 for(const id of ['lane-a','lane-b','lane-c']) saved.push(await scheduler.save({id,name:id,text:'Do role work',enabled:true,owner,execution:{sessionId:randomUUID(),preset:{id:'test',name:'test',cli:'codex',model:'fixture-model'}},trigger:{everySeconds:900,start:new Date(start).toISOString()},preflight:{on:'eligible' as const,checks:[{alias:'provider-work',args:['--field',`Lane=${id}`]}]}}))
 await scheduler.tick(owner,runs,start)
 assert.deepEqual(seen.map(([id])=>id).sort(),['lane-a','lane-b','lane-c']);assert.deepEqual(seen.map(([,since])=>since),[start,start,start])
 // Each schedule keeps its own receipt and admission.
 assert.deepEqual((await runs.list()).map(r=>r.scheduled?.id),['lane-b'])
 for(const s of saved) assert.equal((await scheduler.preflightReceipt(s)).eligible,s.id==='lane-b')
 seen.length=0;const before=Date.now()
 await assert.rejects(()=>scheduler.trigger('lane-a',saved[0].revision,'manual',owner,runs),/no eligible/)
 assert.ok(seen[0][1]>=before && seen[0][1]<=Date.now(),'a manual trigger never accepts an observation from before it was asked')
})
test('only bounded literal commands and fresh typed packets enter admission',()=>{
 assert.equal(validPreflight({on:'eligible',checks:[{alias:'queue',args:['x']}] }),true)
 assert.equal(validPreflight({on:'eligible',checks:[{alias:'queue',args:['x\nwrite']}] }),false)
 assert.throws(()=>combinePreflight([{schemaVersion:1,...packet(true),eligible:'true'}]),/Invalid/)
 assert.throws(()=>combinePreflight([{schemaVersion:1,...packet(true),observedAt:'2000-01-01T00:00:00Z'}]),/stale/)
 assert.equal(combinePreflight([{schemaVersion:1,...packet(false)},{schemaVersion:1,...packet(true)}]).eligible,true)
})

test('manual preflight before the first tick preserves future recurrence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'schedule-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const scheduler=new Scheduler(dir,async()=>packet(true)),runs=new RunStore(dir)
 const owner={telegramUserId:42,telegramChatId:42,pairedAt:new Date().toISOString()}
 const s=await scheduler.save({id:'manual',name:'Manual',text:'Work',enabled:true,owner,
  execution:{sessionId:randomUUID(),preset:{id:'test',name:'test',cli:'codex',model:'fixture-model'}},
  trigger:{everySeconds:60,start:new Date(Date.now()+60000).toISOString()},
  preflight:{on:'eligible',checks:[{alias:'provider-work',args:[]}]}})
 const next=await scheduler.pendingOccurrence(s)
 const manual=await scheduler.trigger(s.id,s.revision,'first',owner,runs)
 assert.equal(await scheduler.pendingOccurrence(s),next)
 await runs.patch(manual.id,{status:'completed'})
 await scheduler.tick(owner,runs,next!)
 assert.equal((await runs.list()).length,2)
})

test('a transient preflight failure keeps its occurrence due for a few minutes, then skips it',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'schedule-preflight-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let failed=true,calls=0
 const scheduler=new Scheduler(dir,async()=>{calls++;if(failed)throw Error('Broker unavailable');return packet(true,randomUUID().replaceAll('-','').padEnd(64,'0'))}),runs=new RunStore(dir)
 const owner={telegramUserId:42,telegramChatId:42,pairedAt:new Date().toISOString()},start=Date.now()+10000
 const input={id:'daily',name:'Daily',text:'Do role work',enabled:true,owner,execution:{sessionId:randomUUID(),preset:{id:'test',name:'test',cli:'codex',model:'fixture-model'}},trigger:{everySeconds:86400,start:new Date(start).toISOString()},preflight:{on:'eligible' as const,checks:[{alias:'provider-work',args:[]}]}}
 const s=await scheduler.save(input)
 await scheduler.tick(owner,runs,start);assert.equal(calls,1);assert.equal(await scheduler.pendingOccurrence(s),start,'the day is kept')
 await scheduler.tick(owner,runs,start+30000);assert.equal(calls,1,'no retry before its minute')
 failed=false;await scheduler.tick(owner,runs,start+60000)
 const [run]=await runs.list();assert.equal(run?.scheduled?.dueAt,new Date(start).toISOString(),'the recovered preflight runs the kept occurrence')
 // A failure that outlasts the window skips that occurrence as before.
 await runs.patch(run.id,{status:'completed'});failed=true;const next=start+86400000
 for(const offset of [0,60000,120000,180000,240000,300000])await scheduler.tick(owner,runs,next+offset)
 assert.equal(await scheduler.pendingOccurrence(s),next+86400000);assert.equal((await runs.list()).length,1)
})
