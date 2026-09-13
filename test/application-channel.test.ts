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
import { ControlStore } from '../src/control-state.js'
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
  const channel=new ApplicationChannel({controlDir:root,initial:initialPreset('codex'),wake:()=>{wakes++},cancel:async id=>{await runs.patch(id,{status:'cancelled'})}})
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
  assert.deepEqual((await channel.snapshot(first.bindingId,run.id)).messages,[{id:message.id,text:'Here is the proposal'}])
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
  assert.ok(prompts[0].startsWith('Hello from the app'))
  assert.ok(prompts[0].includes('[Application channel]'))
  assert.ok(!prompts[0].includes('must-stay-out-of-prompt'))
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
