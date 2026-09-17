import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {stageTaskAttachment,readTaskAttachment,removeTaskAttachments,attachmentLimit} from '../src/task-attachments.js'
import {TelegramSource} from '../src/telegram-source.js'
import {Tasks} from '../src/tasks.js'
import {RunStore} from '../src/runs.js'
import {ControlStore} from '../src/control-state.js'
import {EventSources} from '../src/event-sources.js'
import {ApprovalStore} from '../src/approval.js'
import {ownerRun} from './helpers/owner-run.js'

test('file replies preserve bytes and receipts and cannot cross a run or revoked grant',async t=>{
 const dir=await mkdtemp('/tmp/ez-file-replies-'),sent:any[]=[]
 await ownerRun(dir,'owner')
 const source=new TelegramSource(dir,'999',async()=>{throw Error('Expected attachment')},async(chat,text,bytes,filename)=>{sent.push({chat,text,bytes,filename});return [77]})
 t.after(async()=>{await source.stop();await rm(dir,{recursive:true,force:true})})
 await source.start((await new ControlStore(dir,900000).status()).owner!)
 const tasks=new Tasks(dir),runs=new RunStore(dir),capabilities=[{id:'file',description:'Read approved files',command:'file',args:['--','{input}'],output:'file' as const}]
 const proposed:any=await tasks.ownerCall('owner','propose',{sourceId:'telegram',conversationId:'*',purpose:'Share requested files',context:'Approved files only',hours:24,waitForIncoming:true,untilRevoked:true,anyConversation:true,capabilities})
 const approval=new ApprovalStore(dir)
 assert.match((await approval.getDecision(proposed.id))!.prompt,/files returned by the approved file capabilities/)
 await approval.recordDecision(proposed.id,'approved',101);await tasks.decide(proposed.id)
 await source.capture(1,{message_id:1,date:Math.ceil(Date.now()/1000),chat:{id:-303,type:'group'},text:'Send manual'} as any,{id:202,is_bot:false,first_name:'Reader'})
 const registration=(await new EventSources(dir).list())[0]
 const external={sourceId:registration.id,bindingId:registration.bindingId,conversationId:'-303',eventIds:['tg_n303_1']}
 const run=await runs.create({id:'event_file',taskId:proposed.id,chatId:101,telegramUserId:101,texts:[],external})
 await runs.patch(run.id,{status:'running'})
 const begun:any=await tasks.workerCall(run.id,'capability_begin',{id:'file',input:'manual.pdf'})
 const bytes=Buffer.from('%PDF-1.7\n\x00\xfforiginal','latin1')
 const file=await stageTaskAttachment(dir,run.id,begun.lease,'manual.pdf',bytes)
 await tasks.workerCall(run.id,'capability_result',{id:'file',input:'manual.pdf',lease:begun.lease,attachment:file})
 const second=await runs.create({id:'event_other',taskId:proposed.id,chatId:101,telegramUserId:101,texts:[],external})
 await runs.patch(second.id,{status:'running'})
 await tasks.workerCall(second.id,'capability_begin',{id:'file',input:'another.pdf'})
 await assert.rejects(tasks.workerCall(second.id,'send',{key:'x',text:'PDF',attachmentId:file.id}),/not authorized/)
 await assert.rejects(tasks.workerCall(run.id,'send',{key:'long',text:'x'.repeat(1025),attachmentId:file.id}),/caption exceeds/)
 const args={key:'manual',text:'Requested manual',attachmentId:file.id}
 const first:any=await tasks.workerCall(run.id,'send',args)
 assert.equal(first.state,'accepted');assert.deepEqual(await tasks.workerCall(run.id,'send',args),first)
 assert.deepEqual(sent,[{chat:-303,text:'Requested manual',bytes,filename:'manual.pdf'}])
 await assert.rejects(tasks.workerCall(run.id,'send',{...args,attachmentId:randomUUID()}),/not authorized/)
 await tasks.ownerCall('owner','revoke',{taskId:proposed.id})
 await assert.rejects(tasks.workerCall(run.id,'send',{...args,key:'late'}),/inactive/)
 assert.equal(sent.length,1)
})

test('attachment staging rejects oversized bytes, traversal, symlinks and changed content',async t=>{
 const dir=await mkdtemp('/tmp/ez-file-boundaries-');t.after(()=>rm(dir,{recursive:true,force:true}))
 const file=await stageTaskAttachment(dir,'run',randomUUID(),'manual.pdf',Buffer.from('original'))
 assert.deepEqual(await readTaskAttachment(dir,file),Buffer.from('original'))
 assert.deepEqual(await stageTaskAttachment(dir,'run',file.id,'manual.pdf',Buffer.from('original')),file)
 await assert.rejects(stageTaskAttachment(dir,'../escape',randomUUID(),'x',Buffer.from('x')),/Invalid attachment run/)
 await assert.rejects(stageTaskAttachment(dir,'run','../escape','x',Buffer.from('x')),/Invalid task attachment/)
 await assert.rejects(stageTaskAttachment(dir,'run',randomUUID(),'x',Buffer.alloc(attachmentLimit+1)),/Invalid task attachment/)
 await assert.rejects(stageTaskAttachment(dir,'run',randomUUID(),'x',Buffer.alloc(attachmentLimit)),/run limit/)
 const path=join(dir,'task-files','run',file.id)
 await writeFile(path,'modified');await assert.rejects(readTaskAttachment(dir,file),/changed/)
 await rm(path);await symlink('/etc/passwd',path);await assert.rejects(readTaskAttachment(dir,file))
 await removeTaskAttachments(dir,'run');await assert.rejects(readTaskAttachment(dir,file))
})

test('an uncertain document send retains its receipt and never resends',async t=>{
 const dir=await mkdtemp('/tmp/ez-file-uncertain-');let calls=0
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const source=new TelegramSource(dir,'999',async()=>[],async()=>{calls++;throw Error('Lost response')})
 await ownerRun(dir,'owner');await source.start((await new ControlStore(dir,900000).status()).owner!)
 t.after(()=>source.stop())
 await source.call('task-watch',{accountId:'999',conversationId:'-303',expiresAt:Date.now()+60000})
 const attachment=await stageTaskAttachment(dir,'run',randomUUID(),'manual.pdf',Buffer.from('%PDF'))
 const args={accountId:'999',conversationId:'-303',text:'Manual',key:'one',attachment}
 await assert.rejects(source.call('task-send',args),/Lost response/)
 assert.equal((await source.call('task-send',args)).state,'uncertain');assert.equal(calls,1)
 await assert.rejects(source.call('task-send',{...args,attachment:{...attachment,filename:'other.pdf'}}),/Key reused/)
})
