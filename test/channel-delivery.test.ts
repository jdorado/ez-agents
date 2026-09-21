import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createRelay} from '../src/index.js'
import {ControlStore} from '../src/control-state.js'
import {RunStore} from '../src/runs.js'
import {authorizeDeliveryContext,captureDeliveryContext} from '../src/delivery-context.mjs'
import {nativeTasks,nativeTaskBinding} from '../src/plugins/native-tasks.mjs'
import {serveTestLedger} from './helpers/ledger.js'

test('authenticated connection sends text and files through ordinary outbox receipts without a native run',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ez-channel-delivery-'))),workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),home=path.join(root,'tools'),hostConfig=path.join(root,'host-executor.json')
  for(const dir of [workspace,controlDir,home])await fs.mkdir(dir)
  const relay=createRelay({controlDir,workspace,pairingTtlMs:1000,executorTimeoutMs:1000,executorCli:'grok',telegramBotToken:'fixture'},async()=>{throw Error('Must not launch native execution')})
  // The message CLI child reaches the relay memory ledger through the delivery socket.
  const ledger=await serveTestLedger(controlDir)
  const calls:string[]=[];relay.bot.api.config.use(async(_prev,method)=>{calls.push(method);return {ok:true,result:{message_id:42}} as never})
  try {
    await fs.writeFile(path.join(home,'config.json'),JSON.stringify({schemaVersion:1,workspace,hostConfig}))
    await fs.writeFile(hostConfig,JSON.stringify({cli:'grok',agents:[{toolsHome:home,workspace,controlDir}]}))
    const control=new ControlStore(controlDir,1000);await control.requestPairing(101,101);await control.approveOwner(101)
    const context=(await captureDeliveryContext(controlDir,'voice','revision'))!,store=new RunStore(controlDir)
    const env=await nativeTaskBinding(home,{EZ_DELIVERY_CONTEXT:'forged',EZ_RUN_ID:'forged'});assert.equal(env.env.EZ_DELIVERY_CONTEXT,undefined);assert.equal(env.env.EZ_RUN_ID,undefined)
    const file=path.join(workspace,'scan.pdf');await fs.writeFile(file,'%PDF-fixture')
    for(const args of [['--text','literal $(not-a-shell)'],['--document',file]]) {
      const pending=nativeTasks(home,args,{command:'message',deliveryContext:context})
      const deadline=Date.now()+5000;while(!(await store.pendingOutbox()).length){if(Date.now()>deadline)throw Error('Message was not queued');await new Promise(r=>setTimeout(r,10))}
      const item=(await store.pendingOutbox())[0]!;assert.equal(item.runId,undefined);if(item.documentPath)assert.equal(item.documentPath,'scan.pdf')
      await relay.drainOutbox();const result=await pending;assert.equal(result.code,0,result.stderr)
      const frames=result.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(frames[0].status,'queued');assert.equal(frames.at(-1).status,'delivered');assert.deepEqual(frames.at(-1).receipt.messageIds,[42])
      const receipt=await nativeTasks(home,['receipt',item.id],{command:'message',deliveryContext:context});assert.equal(JSON.parse(receipt.stdout).status,'delivered')
    }
    assert.deepEqual(calls,['sendMessage','sendDocument']);assert.deepEqual(await store.list(),[])
    await assert.rejects(nativeTasks(home,['--document',hostConfig],{command:'message',deliveryContext:context}),/outside/)
    await fs.symlink(hostConfig,path.join(workspace,'escape'));await assert.rejects(nativeTasks(home,['--document','escape'],{command:'message',deliveryContext:context}),/outside/)
    await assert.rejects(nativeTasks(home,['--text-file',hostConfig],{command:'message',deliveryContext:context}),/inline/)
    const queued=await store.enqueueOwnerDelivery(context,{type:'message',text:'revoked'})
    await control.revokeOwner();await control.requestPairing(101,101);await control.approveOwner(101)
    await relay.drainOutbox();assert.equal(calls.length,2);await assert.rejects(store.waitForDelivery(queued.id),/revoked/)
    await assert.rejects(nativeTasks(home,['--text','denied'],{command:'message',deliveryContext:context}),/revoked/)
    await assert.rejects(store.ownerDeliveryReceipt(context,queued.id),/revoked/)
  } finally {await relay.stop();await ledger.stop();await fs.rm(root,{recursive:true,force:true})}
})
test('delivery authority cannot revive after Telegram relink or same-time owner replacement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ez-channel-delivery-epoch-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const control=new ControlStore(root,60000,()=>Date.parse('2026-09-14T00:00:00Z'))
  await control.requestPairing(101,101)
  await control.approveOwner(101)
  const original=(await captureDeliveryContext(root,'voice','revision'))!

  await control.unlinkTelegram()
  await control.requestPairing(101,101)
  await control.approveOwner(101)
  const relinked=(await control.status()).owner!
  assert.throws(()=>authorizeDeliveryContext(original,relinked),/revoked/)

  const relinkedContext=(await captureDeliveryContext(root,'voice','revision'))!
  await control.revokeOwner()
  await control.requestPairing(101,101)
  await control.approveOwner(101)
  const replacement=(await control.status()).owner
  assert.throws(()=>authorizeDeliveryContext(relinkedContext,replacement),/revoked/)
})
