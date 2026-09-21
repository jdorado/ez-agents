import test from 'node:test'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ApplicationChannel, ApplicationBindings, applicationScope } from '../src/application-channel.js'
import { ControlStore, ownerId } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
import { requireOwnerExecution } from '../src/execution-authority.js'
import { createRelay } from '../src/index.js'
import { EXECUTOR_REGISTRY, executorEnvironment } from '../src/executor.js'

const token = () => randomBytes(32).toString('base64url')
const owner = async (dir: string) => {
  const control = new ControlStore(dir,1000)
  await control.requestPairing(42,42); await control.approveOwner(42)
  return (await control.status()).owner!
}
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let attempt=0; attempt<200; attempt++) { if (await condition()) return; await new Promise(resolve=>setTimeout(resolve,10)) }
  throw new Error('Timed out waiting for application run')
}

test('HTTP auth, idempotency, origin/context isolation, revocation and persisted scope continuity', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-app-channel-'))
  const owned=await owner(root), runs=new RunStore(root), control=new ControlStore(root,1000)
  let wakes=0
  const channel=new ApplicationChannel({controlDir:root,initial:initialPreset('codex'),wake:()=>{wakes++},cancel:async id=>{await runs.patch(id,{status:'cancelled'})},createTelegramPairing:async()=>{throw new Error('unavailable')},telegramAvailable:()=>false})
  t.after(async()=>{await channel.stop();await rm(root,{recursive:true,force:true})})
  const firstToken=token(), secondToken=token()
  const first=(await channel.bindings.register('first',firstToken,owned))!
  const second=(await channel.bindings.register('second',secondToken,owned))!
  const address=await channel.listen(0) as {port:number}
  const url=`http://127.0.0.1:${address.port}`
  const request=(path:string,bearer:string,body?:unknown)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${bearer}`},...(body===undefined?{}:{body:JSON.stringify(body)})})
  assert.equal((await request('/v1/runs','bad',{})).status,401)
  assert.equal((await runs.list()).length,0)
  const input={requestId:'request-1',scope:'person:program',text:'Discuss next lesson',context:{capability:'not-a-prompt',reference:'lesson'}}
  const created=await request('/v1/runs',firstToken,input)
  assert.equal(created.status,202)
  const result=await created.json() as {id:string}
  const retry=await request('/v1/runs',firstToken,{...input,context:{capability:'replacement'}})
  assert.equal((await retry.json() as {id:string}).id,result.id)
  assert.equal(wakes,1)
  const unicode=Buffer.from(JSON.stringify({...input,requestId:'unicode',text:'Café lesson'}))
  const split=unicode.indexOf(Buffer.from('é'))+1
  const unicodeResponse=await new Promise<string>((resolve,reject)=>{
    const req=httpRequest(url+'/v1/runs',{method:'POST',headers:{Authorization:`Bearer ${firstToken}`}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(body))
    });req.on('error',reject);req.write(unicode.subarray(0,split));setTimeout(()=>req.end(unicode.subarray(split)),20)
  })
  assert.equal((await runs.get(JSON.parse(unicodeResponse).id))?.texts[0],'Café lesson')

  assert.equal((await runs.get(result.id))?.application?.context?.capability,'not-a-prompt')
  assert.equal((await request('/v1/runs',firstToken,{...input,text:'changed'})).status,409)
  assert.equal((await request('/v1/runs',firstToken,{...input,scope:'other'})).status,409)
  assert.equal((await request(`/v1/runs/${result.id}`,secondToken)).status,404)
  assert.equal((await request(`/v1/runs/${result.id}/cancel`,secondToken,{})).status,404)
  assert.equal((await request('/v1/runs',firstToken,{...input,requestId:'../escape'})).status,400)
  assert.equal((await request('/v1/runs',firstToken,{...input,requestId:'extra',workspace:'/etc'})).status,400)
  const run=(await runs.get(result.id))!
  assert.equal(run.messageId,undefined)
  assert.equal(run.external,undefined)
  await runs.patch(run.id,{status:'running'})
  assert.equal((await requireOwnerExecution(root,run.id)).application?.scope,input.scope)
  await control.saveNativeSession(run.execution!.sessionId,'native_scope_one')
  const later=await channel.submit(first.bindingId,{...input,requestId:'later'})
  assert.equal(later.execution?.sessionId,run.execution?.sessionId)
  assert.equal((await new ControlStore(root,1000).executionSession(later.execution!)).nativeSessionId,'native_scope_one')
  const otherScope=await channel.submit(first.bindingId,{...input,requestId:'other-scope',scope:'different'})
  const otherBinding=await channel.submit(second.bindingId,input)
  assert.notEqual(otherScope.execution?.sessionId,run.execution?.sessionId)
  assert.notEqual(otherBinding.execution?.sessionId,run.execution?.sessionId)
  assert.equal((await control.listSessions()).length,0,'app conversations do not replace or appear in Telegram selector')
  const telegram=await control.captureChoice(initialPreset('codex'))
  assert.notEqual(telegram.sessionId,run.execution?.sessionId)
  const message=await runs.enqueueMessage(run.id,'Here is the proposal')
  await runs.claimOutbox(message.id)
  await channel.deliver(run,message)
  assert.deepEqual(await runs.waitForDelivery(message.id),{delivered:true})
  const snapshot=await channel.snapshot(first.bindingId,run.id)
  assert.deepEqual(snapshot.messages,[{id:message.id,text:'Here is the proposal'}])
  assert.deepEqual(snapshot.preset,run.execution?.preset)
  const approval=await runs.enqueueApproval(run.id,'Allow this channel grant?','task_'+'a'.repeat(32))
  await runs.claimOutbox(approval.id);await channel.deliver(run,approval)
  assert.deepEqual((await channel.snapshot(first.bindingId,run.id)).approvals,[{id:'task_'+'a'.repeat(32),prompt:'Allow this channel grant?',state:'delivered'}])
  assert.equal((await request('/v1/approvals/task_'+'a'.repeat(32),secondToken,{decision:'approved'})).status,400)
  await channel.bindings.register('first',null,owned)
  await assert.rejects(requireOwnerExecution(root,run.id),/revoked/)
  await assert.rejects(channel.deliver(run,message),/revoked/)
  assert.equal((await request(`/v1/runs/${run.id}`,firstToken)).status,401)
  await writeFile(join(root,'application-bindings.json'),'{')
  assert.equal((await request('/v1/runs',secondToken,input)).status,401)
})

test('owner replacement invalidates binding and client secrets never enter native environment',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ez-app-owner-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const first=await owner(root), bindings=new ApplicationBindings(root), secret=token()
  await bindings.register('app',secret,first)
  await new ControlStore(root,1000).revokeOwner()
  await assert.rejects(bindings.authenticate(secret),/Unauthorized/)
  assert.equal(executorEnvironment({TELEGRAM_BOT_TOKEN:'telegram-secret',EZ_APPLICATION_TOKEN:secret,PATH:'/bin'}).EZ_APPLICATION_TOKEN,undefined)
  assert.equal(executorEnvironment({TELEGRAM_BOT_TOKEN:'telegram-secret'}).TELEGRAM_BOT_TOKEN,undefined)
})

test('app run uses real core executor process, scoped native resume and outbox without Telegram delivery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ez-app-executor-'))
  const original=EXECUTOR_REGISTRY.codex
  const prompts:string[]=[], resumeIds:(string|undefined)[]=[]
  const require=createRequire(import.meta.url)
  const fixture=join(root,'engine.mjs')
  const nativeId='11111111-1111-1111-1111-111111111111'
  await writeFile(fixture,`import {spawnSync} from 'node:child_process';
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(nativeId)}}));
const result=spawnSync(process.execPath,[${JSON.stringify(fileURLToPath(new URL('../bin/ezenciel-agents-message.mjs',import.meta.url)))},'--text','Fixture engine reply'],{env:process.env,encoding:'utf8'});
if(result.status!==0){console.error(result.stderr);process.exit(1)};
`)
  EXECUTOR_REGISTRY.codex={...original,command:process.execPath,buildArgs:(options,_file,prompt)=>{prompts.push(prompt);resumeIds.push(options.isResume?options.sessionId:undefined);return ['--import',require.resolve('tsx'),fixture]}}
  const relay=createRelay({controlDir:root,workspace:root,pairingTtlMs:1000,telegramBotToken:'fixture',executorTimeoutMs:0,executorCli:'codex'})
  let telegramCalls=0
  relay.bot.api.config.use(async()=>{telegramCalls++;return {ok:true,result:{message_id:1}} as never})
  const owned=await owner(root), secret=token()
  const binding=(await relay.applicationChannel.bindings.register('app',secret,owned))!
  const drain=setInterval(()=>void relay.drainOutbox(),10)
  t.after(async()=>{clearInterval(drain);await relay.stop();EXECUTOR_REGISTRY.codex=original;await rm(root,{recursive:true,force:true})})
  const first=await relay.applicationChannel.submit(binding.bindingId,{requestId:'one',scope:'program',text:'Hello from the app',context:{secret:'must-stay-out-of-prompt'}})
  await waitFor(async()=> (await new RunStore(root).get(first.id))?.status==='completed')
  const second=await relay.applicationChannel.submit(binding.bindingId,{requestId:'two',scope:'program',text:'Continue'})
  await waitFor(async()=> (await new RunStore(root).get(second.id))?.status==='completed')
  assert.deepEqual(resumeIds,[undefined,nativeId])
  assert.equal(telegramCalls,0)
  const expectedApp='Hello from the app\n\n[chat] Reply via ezenciel-agents-message --text "..."; stdout is not delivered.\n\n[application scope "program"]'
  assert.equal(prompts[0],expectedApp)
  assert.equal(Buffer.byteLength(prompts[0],'utf8'),Buffer.byteLength(expectedApp,'utf8'))
  assert.ok(!prompts[0].includes('must-stay-out-of-prompt'))
  for (const banned of ['delegate','subagent','schedule','acknowledge','responsive','Domain tools','credentials','reactions','Outgoing','[Application channel]','[Chat context]']) assert.ok(!prompts[0].includes(banned),`app prompt must not contain ${banned}`)
  assert.equal((await relay.applicationChannel.snapshot(binding.bindingId,second.id)).messages[0].text,'Fixture engine reply')
})


test('packaged admin command discovery and existing core child cancellation',async t=>{
  const help=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/ezenciel-agents-application.mjs',import.meta.url)),'--help'],{encoding:'utf8'})
  assert.equal(help.status,0,help.stderr)
  assert.match(help.stdout,/--token-file/)
  const root=await mkdtemp(join(tmpdir(),'ez-app-cancel-')), original=EXECUTOR_REGISTRY.codex
  EXECUTOR_REGISTRY.codex={...original,command:process.execPath,buildArgs:()=>['-e','setInterval(()=>{},1000)']}
  const relay=createRelay({controlDir:root,workspace:root,pairingTtlMs:1000,telegramBotToken:'fixture',executorTimeoutMs:0,executorCli:'codex'})
  t.after(async()=>{await relay.stop();EXECUTOR_REGISTRY.codex=original;await rm(root,{recursive:true,force:true})})
  const owned=await owner(root),secret=token(),binding=(await relay.applicationChannel.bindings.register('app',secret,owned))!
  const address=await relay.applicationChannel.listen(0) as {port:number}
  const run=await relay.applicationChannel.submit(binding.bindingId,{requestId:'cancel',scope:'scope',text:'Wait'})
  await waitFor(async()=> (await new RunStore(root).get(run.id))?.status==='running')
  const response=await fetch(`http://127.0.0.1:${address.port}/v1/runs/${run.id}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${secret}`}})
  assert.equal(response.status,200)
  await waitFor(async()=> (await new RunStore(root).get(run.id))?.status==='cancelled')
})

test('native history assertion blocks accidental fresh cutover without choosing a native session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = await owner(root), control = new ControlStore(root, 1000)
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), owned))!
  const input = { requestId: 'job', scope: 'main', text: 'Continue', expectedNativeSessionId: 'existing-native' }
  await assert.rejects(channel.submit(binding.bindingId, input), /import the existing scope/)
  assert.equal((await new RunStore(root).list()).length, 0)
  const choice = await control.captureApplicationChoice(initialPreset('codex'), applicationScope(binding.bindingId, 'main'))
  await control.saveNativeSession(choice.sessionId, 'existing-native')
  const run = await channel.submit(binding.bindingId, input)
  assert.equal((await channel.snapshot(binding.bindingId, run.id)).nativeSessionId, 'existing-native')
  await assert.rejects(channel.submit(binding.bindingId, { ...input, requestId: 'other', expectedNativeSessionId: 'someone-else' }), /conflicts/)
})

test('explicit shared channel grant resumes one native session from app and Telegram', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-shared-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = await owner(root), control = new ControlStore(root, 1000)
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), owned, true))!
  const input = { requestId: 'app-1', scope: 'biology', text: 'Continue', activateTelegram: true }
  const app = await channel.submit(binding.bindingId, input)
  await control.saveNativeSession(app.execution!.sessionId, 'biology-history')
  const telegram = await control.captureChoice(initialPreset('codex'))
  assert.equal(telegram.sessionId, app.execution!.sessionId)
  assert.equal((await control.executionSession(telegram)).nativeSessionId, 'biology-history')
  const selection = await channel.submit(binding.bindingId, { ...input, requestId: 'selection', scope: 'selection:1', activateTelegram: false })
  assert.notEqual(selection.execution!.sessionId, telegram.sessionId)
  assert.equal((await control.captureChoice(initialPreset('codex'))).sessionId, telegram.sessionId)
  const appAgain = await channel.submit(binding.bindingId, { ...input, requestId: 'app-2' })
  assert.equal(appAgain.execution!.sessionId, telegram.sessionId)
  assert.equal((await control.listSessions()).filter(s => s.sessionId === telegram.sessionId).length, 1)
  const other = (await channel.bindings.register('private', token(), owned))!
  await channel.submit(other.bindingId, { ...input, requestId: 'private' })
  assert.equal((await control.captureChoice(initialPreset('codex'))).sessionId, telegram.sessionId, 'an unshared app cannot switch Telegram')
})

test('application AI choice retains same-engine history and rejects cross-engine resume and changed retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-ai-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), await owner(root)))!
  const input = { requestId: 'one', scope: 'main:codex', text: 'Hello', ai: { cli: 'codex', provider:'openrouter', model: 'gpt-5.6-luna', effort: 'high' } }
  const first = await channel.submit(binding.bindingId, input)
  assert.equal(first.execution!.preset.provider,'openrouter')
  assert.equal(first.execution!.preset.model, input.ai.model)
  const second = await channel.submit(binding.bindingId, { ...input, requestId: 'two', ai: { ...input.ai, model: 'gpt-5.6-terra' } })
  assert.equal(first.execution!.sessionId, second.execution!.sessionId)
  await assert.rejects(channel.submit(binding.bindingId, { ...input, ai: { ...input.ai, model: 'gpt-5.6-terra' } }), /conflicts/)
  await assert.rejects(channel.submit(binding.bindingId, { ...input, requestId: 'three', ai: { cli: 'grok' } }), /engine/)
})

test('rejected history assertion cannot activate Telegram and incomplete native metadata does not hide cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-assertion-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = await owner(root), control = new ControlStore(root, 1000)
  const before = await control.captureChoice(initialPreset('codex'))
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), owned, true))!
  const input = { requestId: 'one', scope: 'main', text: 'Hello', activateTelegram: true, expectedNativeSessionId: 'old-native' }
  await assert.rejects(channel.submit(binding.bindingId, input), /import/)
  assert.equal((await control.captureChoice(initialPreset('codex'))).sessionId, before.sessionId)
  const run = await channel.submit(binding.bindingId, { ...input, expectedNativeSessionId: undefined })
  await control.markSessionStarted(run.execution!.sessionId)
  assert.equal((await channel.snapshot(binding.bindingId, run.id)).id, run.id)
})

test('HTTP admission errors distinguish absent work from an existing conflicting run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-admission-'))
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  t.after(async () => { await channel.stop(); await rm(root, { recursive: true, force: true }) })
  const credential = token()
  await channel.bindings.register('app', credential, await owner(root))
  const address = await channel.listen(0) as { port: number }
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify(body) })
  const input = { requestId: 'same', scope: 'main', text: 'Hello' }
  const rejected = await post({ ...input, expectedNativeSessionId: 'unimported' })
  assert.equal(rejected.status, 409)
  assert.equal((await rejected.json() as { admitted: boolean }).admitted, false)
  const accepted = await post(input)
  const run = await accepted.json() as { id: string }
  const conflict = await post({ ...input, text: 'Changed' })
  const error = await conflict.json() as { admitted: boolean; runId: string }
  assert.equal(error.admitted, true); assert.equal(error.runId, run.id)
})

test('following Telegram uses current conversation and model, but retries retain admitted work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-follow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = await owner(root), control = new ControlStore(root, 1000)
  const initial = initialPreset('codex')
  const channel = new ApplicationChannel({ controlDir: root, initial, wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), owned, true))!
  const input = { requestId: 'first', scope: 'main', text: 'Continue', followTelegram: true }
  const current = await control.captureChoice(initial)
  const first = await channel.submit(binding.bindingId, input)
  assert.deepEqual(first.execution, current)
  await control.resetSession()
  const selected = { ...initial, id: 'different', name: 'Different', model: 'gpt-6-astra', effort: 'high' }
  await control.savePreset(selected)
  await control.selectPreset(selected.id, (await control.getActiveSession())!.sessionId)
  const next = await channel.submit(binding.bindingId, { ...input, requestId: 'second' })
  assert.notEqual(next.execution!.sessionId, first.execution!.sessionId)
  assert.equal(next.execution!.preset.effort, 'high')
  assert.equal(next.execution!.preset.model, 'gpt-6-astra')
  assert.deepEqual((await channel.submit(binding.bindingId, input)).execution, first.execution)
  await assert.rejects(channel.submit(binding.bindingId, { ...input, followTelegram: false }), /conflicts/)
  const detail = await channel.submit(binding.bindingId, { requestId: 'detail', scope: 'exercise', text: 'Discuss' })
  assert.notEqual(detail.execution!.sessionId, next.execution!.sessionId)
  assert.equal((await control.getActiveSession())!.sessionId, next.execution!.sessionId)
})

test('following Telegram requires an explicit sharing grant and cannot override selected state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-follow-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = await owner(root)
  const channel = new ApplicationChannel({ controlDir: root, initial: initialPreset('codex'), wake: () => {}, cancel: async () => {} })
  const binding = (await channel.bindings.register('app', token(), owned))!
  const input = { requestId: 'one', scope: 'main', text: 'Continue', followTelegram: true }
  await assert.rejects(channel.submit(binding.bindingId, input), /authority/)
  const shared = (await channel.bindings.register('shared', token(), owned, true))!
  for (const extra of [{ ai: { cli: 'codex' } }, { activateTelegram: true }, { expectedNativeSessionId: 'old' }, { followTelegram: 'true' }]) {
    await assert.rejects(channel.submit(shared.bindingId, { ...input, ...extra }), /Invalid application/)
  }
  assert.equal((await new RunStore(root).list()).length, 0)
})

test('generic attachments stage after auth, preserve literal comments and reject retry/isolation failures', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-app-attachment-'))
  const owned=await owner(root), runs=new RunStore(root)
  const channel=new ApplicationChannel({controlDir:root,workspace:root,initial:initialPreset('codex'),wake:()=>{},cancel:async()=>{}})
  t.after(async()=>{await channel.stop();await rm(root,{recursive:true,force:true})})
  const secret=token(), other=token()
  const binding=(await channel.bindings.register('web',secret,owned,true))!
  await channel.bindings.register('other',other,owned)
  const address=await channel.listen(0) as {port:number}
  const post=(body:unknown,bearer=secret)=>fetch(`http://127.0.0.1:${address.port}/v1/runs`,{method:'POST',headers:{Authorization:`Bearer ${bearer}`},body:JSON.stringify(body)})
  const input={requestId:'image',scope:'chat',followOwner:true,text:'  /goal literal\n comment  ',attachment:{name:'image.png',data:Buffer.from('89504e470d0a1a0a','hex').toString('base64')}}
  assert.equal((await post(input,'bad')).status,401)
  const {readdir,stat}=await import('node:fs/promises')
  await assert.rejects(readdir(join(root,'inbox')),/ENOENT/)
  for (const [name,bytes] of [['image.png',Buffer.from('89504e470d0a1a0a','hex')],['file.pdf',Buffer.from('%PDF-1.4\nfixture')],['notes.md',Buffer.from('# Fixture')]] as const) {
    const body={...input,requestId:name,attachment:{name,data:bytes.toString('base64')}}
    const response=await post(body);assert.equal(response.status,202)
    const snapshot=await response.json() as {id:string}
    const run=(await runs.get(snapshot.id))!
    assert.equal(run.ownerId,ownerId(owned))
    assert.equal(run.application?.inputText,input.text)
    assert.ok(run.texts[0].endsWith(`Caption: ${input.text}`))
    const path=run.texts[0].match(/staged at (inbox\/[^ ]+)/)![1]
    assert.deepEqual(await readFile(join(root,path)),bytes)
    assert.equal((await stat(join(root,path))).mode & 0o777,0o600)
    const before=(await readdir(join(root,'inbox'))).length
    assert.equal((await post(body)).status,202)
    assert.equal((await readdir(join(root,'inbox'))).length,before)
    assert.equal((await post({...body,text:'changed'})).status,409)
    assert.equal((await post({...body,attachment:{name,data:Buffer.from('changed').toString('base64')}})).status,409)
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/runs/${snapshot.id}`,{headers:{Authorization:`Bearer ${other}`}})).status,404)
  }
  const control=new ControlStore(root,1000)
  const priorSession=(await control.status()).activeSession
  const invalidActivation=await post({...input,requestId:'invalid-activation',followOwner:false,activateTelegram:true,scope:'new-scope',attachment:{name:'x.exe',data:Buffer.from('text').toString('base64')}})
  assert.equal(invalidActivation.status,400)
  assert.deepEqual((await control.status()).activeSession,priorSession)
  const before=(await readdir(join(root,'inbox'))).length
  for (const attachment of [{name:'x.exe',data:Buffer.from('text').toString('base64')},{name:'x.txt',data:'%%%invalid'},{name:'x.txt',data:Buffer.alloc(10*1024*1024+1,65).toString('base64')}]) {
    assert.equal((await post({...input,requestId:'bad',attachment})).status,400)
  }
  assert.equal((await readdir(join(root,'inbox'))).length,before)
  await channel.bindings.register('web',null,owned)
  await assert.rejects(channel.submit(binding.bindingId,{...input,requestId:'revoked'}),/revoked/)
  assert.equal((await readdir(join(root,'inbox'))).length,before)
})
