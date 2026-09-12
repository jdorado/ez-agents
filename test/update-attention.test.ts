import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {queueUpdateAttention} from '../src/update-attention.js'
import {RunStore} from '../src/runs.js'

test('maintenance requires an owner, deduplicates wakeups and never grants owner authority',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'ez-maintenance-'));t.after(()=>rm(dir,{recursive:true,force:true}));const runs=new RunStore(dir)
 await writeFile(path.join(dir,'update-attention.json'),JSON.stringify({id:'a'.repeat(64)}))
 await queueUpdateAttention(dir,null,runs);assert.equal((await runs.list()).length,0)
 const owner={telegramUserId:12,telegramChatId:12,pairedAt:new Date().toISOString()}
 await queueUpdateAttention(dir,owner,runs);await queueUpdateAttention(dir,owner,runs);assert.equal((await runs.list()).length,1)
 const run=(await runs.list())[0];assert.equal(run.telegramUserId,12);assert.equal(run.status,'queued')
 assert.match(run.texts[0],/not a new owner instruction/)
 await queueUpdateAttention(dir,{...owner,telegramUserId:13,telegramChatId:13},runs);assert.equal((await runs.list()).length,2)
 await writeFile(path.join(dir,'update-attention.json'),'{');await assert.rejects(queueUpdateAttention(dir,owner,runs))
 await writeFile(path.join(dir,'update-attention.json'),JSON.stringify({id:'../escape'}));await assert.rejects(queueUpdateAttention(dir,owner,runs))
})
