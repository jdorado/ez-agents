import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ApplicationChannel, applicationScope } from '../src/application-channel.js'
import { ControlStore } from '../src/control-state.js'
import { createAiMenu } from '../src/menu.js'
import { RunStore } from '../src/runs.js'

test('application controls share native choices, protect hidden scopes and preserve admitted runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-app-controls-'))
  const control = new ControlStore(root, 1000)
  await control.requestPairing(42, 42); const owner = await control.approveOwner(42)
  const menu = createAiMenu(control, 'codex', async () => [
    {cli:'codex', model:'gpt-6-astra', name:'Fixture model', efforts:['low','high']},
  ], root, join(root, 'native-home'), async () => true)
  const channel = new ApplicationChannel({controlDir:root, initial:menu.initial, aiControls:menu, wake:()=>{}, cancel:async()=>{}})
  t.after(async()=>{await channel.stop(); await rm(root,{recursive:true,force:true})})
  const token = randomBytes(32).toString('base64url'), privateToken = randomBytes(32).toString('base64url')
  const shared = (await channel.bindings.register('shared', token, owner, true))!
  const isolated = (await channel.bindings.register('isolated', privateToken, owner))!
  const address = await channel.listen(0) as {port:number}
  const request = (body?:unknown, bearer=token) => fetch(`http://127.0.0.1:${address.port}/v1/control`, {
    method:body===undefined?'GET':'POST', headers:{authorization:`Bearer ${bearer}`},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  })
  assert.equal((await request(undefined, 'invalid')).status,401)
  assert.equal((await request(undefined, privateToken)).status,403)
  assert.equal((await request({action:'new',expectedSession:null}, privateToken)).status,403)
  const initial = await (await request()).json() as any
  assert.equal(initial.ai.selectedId,menu.initial.id)
  assert.equal(initial.ai.presets.find((p:any)=>p.id===menu.initial.id).model,undefined)
  assert.equal((await control.status()).ai,undefined,'reading controls does not initialize or rewrite saved state')
  const run = await channel.submit(shared.bindingId,{requestId:'queued',scope:'main',followTelegram:true,text:'Keep the admitted native choice'})
  const old = run.execution!
  await control.saveNativeSession(old.sessionId,'native-private-id')
  const hidden = await control.captureApplicationChoice(menu.initial,applicationScope(isolated.bindingId,'private'))
  const visible = await (await request()).json() as any
  assert.equal(JSON.stringify(visible).includes('native-private-id'),false)
  assert.equal(JSON.stringify(visible).includes(hidden.sessionId),false)
  assert.equal((await request({action:'switch',sessionId:hidden.sessionId,expectedSession:old.sessionId})).status,400)
  assert.equal((await request({action:'model',cli:'codex',model:'invented',expectedSession:old.sessionId})).status,400)
  const presetsBefore = (await control.aiState(menu.initial)).presets
  assert.equal((await request({action:'model',cli:'codex',model:'gpt-6-astra',effort:'high',expectedSession:null})).status,400)
  assert.deepEqual((await control.aiState(menu.initial)).presets,presetsBefore)
  const selected = await request({action:'model',cli:'codex',model:'gpt-6-astra',effort:'high',expectedSession:old.sessionId})
  assert.equal(selected.status,200)
  assert.equal((await control.captureChoice(menu.initial)).preset.effort,'high')
  assert.deepEqual((await new RunStore(root).get(run.id))!.execution,old)
  const reset = await request({action:'new',expectedSession:old.sessionId})
  assert.equal(reset.status,200)
  const next = (await control.getActiveSession())!
  assert.notEqual(next.sessionId,old.sessionId)
  assert.equal((await request({action:'new',expectedSession:old.sessionId})).status,400)
  assert.equal((await control.getActiveSession())!.sessionId,next.sessionId)
  await channel.bindings.register('shared',null,owner)
  assert.equal((await request()).status,401)
})

test('atomic control mutations reject a replaced owner even when both active sessions are empty', async t => {
  const root = await mkdtemp(join(tmpdir(),'ez-control-owner-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const control = new ControlStore(root,1000)
  await control.requestPairing(42,42); const previous = await control.approveOwner(42)
  await control.revokeOwner()
  await control.requestPairing(43,43); await control.approveOwner(43)
  await assert.rejects(control.resetSession(null,{owner:previous,authorize:async()=>{}}),/owner changed/)
  assert.equal(await control.getActiveSession(),null)
})

test('revocation while native model validation is pending prevents selection', async t => {
  const root = await mkdtemp(join(tmpdir(),'ez-control-revoke-'))
  const control = new ControlStore(root,1000)
  await control.requestPairing(42,42); const owner = await control.approveOwner(42)
  let catalogCalls = 0
  const menu = createAiMenu(control,'codex',async()=>{
    if (++catalogCalls === 2) await channel.bindings.register('shared',null,owner)
    return [{cli:'codex',model:'gpt-6-astra',name:'Fixture',efforts:['low']}]
  },root,join(root,'native-home'),async()=>true)
  const channel = new ApplicationChannel({controlDir:root,initial:menu.initial,aiControls:menu,wake:()=>{},cancel:async()=>{}})
  t.after(()=>rm(root,{recursive:true,force:true}))
  const binding = (await channel.bindings.register('shared',randomBytes(32).toString('base64url'),owner,true))!
  const original = await control.captureChoice(menu.initial)
  await assert.rejects(channel.changeControls(binding.bindingId,{
    action:'model',cli:'codex',model:'gpt-6-astra',effort:'low',expectedSession:original.sessionId,
  }),/authority/)
  assert.deepEqual(await control.captureChoice(menu.initial),original)
  assert.equal((await control.aiState(menu.initial)).presets.length,1)
})

test('revocation during a control-lock wait prevents every guarded mutation', async t => {
  const root = await mkdtemp(join(tmpdir(),'ez-controls-lock-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const control = new ControlStore(root,1000)
  await control.requestPairing(42,42); const owner = await control.approveOwner(42)
  const preset = {id:'fixture',name:'Fixture',cli:'codex'}
  await control.aiState(preset)
  const old = await control.captureChoice(preset)
  const current = await control.resetSession()
  const before = await control.status()
  for (const operation of [
    (guard:any)=>control.resetSession(current.sessionId,guard),
    (guard:any)=>control.switchSession(old.sessionId,current.sessionId,guard),
    (guard:any)=>control.savePreset({...preset,id:'new-preset'},guard),
    (guard:any)=>control.selectPreset(preset.id,current.sessionId,false,guard),
  ]) {
    let authorized = true, checks = 0
    const lockPath = join(root,'control-state.lock'), lock = await open(lockPath,'wx',0o600)
    const pending = operation({owner,expectedSession:current.sessionId,authorize:async()=>{
      checks++; if (!authorized) throw new Error('Application authority revoked')
    }})
    const rejection = assert.rejects(pending,/revoked/)
    await new Promise(resolve=>setTimeout(resolve,50))
    assert.equal(checks,0,'authority is checked inside the acquired lock')
    authorized = false
    await lock.close(); await rm(lockPath)
    await rejection
    assert.equal(checks,1)
    assert.deepEqual(await control.status(),before)
  }
})
