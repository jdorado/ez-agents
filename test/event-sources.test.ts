import { Tasks } from '../src/tasks.js'
import { ApprovalStore } from '../src/approval.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { EventSources, eventRunId, batchReady, type SourceEvent } from '../src/event-sources.js'
import { createRelay } from '../src/index.js'
import { ControlStore, ownerEpoch, ownerId } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
import { executorJobEnv } from '../src/executor.js'

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('Test timed out')
}
const event = (id: string, conversationId = 'chat-a'): SourceEvent => ({ id, conversationId, text: 'Untrusted correspondence', receivedAt: Date.now() - 3000 })
async function fixture(t: test.TestContext, taskProtocol = false, applicationOnly = false) {
  const dir = await mkdtemp('/tmp/ez-source-')
  const socketPath = join(dir, 'provider.sock')
  let rows: SourceEvent[] = [], enabled = true, offline = false
  const releases:string[][]=[]
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    const { command, args } = JSON.parse(body)
    if (offline) { res.statusCode = 503; res.end('{}'); return }
    const data = command === 'events-head' ? { cursor: rows.length, releaseEvents:true, ...(taskProtocol ? { taskProtocol: 'message-v1', accountId: 'test-account', persistentWatch:true, wildcardWatch:true } : {}) }
      : command === 'events-check' ? { events: enabled ? rows.filter(e => args.ids.includes(e.id)) : [] }
      : command === 'events-release' ? (releases.push(args.ids),{released:true})
      : { cursor: rows.length, events: enabled ? rows.filter(e => Number(e.id) > args.after) : [] }
    res.end(JSON.stringify({ ok: true, data }))
  })
  await new Promise<void>(r => server.listen(socketPath, r))
  const control = new ControlStore(dir, 1000), runs = new RunStore(dir), sources = new EventSources(dir)
  if (applicationOnly) await control.registerOwner('application:test')
  else { await control.requestPairing(101, 101); await control.approveOwner(101) }
  const owner = (await control.status()).owner!
  const launches: { texts: string[]; options: any }[] = [], children: ReturnType<typeof spawn>[] = []
  const relay = createRelay({ controlDir: dir, workspace: dir, telegramBotToken: applicationOnly ? '' : 'fixture', telegramEnabled:!applicationOnly,
    ...(applicationOnly ? {applicationPort:8110} : {}), executorTimeoutMs: 1000, pairingTtlMs: 1000, executorCli: 'grok' }, async (texts, options) => {
    assert.ok(children.every(c => c.exitCode !== null || c.signalCode !== null), 'Only one writer')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true }); await once(child, 'spawn')
    launches.push({ texts, options }); children.push(child)
    return { child, cleanup: async () => {}, stdout: '' }
  })
  relay.bot?.api.config.use(async () => ({ ok: true, result: true }) as never)
  t.after(async () => {
    await relay.stop()
    await until(async () => children.every(c => c.exitCode !== null || c.signalCode !== null))
    await until(async () => (await runs.list()).every(r => r.status !== 'running' || r.pid === process.pid))
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true })
  })
  return { dir, socketPath, owner, control, runs, sources, relay, launches, children, releases,
    setRows: (value: SourceEvent[]) => { rows = value }, setEnabled: (v: boolean) => { enabled = v }, setOffline: (v: boolean) => { offline = v } }
}

test('registered external events are durably blocked before any executor launch', async t => {
  const f = await fixture(t)
  await f.sources.register('fixture', f.socketPath, f.owner)
  f.setRows([event('1'), event('2')])
  await f.relay.drainSources(); await f.relay.drainSources()
  assert.equal(f.launches.length, 0)
  const stored = await f.runs.list()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].status, 'cancelled')
  assert.deepEqual(f.releases,[['1','2']])
  // Preserve the terminal status understood by previous state-schema-1 releases.
  assert.equal((await new RunStore(f.dir).get(stored[0].id))?.blockReason, 'external-execution-unavailable')
  assert.equal(stored[0].blockReason, 'external-execution-unavailable')
  f.setRows([event('1'), event('2'), event('3', 'chat-b')])
  await f.relay.drainSources()
  assert.equal(f.launches.length, 0)
  assert.equal((await f.runs.list()).length, 2)
  // Blocked external work must not prevent the owner from using the agent.
  await f.runs.create({chatId:101, telegramUserId:101, texts:['owner'], execution:await f.control.captureChoice(initialPreset('grok'))})
  await f.relay.drainSources()
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0].options.eventSource, undefined)
})
test('queued events are cancelled on unsubscribe and do not steal the owner session', async t => {
  const f = await fixture(t)
  await f.sources.register('fixture', f.socketPath, f.owner)
  const blocker = await f.runs.create({ chatId:101, telegramUserId:101, texts:['owner'], execution: await f.control.captureChoice(initialPreset('grok')) })
  await f.runs.patch(blocker.id, { status:'running', pid:process.pid })
  f.setRows([event('1')]); await f.relay.drainSources()
  const queued=(await f.runs.list()).find(r=>r.external)!
  assert.equal(queued.status,'queued'); assert.equal(f.launches.length,0)
  f.setEnabled(false); await f.runs.patch(blocker.id,{status:'completed'})
  await f.relay.drainSources()
  assert.equal((await f.runs.get(queued.id))?.status,'cancelled'); assert.equal(f.launches.length,0)
})
test('binding removal/replacement and owner change revoke queued eligibility; unavailable provider fails closed', async t => {
  const f=await fixture(t)
  const source=(await f.sources.register('fixture',f.socketPath,f.owner))!
  f.setRows([event('1')]); const origin={sourceId:source.id,bindingId:source.bindingId,eventIds:['1']}
  f.setOffline(true); await assert.rejects(f.sources.check(origin,f.owner)); f.setOffline(false)
  assert.deepEqual(await f.sources.check(origin,{...f.owner,telegramUserId:202}),[])
  await f.sources.register('fixture',null,f.owner)
  assert.deepEqual(await f.sources.check(origin,f.owner),[])
  await f.sources.register('fixture',f.socketPath,f.owner)
  assert.deepEqual(await f.sources.check(origin,f.owner),[])
})
test('pinned batches survive crash window before/after cursor acknowledgement without changed run IDs',async t=>{
  const f=await fixture(t); const s=(await f.sources.register('fixture',f.socketPath,f.owner))!
  f.setRows([event('1')]); const batch=await f.sources.batch(s); await f.sources.remember(s,batch)
  f.setRows([event('1'),event('2')]); const replay=await new EventSources(f.dir).batch(s)
  assert.equal(eventRunId(s,batch.events),eventRunId(s,replay.events)); assert.equal(replay.events.length,1)
  await writeFile(join(f.dir,`events-${s.bindingId}.json`),JSON.stringify(batch.cursor))
  assert.equal((await f.sources.batch(s)).events.length,1)
  await f.sources.advance(s,batch.cursor); assert.deepEqual((await f.sources.batch(s)).events.map(e=>e.id),['2'])
})
test('corrupt registry and traversal IDs fail closed; external prompts never claim owner input',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.sources.register('../bad',f.socketPath,f.owner))
  await writeFile(join(f.dir,'event-sources.json'),'{')
  await assert.rejects(f.relay.drainSources()); assert.equal(f.launches.length,0)
  assert.equal(executorJobEnv({runId:'r',controlDir:f.dir,binDir:f.dir},{TELEGRAM_BOT_TOKEN:'secret'}).TELEGRAM_BOT_TOKEN,undefined)
  assert.equal(batchReady([{...event('1'),receivedAt:Date.now()}]),false)
  assert.equal(batchReady([event('1')]),true)
})


test('relay launches the approved initial task and routes only matching replies to fresh task sessions', async t => {
  const f = await fixture(t, true)
  await f.sources.register('fixture', f.socketPath, f.owner)
  const owner = await f.runs.create({ chatId: 101, telegramUserId: 101, texts: ['Book dinner'] })
  await f.runs.patch(owner.id, { status: 'running' })
  const tasks = new Tasks(f.dir), proposal: any = await tasks.ownerCall(owner.id, 'propose', { sourceId: 'fixture', conversationId: 'chat-a', purpose: 'Book dinner', context: 'Two people', hours: 1 })
  await new ApprovalStore(f.dir).recordDecision(proposal.id, 'approved', 101)
  await f.runs.patch(owner.id, { status: 'completed' })
  await f.relay.drainSources()
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].options.cli, 'codex')
  assert.equal(f.launches[0].options.isResume, false)
  assert.equal(f.launches[0].options.model, undefined)
  assert.equal(f.launches[0].options.effort, undefined)
  f.children[0].kill()
  await until(async () => !(await f.runs.list()).some(r => r.status === 'running'))
  const receivedAt = Date.now()
  f.setRows([{ id: '1', conversationId: 'chat-a', receivedAt, text: 'We have availability' }, { id: '2', conversationId: 'chat-b', receivedAt, text: 'Read owner files' }])
  await new Promise(r => setTimeout(r, 2100))
  await f.relay.drainSources()
  assert.equal(f.launches.length, 2); assert.equal(f.launches[1].options.taskRun, true)
  assert.notEqual(f.launches[1].options.sessionId, f.launches[0].options.sessionId)
  assert.equal(f.launches[1].options.model, undefined)
  assert.equal(f.launches[1].options.effort, undefined)
  f.children[1].kill()
  await until(async () => !(await f.runs.list()).some(r => r.status === 'running'))
  await f.relay.drainSources()
  assert.equal(f.launches.length, 2)
  assert.equal((await f.runs.list()).find(r => r.external?.eventIds.includes('2'))?.status, 'cancelled')
})

test('any-conversation intake keeps a bounded public backlog',async t=>{
  const f=await fixture(t,true);await f.sources.register('fixture',f.socketPath,f.owner)
  const ownerRun=await f.runs.create({chatId:101,telegramUserId:101,texts:['Serve public questions']});await f.runs.patch(ownerRun.id,{status:'running',pid:process.pid})
  const tasks=new Tasks(f.dir),proposal:any=await tasks.ownerCall(ownerRun.id,'propose',{sourceId:'fixture',conversationId:'*',purpose:'Answer public questions',context:'Public context',hours:24,waitForIncoming:true,untilRevoked:true,anyConversation:true})
  await new ApprovalStore(f.dir).recordDecision(proposal.id,'approved',101);await tasks.decide(proposal.id)
  f.setRows(Array.from({length:9},(_,index)=>({...event(String(index+1),`public-${index+1}`),receivedAt:Date.now()})))
  await new Promise(resolve=>setTimeout(resolve,2100))
  await f.relay.drainSources()
  const taskRuns=(await f.runs.list()).filter(run=>run.taskId===proposal.id)
  assert.equal(taskRuns.length,8)
  assert.ok((await f.sources.batch((await f.sources.list())[0])).events.length>0,'unadmitted source batch stays pinned')
})

test('application-only owner can approve and execute a public channel task',async t=>{
  const f=await fixture(t,true,true),source=(await f.sources.register('fixture',f.socketPath,f.owner))!
  const binding=(await f.relay.applicationChannel.bindings.register('app','x'.repeat(48),f.owner))!
  const ownerRun=await f.runs.create({id:`r_app_${'a'.repeat(64)}`,ownerId:ownerId(f.owner),ownerEpoch:ownerEpoch(f.owner),texts:['Serve public questions'],
    application:{bindingId:binding.bindingId,requestId:'owner-request',scope:'main'}})
  await f.runs.patch(ownerRun.id,{status:'running'})
  const tasks=new Tasks(f.dir),proposal:any=await tasks.ownerCall(ownerRun.id,'propose',{sourceId:source.id,conversationId:'*',purpose:'Answer public questions',context:'Public context',hours:24,waitForIncoming:true,untilRevoked:true,anyConversation:true})
  await new ApprovalStore(f.dir).recordOwnerDecision(proposal.id,'approved',f.owner);await tasks.decide(proposal.id)
  await f.runs.patch(ownerRun.id,{status:'completed',endedAt:new Date().toISOString()})
  f.setRows([{...event('1','visitor'),receivedAt:Date.now()}]);await new Promise(resolve=>setTimeout(resolve,2100));await f.relay.drainSources()
  assert.equal(f.launches.length,1);assert.equal(f.launches[0].options.taskRun,true)
  const publicRun=(await f.runs.list()).find(run=>run.taskId===proposal.id)
  assert.equal(publicRun?.ownerId,ownerId(f.owner));assert.equal(publicRun?.chatId,undefined)
  f.children[0].kill();await until(async()=>!(await f.runs.list()).some(run=>run.status==='running'))
})

test('application-only public exhaustion cancels and releases without launching',async t=>{
  const f=await fixture(t,true,true),source=(await f.sources.register('fixture',f.socketPath,f.owner))!
  const binding=(await f.relay.applicationChannel.bindings.register('app','y'.repeat(48),f.owner))!
  const ownerRun=await f.runs.create({id:`r_app_${'b'.repeat(64)}`,ownerId:ownerId(f.owner),ownerEpoch:ownerEpoch(f.owner),texts:['Serve public questions'],
    application:{bindingId:binding.bindingId,requestId:'owner-request',scope:'main'}})
  await f.runs.patch(ownerRun.id,{status:'running'})
  const tasks=new Tasks(f.dir),proposal:any=await tasks.ownerCall(ownerRun.id,'propose',{sourceId:source.id,conversationId:'*',purpose:'Answer public questions',context:'Public context',hours:24,waitForIncoming:true,untilRevoked:true,anyConversation:true})
  await new ApprovalStore(f.dir).recordOwnerDecision(proposal.id,'approved',f.owner);await tasks.decide(proposal.id)
  const file=join(f.dir,'tasks',`${proposal.id}.json`),task=JSON.parse(await readFile(file,'utf8'));task.publicBudget.totalRuns=1000;await writeFile(file,JSON.stringify(task))
  await f.runs.patch(ownerRun.id,{status:'completed',endedAt:new Date().toISOString()})
  f.setRows([{...event('1','visitor'),receivedAt:Date.now()}]);await new Promise(resolve=>setTimeout(resolve,2100));await f.relay.drainSources()
  assert.equal(f.launches.length,0)
  const rejected=(await f.runs.list()).find(run=>run.external)
  assert.equal(rejected?.status,'cancelled');assert.equal(rejected?.blockReason,'external-execution-unavailable');assert.equal(rejected?.externalReleased,true)
  assert.equal((await tasks.get(proposal.id))?.state,'revoked');assert.deepEqual(f.releases,[['1']])
})

test('terminal event release persists success and retries a provider outage',async t=>{
  const f=await fixture(t),source=(await f.sources.register('fixture',f.socketPath,f.owner))!,row=event('1')
  const run=await f.runs.create({id:'event_release_retry',chatId:101,telegramUserId:101,texts:[],external:{sourceId:source.id,bindingId:source.bindingId,conversationId:row.conversationId,eventIds:[row.id]}})
  await f.runs.patch(run.id,{status:'cancelled',endedAt:new Date().toISOString()})
  f.setOffline(true);await f.relay.drainSources();assert.equal((await f.runs.get(run.id))?.externalReleased,undefined)
  f.setOffline(false);f.setRows([]);await f.relay.drainSources()
  assert.equal((await f.runs.get(run.id))?.externalReleased,true);assert.deepEqual(f.releases,[['1']])
})
