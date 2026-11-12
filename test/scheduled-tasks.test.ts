import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler, type ScheduledTaskView } from '../src/scheduler.js'
import { ownedScheduledTasks, scheduledTaskDetailText, scheduledTasksText } from '../src/scheduled-tasks.js'
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
  const now = Date.UTC(2026, 0, 1, 12, 0)
  const text = scheduledTasksText(active, owner).join('\n\n')

  assert.equal(text, '📅 Scheduled tasks · 1 active · 0 paused\n\nNext/last times UTC. Use /tasks 1 for task details.\n\n1 · Daily report\n  ● Active\n  Schedule · Weekdays at 09:00 · Asia/Dubai\n  Next · Thu, Jan 1 · 05:00 UTC\n  Last · ✓ Completed · Thu, Jan 1 · 05:04 UTC\n  Execution · codex · fixture-model · default effort\n  Read the ledger and send the owner a concise report.')
  assert.match(scheduledTaskDetailText(active.find(schedule => schedule.id === saved.id)!, 1, undefined, now), /Last +✓ Completed · Thu, Jan 1 · 05:04 UTC \(6h 56m ago\)/)
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
  assert.match(scheduledTasksText([paused],owner).join('\n\n'),/0 active · 1 paused[\s\S]*⏸ Paused[\s\S]*Next · —/)
  assert.match(scheduledTasksText([paused],{...owner,pairedAt:'different'}).join('\n\n'),/No scheduled tasks/)
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
  assert.match(scheduledTasksText([view],owner).join('\n\n'),/◌ Queued/)
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

test('the list shows a bounded one-sentence preview and the engine path; the detail shows full instructions and preserves stored input', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-preview-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const text='/goal '+ '🧪'.repeat(150)+'.\nSecond line <b>stays</b> & escaped.'
  const saved=await scheduler.save({id:'preview',name:'Preview',text,owner,
    execution:{...execution,preset:{...execution.preset,model:'gpt-5.6-terra',effort:'high'},fallbacks:[{id:'fb',name:'Fallback',cli:'claude',model:'sonnet'}]},
    enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const active=await scheduler.listTasksReadOnly([])
  const now = Date.UTC(2026,11,31,12,0)
  const list=scheduledTasksText(active,owner).join('\n\n')
  assert.match(list,/Execution · codex · gpt-5.6-terra · high → claude · sonnet/)
  assert.equal(Array.from(list.split('\n').at(-1)!.trim()).length,140)
  assert.ok(list.endsWith('…'))
  assert.doesNotMatch(list,/Second line/)
  const detail=scheduledTaskDetailText(active[0],1,1,now)
  assert.match(detail,/Engine +codex · gpt-5.6-terra · high\n +→ claude · sonnet/)
  assert.match(detail,/Next +Fri, Jan 1 · 00:00 UTC \(in 12h 0m\)/)
  assert.ok(detail.includes('Second line &lt;b&gt;stays&lt;/b&gt; &amp; escaped.'))
  assert.equal((await scheduler.get(saved.id)).text,text)
  const other=scheduledTasksText(await scheduler.listTasksReadOnly([]),{...owner,pairedAt:'other-pairing'}).join('\n\n')
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
  assert.match(scheduledTaskDetailText(active[0],1),/Engine +codex · gpt-5.6-terra · max/)
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
    assert.ok(scheduledTasksText([active],owner).join('\n\n').includes(`Schedule · ${label}\n`))
    assert.ok(scheduledTaskDetailText(active,1).includes(`Schedule  ${label}\n`))
  }
})

test('the list shows a failed run reason and keeps the numbering that /tasks N resolves', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ez-schedule-list-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler=new Scheduler(dir),now=Date.UTC(2026,10,7,12,0),start='2026-01-01T00:00:00Z'
  const make=async(id:string,name:string)=>scheduler.save({id,name,text:'Inspect saved work.',owner,execution,enabled:true,trigger:{everySeconds:900,start}})
  await make('a','Actual Book daily IBKR Flex refresh')
  await make('b','Analyst')
  const base=await scheduler.listTasksReadOnly([])
  const reason='time="2026-11-08T07:16:11Z" level=warning msg="flex report unavailable: <timeout> & retry"'
  const views=base.map(s=>({...s,nextAt:now+60_000,lastRun:s.id==='a'?{status:'failed',at:new Date(now-3_600_000).toISOString(),currentRevision:true,reason}:undefined})) as ScheduledTaskView[]
  const text=scheduledTasksText(views,owner).join('\n\n')
  assert.match(text,/1 · Actual Book daily IBKR Flex refresh\n[\s\S]*Last · ✕ Failed · Sat, Nov 7 · 11:00 UTC\n  Reason · time="2026-11-08T07:16:11Z" level=warning msg="flex report unavailable: <timeout> & retry"\n/)
  assert.match(text,/2 · Analyst\n[\s\S]*Last · — Not run yet/)
  assert.deepEqual(ownedScheduledTasks(views,owner).map(s=>s.id),['a','b'])
})

test('a long list is split between task blocks, never inside one', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ez-schedule-split-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler=new Scheduler(dir)
  for(let i=0;i<40;i++) await scheduler.save({id:`t${i}`,name:`Task ${String(i).padStart(2,'0')}`,text:'Inspect saved work.',owner,execution,enabled:true,trigger:{everySeconds:900,start:'2026-01-01T00:00:00Z'}})
  const parts=scheduledTasksText(await scheduler.listTasksReadOnly([]),owner)
  assert.ok(parts.length>1)
  for(const part of parts) assert.ok(part.length<=4000)
  for(const part of parts.slice(1)) assert.match(part,/^\d+ · Task \d\d\n  ● Active\n/)
  const blocks=parts.flatMap(part=>part.split('\n\n')).filter(block=>/^\d+ · /.test(block))
  assert.equal(blocks.length,40)
  for(const block of blocks) assert.equal(block.split('\n').length,7)
})
