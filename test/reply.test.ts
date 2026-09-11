import test from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ownerRun } from './helpers/owner-run.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'
import { replyCall } from '../src/reply-context.js'
import { taskArguments, taskDisabledFeatures } from '../src/task-executor.js'

test('busy reply tools are owner-bound, read-only except one reply and one durable handoff', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ez-reply-test-')), runs = new RunStore(root)
 try {
  await ownerRun(root,'tg_1')
  await runs.patch('tg_1',{replyOnly:true})
  await mkdir(join(root,'outbox'),{recursive:true})
  await writeFile(join(root,'SOUL.md'),'Test agent')
  const context = await replyCall(root,'tg_1',root,'context',{}) as any
  assert.equal(context.agent,'Test agent')
  await replyCall(root,'tg_1',root,'send',{text:'Actual status'})
  await replyCall(root,'tg_1',root,'send',{text:'Duplicate'})
  assert.equal((await runs.pendingOutbox()).length,1)
  assert.equal((await runs.pendingOutbox())[0].text,'Actual status')
  await assert.rejects(replyCall(root,'tg_1',root,'exec',{text:'touch file'}),/Unknown/)
  await assert.rejects(replyCall(root,'tg_1',root,'send',{text:'bad',chatId:202}),/Unexpected/)
  await ownerRun(root,'tg_2')
  await assert.rejects(replyCall(root,'tg_2',root,'context',{}),/Invalid reply/)
  await assert.rejects(replyCall(root,'../tg_1',root,'context',{}))
  await new ControlStore(root,900000).revokeOwner()
  await assert.rejects(replyCall(root,'tg_1',root,'send',{text:'after revoke'}),/owner-mismatch/)
 } finally { await rm(root,{recursive:true,force:true}) }
})

test('reply native adapter exposes only context send defer with shell and network disabled', () => {
 const args = taskArguments('/tmp/reply/workspace',['node','broker'],'prompt',['context','send','defer']).join(' ')
 assert.match(args,/enabled_tools=\["context","send","defer"\]/)
 assert.match(args,/network.enabled=false/)
 assert.match(args,/ignore-user-config/)
 assert.match(args,/ignore-rules/)
 assert.match(args,/ephemeral/)
 for (const name of ['shell_tool','unified_exec','code_mode','multi_agent','apps']) assert.ok(taskDisabledFeatures.includes(name))
 assert.doesNotMatch(args,/--add-dir/)
})

test('reply handoff deduplicates the owner request and defaults independently to Terra high', async () => {
 const root=await mkdtemp(join(tmpdir(),'ez-reply-defer-')), runs=new RunStore(root)
 try {
  const control=new ControlStore(root,900000)
  await control.requestPairing(101,101);await control.approveOwner(101)
  const execution={sessionId:'c5dd1edc-be24-47b8-a579-0bc70f44cf43',preset:{id:'codex',name:'Codex',cli:'codex',model:'gpt-6-astra',effort:'low'}}
  await runs.create({id:'tg_4',chatId:101,telegramUserId:101,texts:['Make the report'],execution})
  await runs.patch('tg_4',{status:'running',replyOnly:true})
  const first=await replyCall(root,'tg_4',root,'defer',{text:'Prepare the report using the canonical sources'})
  assert.deepEqual(await replyCall(root,'tg_4',root,'defer',{text:'retry'}),first)
  const saved=JSON.parse(await readFile(join(root,'schedules','s_reply_tg_4.json'),'utf8'))
  assert.equal(saved.execution.preset.model,'gpt-5.6-terra')
  assert.equal(saved.execution.preset.effort,'high')
  assert.notEqual(saved.execution.sessionId,execution.sessionId)
  assert.match(saved.text,/Make the report/)
  assert.equal(saved.owner.telegramChatId,101)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('active work cannot be hidden by newer failures and completed background replies remain visible', async () => {
 const root=await mkdtemp(join(tmpdir(),'ez-reply-history-')), runs=new RunStore(root)
 try{
  await ownerRun(root,'tg_1');await runs.patch('tg_1',{replyOnly:true})
  await ownerRun(root,'r_work')
  for(let n=0;n<35;n++){await ownerRun(root,'r_failed_'+n);await runs.patch('r_failed_'+n,{status:'failed'})}
  await mkdir(join(root,'outbox'),{recursive:true})
  await writeFile(join(root,'outbox','r_failed_34_result.sent.json'),JSON.stringify({chatId:101,runId:'r_failed_34',text:'Background result',createdAt:new Date().toISOString()}))
  const context=await replyCall(root,'tg_1',root,'context',{}) as any
  assert.ok(context.work.some((r:any)=>r.id==='r_work'))
  assert.ok(context.replies.some((r:any)=>r.text==='Background result'))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('reply-only deadline terminates a stalled reply process', async()=>{
 const { spawn }=await import('node:child_process')
 const { replyDeadline }=await import('../src/reply-executor.js')
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true})
 await once(child,'spawn')
 const close=once(child,'close'),clear=replyDeadline(child,25)
 try{await close;assert.notEqual(child.signalCode,null)}finally{clear();child.kill()}
})


test('a successful native exit without a reply receipt is not completion', async()=>{
 const { requireReplyReceipt }=await import('../src/reply-executor.js')
 const root=await mkdtemp(join(tmpdir(),'ez-reply-receipt-'))
 try{
  await assert.rejects(requireReplyReceipt(root,'tg_1'),/without an answer/)
  await mkdir(join(root,'outbox'))
  await writeFile(join(root,'outbox','tg_1_busy_reply.sent.json'),'{}')
  await requireReplyReceipt(root,'tg_1')
  await assert.rejects(requireReplyReceipt(root,'../escape'))
 }finally{await rm(root,{recursive:true,force:true})}
})


test('normal conversation receives delivered parallel replies as historical context', async()=>{
 const { parallelReplyHistory }=await import('../src/reply-context.js')
 const root=await mkdtemp(join(tmpdir(),'ez-reply-continuity-')),runs=new RunStore(root)
 try{
  await ownerRun(root,'tg_1');await runs.patch('tg_1',{replyOnly:true})
  await mkdir(join(root,'outbox'),{recursive:true})
  await writeFile(join(root,'outbox','tg_1_busy_reply.sent.json'),JSON.stringify({chatId:101,text:'Earlier answer'}))
  const current=await ownerRun(root,'tg_2')
  assert.deepEqual(await parallelReplyHistory(root,current),[{owner:'test',reply:'Earlier answer'}])
  assert.deepEqual(await parallelReplyHistory(root,{...current,chatId:202}),[])
 }finally{await rm(root,{recursive:true,force:true})}
})


test('a parallel reply delivered during a normal turn is retained for the following turn', async()=>{
 const { parallelReplyHistory }=await import('../src/reply-context.js')
 const root=await mkdtemp(join(tmpdir(),'ez-reply-late-')),runs=new RunStore(root)
 try{
  await ownerRun(root,'tg_1');await runs.patch('tg_1',{replyOnly:true,status:'completed'})
  await ownerRun(root,'tg_2');await runs.patch('tg_2',{status:'completed',startedAt:'2026-09-10T06:00:00.000Z'})
  const current=await ownerRun(root,'tg_3')
  await mkdir(join(root,'outbox'),{recursive:true})
  const file=join(root,'outbox','tg_1_busy_reply.sent.json')
  await writeFile(file,JSON.stringify({chatId:101,text:'Late answer',receipt:{deliveredAt:'2026-09-10T06:00:01.000Z'}}))
  assert.equal((await parallelReplyHistory(root,current))[0].reply,'Late answer')
  await writeFile(file,JSON.stringify({chatId:101,text:'Old answer',receipt:{deliveredAt:'2026-09-10T05:59:59.000Z'}}))
  assert.deepEqual(await parallelReplyHistory(root,current),[])
 }finally{await rm(root,{recursive:true,force:true})}
})


test('reply handoff accepts independent worker choices and rejects invalid or unauthorized overrides', async () => {
 const root=await mkdtemp(join(tmpdir(),'ez-reply-worker-')), runs=new RunStore(root)
 try {
  await ownerRun(root,'owner')
  await runs.create({id:'tg_10',chatId:101,telegramUserId:101,texts:['Analyze the report'],execution:{sessionId:'c5dd1edc-be24-47b8-a579-0bc70f44cf43',preset:{id:'chat',name:'Chat',cli:'codex',model:'gpt-5.6-sol',effort:'medium'}}})
  await runs.patch('tg_10',{status:'running',replyOnly:true})
  for (const args of [{model:42}, {model:'bad model'}, {effort:'ultra'}, {effort:'invalid'}, {cli:'claude'}])
   await assert.rejects(replyCall(root,'tg_10',root,'defer',{text:'Analyze and verify the result',...args}))
  await assert.rejects(replyCall(root,'tg_10',root,'send',{text:'Hello',model:'gpt-6-astra'}),/Unexpected/)
  await replyCall(root,'tg_10',root,'defer',{text:'Analyze and verify the result',model:'gpt-6-astra',effort:'high'})
  const file=join(root,'schedules','s_reply_tg_10.json')
  const saved=JSON.parse(await readFile(file,'utf8'))
  assert.equal(saved.execution.preset.model,'gpt-6-astra')
  assert.equal(saved.execution.preset.effort,'high')
  await replyCall(root,'tg_10',root,'defer',{text:'retry',model:'gpt-5.6-sol',effort:'low'})
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),saved)
  await new ControlStore(root,900000).revokeOwner()
  await assert.rejects(replyCall(root,'tg_10',root,'defer',{text:'after revocation',model:'gpt-6-astra'}),/owner-mismatch/)
 } finally { await rm(root,{recursive:true,force:true}) }
})
