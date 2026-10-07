import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Scheduler} from '../src/scheduler.js'
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
})
test('only bounded literal commands and fresh typed packets enter admission',()=>{
 assert.equal(validPreflight({on:'eligible',checks:[{alias:'queue',args:['x']}] }),true)
 assert.equal(validPreflight({on:'eligible',checks:[{alias:'queue',args:['x\nwrite']}] }),false)
 assert.throws(()=>combinePreflight([{schemaVersion:1,...packet(true),eligible:'true'}]),/Invalid/)
 assert.throws(()=>combinePreflight([{schemaVersion:1,...packet(true),observedAt:'2000-01-01T00:00:00Z'}]),/stale/)
 assert.equal(combinePreflight([{schemaVersion:1,...packet(false)},{schemaVersion:1,...packet(true)}]).eligible,true)
})
