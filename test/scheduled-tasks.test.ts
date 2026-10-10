import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler } from '../src/scheduler.js'
import { scheduledTaskDetailText, scheduledTasksText } from '../src/scheduled-tasks.js'
import { RunStore } from '../src/runs.js'
import type { Trigger } from '../src/schedule-time.js'

const owner = { telegramUserId: 101, telegramChatId: 101, pairedAt: '2026-09-11T00:00:00.000Z' }
const execution = { sessionId: randomUUID(), preset: { id: 'fixture', name: 'Fixture', cli: 'codex', model: 'fixture-model' } }

test('scheduled task view is read-only, owner-bound, and shows active task prompts and effective AI settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-scheduled-tasks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scheduler = new Scheduler(dir)

  assert.deepEqual(await scheduler.listReadOnly(), [])
  await assert.rejects(access(join(dir, 'schedules')), /ENOENT/)

  const saved = await scheduler.save({
    id: 'owner-task', name: 'Daily report', text: 'Read the ledger and send the owner a concise report.', owner, execution, enabled: true,
    trigger: { cron: '0 9 * * 1-5', timezone: 'Asia/Dubai', start: '2026-01-01T00:00:00.000Z' },
  })
  await scheduler.save({
    id: 'other-task', name: 'Other owner task', text: 'This must never be visible.',
    owner: { ...owner, telegramUserId: 202, telegramChatId: 202 }, execution, enabled: true,
    trigger: { at: '2027-01-01T00:00:00.000Z' },
  })
  const scheduleDir = join(dir, 'schedules')
  const before = await readFile(join(scheduleDir, 'owner-task.json'), 'utf8')
  const entries = await readdir(scheduleDir)
  const runs = new RunStore(dir)
  const run = await runs.create({
    id: 'owner-task-run', ownerId: 'telegram:101:101', ownerEpoch: owner.pairedAt, chatId: 101, telegramUserId: 101, texts: [],
    scheduled: { id: saved.id, revision: saved.revision, dueAt: '2026-01-01T05:00:00.000Z', pairedAt: owner.pairedAt },
  })
  await runs.patch(run.id, { status: 'completed', endedAt: '2026-01-01T05:04:00.000Z' })
  const active = await scheduler.listTasksReadOnly(await runs.list())
  const text = scheduledTasksText(active, owner)

  assert.equal(text, '📅 Scheduled tasks · 1 active · 0 paused\n\nNext/last times UTC. Use /tasks 1 for task details.\n\n1 · Daily report\n  ● Active\n  Schedule · Weekdays at 09:00 · Asia/Dubai\n  Next · Thu, Jan 1 · 05:00 UTC\n  Last · ✓ Completed · Thu, Jan 1 · 05:04 UTC\n  Execution · codex (default login) · fixture-model · default effort\n  Read the ledger and send the owner a concise report.')
  assert.match(scheduledTaskDetailText(active.find(schedule => schedule.id === saved.id)!, 1), /Last run\n✓ Completed · Thu, Jan 1 · 05:04 UTC/)
  assert.doesNotMatch(text, /Other owner task|This must never be visible/)
  assert.equal(await readFile(join(scheduleDir, 'owner-task.json'), 'utf8'), before)
  assert.deepEqual(await readdir(scheduleDir), entries)
})

test('active view follows existing cursor and run state without changing schedules', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-active-schedules-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const runs = new RunStore(dir)
  const due = Date.now()+60_000
  const common = {text:'/goal List files.',owner,execution,enabled:true}
  for (const id of ['once','paused','interrupted','review','expired']) {
    await scheduler.save({...common,id,name:id,enabled:id!=='paused',
      ...(id==='review'?{when:'unreviewed-failures' as const}:{}),
      trigger:id==='expired'?{everySeconds:60,start:new Date(due).toISOString(),until:new Date(due).toISOString()}:
        id==='interrupted'?{everySeconds:60,start:new Date(due).toISOString()}:{at:new Date(due).toISOString()}})
  }
  await scheduler.save({...common,id:'recurring',name:'recurring',trigger:{everySeconds:60,start:new Date(due).toISOString()}})
  const names = async () => (await scheduler.listTasksReadOnly(await runs.list())).map(s=>s.id).sort()
  assert.deepEqual(await names(),['expired','interrupted','once','paused','recurring','review'])
  const paused = (await scheduler.listTasksReadOnly(await runs.list())).find(s=>s.id==='paused')!
  assert.equal(paused.enabled,false)
  assert.equal(paused.nextAt,null)
  assert.match(scheduledTasksText([paused],owner),/0 active · 1 paused[\s\S]*⏸ Paused/)
  assert.doesNotMatch(scheduledTasksText([paused],{...owner,pairedAt:'different'}),/⏸ Paused/)
  assert.match(scheduledTaskDetailText({...paused,runState:'running'},1),/▶ Running · ⏸ Paused/)
  assert.match(scheduledTaskDetailText({...paused,runState:'queued'},1),/◌ Queued · ⏸ Paused/)
  await scheduler.tick(owner,runs,due)
  assert.ok(!(await runs.list()).some(r=>r.scheduled?.id==='paused'))
  // The empty conditional review consumes its occurrence without creating work.
  assert.deepEqual(await names(),['expired','interrupted','once','paused','recurring'])
  const queued = (await runs.list()).find(r=>r.scheduled?.id==='once')!
  const view = (await scheduler.listTasksReadOnly(await runs.list())).find(s=>s.id==='once')!
  assert.equal(view.nextAt,null)
  assert.equal(view.runState,'queued')
  assert.match(scheduledTasksText([view],owner),/Queued/)
  await runs.patch(queued.id,{status:'running'})
  assert.equal((await scheduler.listTasksReadOnly(await runs.list())).find(s=>s.id==='once')!.runState,'running')
  for (const run of await runs.list()) await runs.patch(run.id,run.scheduled?.id==='interrupted'
    ? {status:'failed',interrupted:true} : {status:'completed'})
  const before = await readdir(join(dir,'schedules'))
  assert.deepEqual(await names(),['paused','recurring'])
  assert.deepEqual(await readdir(join(dir,'schedules')),before)
  // A held recurring revision remains hidden even when its cursor has a later occurrence.
  const interrupted = await scheduler.get('interrupted')
  assert.equal('everySeconds' in interrupted.trigger && interrupted.trigger.everySeconds,60)
  // A new schedule revision has its own occurrence; old terminal runs cannot hide it.
  await scheduler.save({...common,id:'once',name:'once',trigger:{at:new Date(due+60_000).toISOString()}})
  assert.deepEqual(await names(),['once','paused','recurring'])
})

test('prompt preview is one bounded Unicode sentence and preserves stored input', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-preview-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const text='/goal '+ '🧪'.repeat(150)+'.\nDo not display this second sentence.'
  const saved=await scheduler.save({id:'preview',name:'Preview',text,owner,
    execution:{...execution,preset:{...execution.preset,model:'gpt-5.6-terra',effort:'high'}},
    enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const output=scheduledTasksText(await scheduler.listTasksReadOnly([]),owner)
  assert.match(output,/gpt-5.6-terra · high/)
  assert.match(output,/Next · Fri, Jan 1 · 00:00 UTC/)
  assert.equal(Array.from(output.split('\n').at(-1)!.trim()).length,140)
  assert.ok(output.endsWith('…'))
  assert.doesNotMatch(output,/Do not display/)
  assert.equal((await scheduler.get(saved.id)).text,text)
  const other=scheduledTasksText(await scheduler.listTasksReadOnly([]),{...owner,pairedAt:'other-pairing'})
  assert.match(other,/No scheduled tasks/)
  assert.doesNotMatch(other,/Preview|🧪/)
})

test('a legacy invalid selection does not prevent the active menu from rendering', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-legacy-selection-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  await scheduler.save({id:'legacy',name:'Legacy task',text:'/goal Check files.',owner,
    execution,enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const file = join(dir,'schedules','legacy.json')
  const saved = JSON.parse(await readFile(file,'utf8'))
  saved.execution.preset = {...saved.execution.preset,model:'gpt-5.6-terra',effort:'max'}
  await writeFile(file,JSON.stringify(saved))

  const active = await scheduler.listTasksReadOnly([])
  assert.match(scheduledTasksText(active,owner),/codex \(default login\) · gpt-5.6-terra · max/)
})

test('detail view truncates long instructions and tolerates invalid timestamps', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-detail-bounds-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const saved = await scheduler.save({id:'long',name:'Long task',text:'/goal '+'x'.repeat(5000),owner,
    execution,enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const active = await scheduler.listTasksReadOnly([])
  const detail = scheduledTaskDetailText(active.find(schedule => schedule.id === saved.id)!,1,1)
  assert.match(detail,/📅 1 of 1 · Long task/)
  assert.match(detail,/truncated; full text lives in the workspace/)
  assert.ok(detail.length < 3000)
  const broken = {...active.find(schedule => schedule.id === saved.id)!,nextAt:'not-a-date',lastRun:{status:'completed',at:'also-bad',currentRevision:true}} as never
  assert.doesNotMatch(scheduledTaskDetailText(broken,1,1),/NaN/)
})

test('frequency describes saved rules without inventing a uniform interval for arbitrary cron', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ez-schedule-frequency-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler=new Scheduler(dir),start='2027-01-01T00:00:00Z',timezone='America/New_York'
  const cases:[Trigger,string][]=[
    [{at:start},'Once'],[{everySeconds:60,start},'Every minute'],[{everySeconds:90,start},'Every 90 seconds'],
    [{everySeconds:3600,start},'Every hour'],[{everySeconds:172800,start},'Every 2 days'],
    [{cron:'*/15 * * * *',timezone,start},'Every 15 minutes · America/New_York'],
    [{cron:'*/30 * * * *',timezone,start},'Every 30 minutes · America/New_York'],
    [{cron:'15 * * * *',timezone,start},'Hourly at :15 · America/New_York'],
    [{cron:'30 9 * * *',timezone,start},'Daily at 09:30 · America/New_York'],
    [{cron:'*/7 * * * *',timezone,start},'Cron */7 * * * * · America/New_York'],
    [{cron:'0 9 1 * 1',timezone,start},'Cron 0 9 1 * 1 · America/New_York'],
  ]
  for(const [i,[trigger,label]] of cases.entries()){
    const saved=await scheduler.save({id:`t-${i}`,name:`Task ${i}`,text:'Inspect saved work.',owner,execution,enabled:true,trigger})
    const active=(await scheduler.listTasksReadOnly([])).find(s=>s.id===saved.id)!
    assert.ok(scheduledTasksText([active],owner).includes(`Schedule · ${label}\n`))
    assert.ok(scheduledTaskDetailText(active,1).includes(`Schedule\n${label}\n`))
  }
})
