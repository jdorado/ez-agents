import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'

const waitFor = async (condition: () => Promise<boolean>) => {
  for (let i=0;i<300;i++) { if (await condition()) return; await new Promise(r=>setTimeout(r,10)) }
  throw new Error('Timed out')
}

test('application-only mode explicitly requires native listener and ignores bot credentials', () => {
  assert.throws(()=>loadConfig({}), /TELEGRAM_BOT_TOKEN/)
  assert.throws(()=>loadConfig({EZ_TELEGRAM_ENABLED:'false'}), /EZ_APPLICATION_PORT/)
  assert.throws(()=>loadConfig({EZ_TELEGRAM_ENABLED:'no'}), /true or false/)
  assert.throws(()=>loadConfig({EZ_TELEGRAM_ENABLED:'false',EZ_APPLICATION_PORT:'8110',EZ_CHANNEL_BACKEND_URL:'http://backend',EZ_CHANNEL_BACKEND_TOKEN:'secret'}), /native Ez executor/)
  const config=loadConfig({EZ_TELEGRAM_ENABLED:'false',EZ_APPLICATION_PORT:'8110',TELEGRAM_BOT_TOKEN:'unused-secret'})
  assert.equal(config.telegramBotToken,'')
  assert.equal(config.telegramEnabled,false)
})

test('administrator bootstrap is explicit, local-only and cannot replace identity', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-app-only-admin-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const token=join(root,'token'); await writeFile(token,'x'.repeat(48),{mode:0o600})
  const cli=fileURLToPath(new URL('../bin/ezenciel-agents-application.mjs',import.meta.url))
  const args=[cli,'--id','app','--token-file',token,'--owner','42']
  const env={...process.env,EZ_CONTROL_DIR:root,EZ_RUN_ID:'',EZ_TELEGRAM_ENABLED:'false'}
  assert.notEqual(spawnSync(process.execPath,args,{env:{...env,EZ_TELEGRAM_ENABLED:'true'}}).status,0)
  assert.notEqual(spawnSync(process.execPath,args,{env:{...env,EZ_RUN_ID:'r_agent'}}).status,0)
  assert.equal((await new ControlStore(root,1000).status()).owner,null)
  const invalidToken=join(root,'invalid-token');await writeFile(invalidToken,'short')
  for (const invalidArgs of [
    [cli,'--id','../bad','--token-file',token,'--owner','42'],
    [cli,'--id','app','--token-file',invalidToken,'--owner','42'],
    [cli,'--id','app','--token-file',join(root,'missing'),'--owner','42'],
  ]) {
    assert.notEqual(spawnSync(process.execPath,invalidArgs,{env}).status,0)
    assert.equal((await new ControlStore(root,1000).status()).owner,null)
  }
  const good=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(good.status,0,good.stderr)
  assert.equal((await new ControlStore(root,1000).status()).owner?.telegramUserId,42)
  assert.notEqual(spawnSync(process.execPath,args,{env}).status,0)
  assert.notEqual(spawnSync(process.execPath,[cli,'--id','app','--token-file',token,'--share-telegram'],{env}).status,0)
})

test('botless daemon executes application turn and rejects Telegram-origin work/outbound', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-app-only-runtime-'))
  const portServer=createServer();await new Promise<void>(r=>portServer.listen(0,'127.0.0.1',r))
  const port=(portServer.address() as {port:number}).port;await new Promise<void>(r=>portServer.close(()=>r()))
  const config=loadConfig({EZ_TELEGRAM_ENABLED:'false',EZ_APPLICATION_PORT:String(port),EZ_CONTROL_DIR:root,EZ_AGENT_WORKSPACE:root,EZ_EXECUTOR_CLI:'codex'})
  const native='11111111-1111-1111-1111-111111111111', fixture=join(root,'engine.mjs')
  await writeFile(fixture,`import {spawnSync} from 'node:child_process';if(process.env.TELEGRAM_BOT_TOKEN)throw Error('secret leak');console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(native)}}));const r=spawnSync(process.execPath,[${JSON.stringify(fileURLToPath(new URL('../bin/ezenciel-agents-message.mjs',import.meta.url)))},'--text','Application reply'],{env:process.env});process.exit(r.status);`)
  const original=EXECUTOR_REGISTRY.codex,require=createRequire(import.meta.url)
  let launches=0
  EXECUTOR_REGISTRY.codex={...original,command:process.execPath,buildArgs:()=>{launches++;return ['--import',require.resolve('tsx'),fixture]}}
  const relay=createRelay(config),control=new ControlStore(root,1000),runs=new RunStore(root)
  assert.equal(relay.bot,null)
  const owner=await control.bootstrapApplicationOwner(42)
  const token='x'.repeat(48),binding=(await relay.applicationChannel.bindings.register('app',token,owner))!
  const running=relay.start()
  t.after(async()=>{await relay.stop();await running;EXECUTOR_REGISTRY.codex=original;await rm(root,{recursive:true,force:true})})
  await waitFor(async()=>relay.isRunning())
  const unauthorized=await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'bad',scope:'main',text:'bad'})})
  assert.equal(unauthorized.status,401)
  const run=await relay.applicationChannel.submit(binding.bindingId,{requestId:'good',scope:'main',text:'Hello'})
  await waitFor(async()=> (await runs.get(run.id))?.status==='completed')
  await waitFor(async()=> (await relay.applicationChannel.snapshot(binding.bindingId,run.id)).messages.length>0)
  assert.equal((await relay.applicationChannel.snapshot(binding.bindingId,run.id)).messages[0].text,'Application reply')
  const legacy=await runs.create({chatId:42,telegramUserId:42,texts:['Old Telegram work']})
  await runs.enqueueMessage(legacy.id,'Never send')
  await relay.drainSources();await relay.drainOutbox();await relay.drainInbox(true)
  assert.equal(launches,1)
  assert.equal((await runs.get(legacy.id))?.status,'queued')
})

test('Docker health accepts application readiness only with explicit botless configuration', async t => {
  const root=await mkdtemp(join(tmpdir(),'ez-app-only-health-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'heartbeat.json'),JSON.stringify({at:Date.now(),polling:false,applicationOnly:true}))
  const command=fileURLToPath(new URL('../docker/healthcheck.mjs',import.meta.url))
  const env={...process.env,EZ_HEALTH_RELAY_CONTROL_DIR:root,EZ_EXECUTOR_TRANSPORT:'local'}
  assert.equal(spawnSync(process.execPath,[command],{env:{...env,EZ_TELEGRAM_ENABLED:'false'}}).status,0)
  assert.notEqual(spawnSync(process.execPath,[command],{env:{...env,EZ_TELEGRAM_ENABLED:'true'}}).status,0)
})
