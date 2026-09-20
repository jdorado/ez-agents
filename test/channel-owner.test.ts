import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ControlStore, ownerId, ownerEpoch, sameOwner } from '../src/control-state.js'
import { ApplicationChannel } from '../src/application-channel.js'
import { RunStore } from '../src/runs.js'
import { Scheduler } from '../src/scheduler.js'
import { initialPreset } from '../src/ai.js'
import { ownsRun, isOwner } from '../src/identity.js'
import { createRelay } from '../src/index.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'
import { loadConfig } from '../src/config.js'

const secret = () => randomBytes(32).toString('base64url')
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i=0;i<500;i++) { if (await check()) return; await new Promise(resolve=>setTimeout(resolve,10)) }
  throw new Error('Timed out waiting for native delivery')
}

test('one owner links channels, rotates credentials and unlinks Telegram without resetting native continuity', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-channel-owner-'))
  const control=new ControlStore(root,60000), runs=new RunStore(root)
  const channel=new ApplicationChannel({controlDir:root,initial:initialPreset('codex'),wake:()=>{},cancel:async()=>{}})
  t.after(async()=>{await channel.stop();await rm(root,{recursive:true,force:true})})
  const owner=await control.registerOwner('verified-account')
  assert.equal(owner.telegramUserId,undefined)
  assert.deepEqual(await control.registerOwner('verified-account'),owner)
  await assert.rejects(control.registerOwner('other-account'),/different owner/)
  const webToken=secret(), phoneToken=secret()
  const web=(await channel.bindings.register('web',webToken,owner,true))!
  const phone=(await channel.bindings.register('phone',phoneToken,owner,true))!
  await assert.rejects(channel.bindings.register('duplicate',webToken,owner),/credential already/)
  const first=await channel.submit(web.bindingId,{requestId:'one',scope:'main',text:'Remember cobalt',followOwner:true})
  await control.saveNativeSession(first.execution!.sessionId,'native-owner-session')
  const second=await channel.submit(phone.bindingId,{requestId:'two',scope:'main',text:'Which word?',followOwner:true})
  assert.equal(first.execution!.sessionId,second.execution!.sessionId)
  assert.equal(first.chatId,undefined)
  assert.equal(first.ownerId,owner.id)
  assert.equal(ownsRun(owner,first),true)
  assert.equal(ownsRun({...owner,id:'someone-else'},first),false)
  const rotated=secret()
  const after=(await channel.bindings.register('web',rotated,owner,false,true))!
  assert.equal(after.bindingId,web.bindingId)
  await assert.rejects(channel.bindings.authenticate(webToken),/Unauthorized/)
  assert.equal((await channel.bindings.authenticate(rotated)).bindingId,web.bindingId)
  assert.equal((await channel.submit(web.bindingId,{requestId:'one',scope:'main',text:'Remember cobalt',followOwner:true})).id,first.id)
  await assert.rejects(control.approveOwner(42),/No active pairing/)
  await control.requestPairing(42,42)
  const linked=await control.approveOwner(42)
  assert.equal(ownerId(linked),owner.id)
  assert.equal(linked.pairedAt,owner.pairedAt)
  assert.equal(isOwner({from:{id:42,is_bot:false} as never,chat:{id:42,type:'private'} as never},linked),true)
  const telegramRun={telegramUserId:42,chatId:42,telegramEpoch:linked.telegramLinkedAt}
  assert.equal(ownsRun(linked,telegramRun),true)
  await control.unlinkTelegram()
  assert.equal(ownsRun((await control.status()).owner,telegramRun),false)
  assert.equal((await control.executionSession(first.execution!)).nativeSessionId,'native-owner-session')
  assert.equal((await channel.bindings.authenticate(phoneToken)).id,'phone')
  await control.requestPairing(42,42);await control.approveOwner(42)
  assert.equal(ownsRun((await control.status()).owner,telegramRun),false)
  const address=await channel.listen(0) as {port:number}
  const registration=await fetch(`http://127.0.0.1:${address.port}/v1/registration`,{headers:{Authorization:`Bearer ${rotated}`}})
  assert.deepEqual(await registration.json(),{ownerId:'verified-account',bindingId:web.bindingId,channel:'web'})
  await channel.bindings.register('phone',null,(await control.status()).owner!)
  await assert.rejects(channel.bindings.authenticate(phoneToken),/Unauthorized/)
  assert.equal((await channel.bindings.authenticate(rotated)).id,'web')
  await control.revokeOwner()
  await assert.rejects(channel.bindings.authenticate(rotated),/Unauthorized/)
  assert.equal((await runs.list()).length,2)
})

test('web owner uses the standard schedule CLI, executor and outbox with Telegram disabled',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ez-channel-schedule-'))
  const original=EXECUTOR_REGISTRY.grok, require=createRequire(import.meta.url)
  const fixture=join(root,'engine.mjs')
  const scheduleCli=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
  const messageCli=fileURLToPath(new URL('../bin/ezenciel-agents-message.mjs',import.meta.url))
  await writeFile(fixture,`import {spawnSync} from 'node:child_process';
    if(process.env.TELEGRAM_BOT_TOKEN)throw Error('secret leak');
    const scheduled=process.env.EZ_RUN_ID.startsWith('r_schedule_');
    if(!scheduled){const r=spawnSync(process.execPath,[${JSON.stringify(scheduleCli)},'create','followup','--now','--name','Followup','--text','Finish the requested work'],{env:process.env,encoding:'utf8'});if(r.status)throw Error(r.stderr)}
    const r=spawnSync(process.execPath,[${JSON.stringify(messageCli)},'--text',scheduled?'Scheduled reply':'Chat reply'],{env:process.env,encoding:'utf8'});if(r.status)throw Error(r.stderr);`)
  EXECUTOR_REGISTRY.grok={...original,command:process.execPath,buildArgs:()=>['--import',require.resolve('tsx'),fixture]}
  const config=loadConfig({EZ_APPLICATION_PORT:'8787',EZ_CONTROL_DIR:root,EZ_AGENT_WORKSPACE:root,EZ_EXECUTOR_CLI:'grok'})
  const relay=createRelay(config), control=new ControlStore(root,60000), runs=new RunStore(root)
  const owner=await control.registerOwner('web-owner'),token=secret()
  const binding=(await relay.applicationChannel.bindings.register('web',token,owner))!
  const address=await relay.applicationChannel.listen(0) as {port:number}
  const timer=setInterval(()=>{void relay.drainSources();void relay.drainOutbox()},25)
  t.after(async()=>{clearInterval(timer);await relay.stop();EXECUTOR_REGISTRY.grok=original;await rm(root,{recursive:true,force:true})})
  const first=await relay.applicationChannel.submit(binding.bindingId,{requestId:'chat',scope:'main',text:'Schedule a followup'})
  await waitFor(async()=> (await runs.get(first.id))?.status==='completed')
  await waitFor(async()=> (await runs.list()).some(r=>r.scheduled && r.status==='completed'))
  const scheduled=(await runs.list()).find(r=>r.scheduled)!
  assert.equal(scheduled.chatId,undefined)
  assert.equal(scheduled.ownerId,'web-owner')
  assert.equal(scheduled.delivery?.bindingId,binding.bindingId)
  await waitFor(async()=> (await relay.applicationChannel.snapshot(binding.bindingId,scheduled.id)).messages.length===1)
  assert.equal((await relay.applicationChannel.snapshot(binding.bindingId,scheduled.id)).messages[0].text,'Scheduled reply')
  const inbox=await fetch(`http://127.0.0.1:${address.port}/v1/runs`,{headers:{Authorization:`Bearer ${token}`}})
  assert.equal((await inbox.json() as {runs:unknown[]}).runs.length,2)
  const stranger=secret();await relay.applicationChannel.bindings.register('other',stranger,owner)
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/runs/${scheduled.id}`,{headers:{Authorization:`Bearer ${stranger}`}})).status,404)
  const scheduler=new Scheduler(root), saved=await scheduler.get('followup')
  await scheduler.save({...saved,id:'revoked',trigger:{at:new Date(Date.now()+1000).toISOString()}})
  await relay.applicationChannel.bindings.register('web',null,owner)
  await scheduler.tick(owner,runs,Date.now()+2000)
  assert.equal((await runs.list()).some(r=>r.scheduled?.id==='revoked'),false)
})

test('legacy web runs survive Telegram unlink, but owner revocation invalidates their binding',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ez-owner-legacy-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const control=new ControlStore(root,60000,()=>Date.parse('2026-01-01T00:00:00Z'))
  await control.requestPairing(42,42)
  const owner=await control.approveOwner(42)
  const channel=new ApplicationChannel({controlDir:root,initial:initialPreset('codex'),wake:()=>{},cancel:async()=>{}})
  const token=secret(),binding=(await channel.bindings.register('web',token,owner))!
  const runs=new RunStore(root)
  const legacy=await runs.create({id:'r_legacy',chatId:42,telegramUserId:42,texts:['legacy'],application:{bindingId:binding.bindingId,scope:'main',requestId:'legacy'}})
  await control.unlinkTelegram()
  await channel.bindings.authorize(legacy)
  assert.equal(ownsRun((await control.status()).owner,legacy),true)
  await control.revokeOwner()
  await control.requestPairing(42,42)
  const replacement=await control.approveOwner(42)
  assert.equal(owner.pairedAt,replacement.pairedAt)
  assert.equal(sameOwner(owner,replacement),false,'same timestamp must not revive old authority')
  await assert.rejects(channel.bindings.authenticate(token),/Unauthorized/)
  await assert.rejects(channel.bindings.authorize(legacy),/revoked/)
})

for (const mode of ['owner','web','telegram']) test(`${mode} revocation stops its already running worker`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'ez-owner-stop-'))
  const control=new ControlStore(root,60000),runs=new RunStore(root),scheduler=new Scheduler(root)
  await control.requestPairing(42,42)
  const owner=await control.approveOwner(42)
  const relay=createRelay(loadConfig({TELEGRAM_BOT_TOKEN:'synthetic',EZ_CONTROL_DIR:root,EZ_AGENT_WORKSPACE:root,EZ_EXECUTOR_CLI:'grok'}),async()=>({child:spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'pipe'}),stdout:'',cleanup:async()=>{}}))
  relay.bot.api.config.use(async()=>({ok:true,result:true}) as never)
  t.after(async()=>{await relay.stop();await rm(root,{recursive:true,force:true})})
  if (mode==='telegram') {
    await runs.create({id:'r_telegram',chatId:42,telegramUserId:42,ownerId:ownerId(owner),ownerEpoch:ownerEpoch(owner),texts:['Wait'],execution:await control.captureChoice(initialPreset('grok'))})
  } else {
    const binding=(await relay.applicationChannel.bindings.register('web',secret(),owner))!
    await scheduler.save({id:'wait',name:'Wait',text:'Wait',enabled:true,trigger:{at:new Date(Date.now()+1000).toISOString()},owner,delivery:{bindingId:binding.bindingId,scope:'main'},execution:await control.captureChoice(initialPreset('grok'))})
    await scheduler.tick(owner,runs,Date.now()+2000)
  }
  await relay.drainSources()
  await waitFor(async()=>(await runs.list()).some(r=>r.status==='running'))
  if(mode==='owner')await control.revokeOwner()
  else if(mode==='web')await relay.applicationChannel.bindings.register('web',null,owner)
  else await control.unlinkTelegram()
  await relay.drainSources()
  await waitFor(async()=>(await runs.list()).every(r=>r.status==='cancelled'))
})
