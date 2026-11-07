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
  const text = scheduledTasksText(active, owner, now).join('\n')

  assert.match(text, /^<b>📅 Scheduled tasks<\/b> · 1 active · 0 paused\n<pre> #  Task +Runs +Next +Last\n 1  ● Daily report +Wkdy 09:00 +due +✓<\/pre>\n▶ running/)
  assert.doesNotMatch(text, /Read the ledger|Needs attention/)
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
  assert.match(scheduledTasksText([paused],owner).join('\n'),/0 active · 1 paused[\s\S]*‖ paused +Once +paused/)
  assert.match(scheduledTasksText([paused],{...owner,pairedAt:'different'}).join('\n'),/No scheduled tasks/)
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
  assert.match(scheduledTasksText([view],owner).join('\n'),/◌ once/)
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

test('the list never shows instructions; the detail shows them with the engine path and preserves stored input', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-preview-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const text='/goal '+ '🧪'.repeat(150)+'.\nSecond line <b>stays</b> & escaped.'
  const saved=await scheduler.save({id:'preview',name:'Preview',text,owner,
    execution:{...execution,preset:{...execution.preset,model:'gpt-5.6-terra',effort:'high'},fallbacks:[{id:'fb',name:'Fallback',cli:'claude',model:'sonnet'}]},
    enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const active=await scheduler.listTasksReadOnly([])
  const now = Date.UTC(2026,11,31,12,0)
  assert.doesNotMatch(scheduledTasksText(active,owner,now).join('\n'),/🧪|gpt-5.6-terra|Second line/)
  const detail=scheduledTaskDetailText(active[0],1,1,now)
  assert.match(detail,/Engine +codex \(default login\) · gpt-5.6-terra · high\n +→ claude \(default login\) · sonnet/)
  assert.match(detail,/Next +Fri, Jan 1 · 00:00 UTC \(in 12h 0m\)/)
  assert.ok(detail.includes('Second line &lt;b&gt;stays&lt;/b&gt; &amp; escaped.'))
  assert.equal((await scheduler.get(saved.id)).text,text)
  const other=scheduledTasksText(await scheduler.listTasksReadOnly([]),{...owner,pairedAt:'other-pairing'}).join('\n')
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
  assert.match(scheduledTaskDetailText(active[0],1),/Engine +codex \(default login\) · gpt-5.6-terra · max/)
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
  const cases:[Trigger,string,string][]=[
    [{at:start},'Once','Once'],[{everySeconds:60,start},'Every minute','Every 1m'],[{everySeconds:90,start},'Every 90 seconds','Every 90s'],
    [{everySeconds:3600,start},'Every hour','Hourly'],[{everySeconds:172800,start},'Every 2 days','Every 2d'],
    [{cron:'*/15 * * * *',timezone,start},'Every 15 minutes · America/New_York','Every 15m'],
    [{cron:'*/30 * * * *',timezone,start},'Every 30 minutes · America/New_York','Every 30m'],
    [{cron:'15 * * * *',timezone,start},'Hourly at :15 · America/New_York','Hourly :15'],
    [{cron:'30 9 * * *',timezone,start},'Daily at 09:30 · America/New_York','Daily 09:30'],
    [{cron:'*/7 * * * *',timezone,start},'Cron */7 * * * * · America/New_York','Cron */7 *…'],
    [{cron:'0 9 1 * 1',timezone,start},'Cron 0 9 1 * 1 · America/New_York','Cron 0 9 1…'],
  ]
  for(const [i,[trigger,label,short]] of cases.entries()){
    const saved=await scheduler.save({id:`t-${i}`,name:`Task ${i}`,text:'Inspect saved work.',owner,execution,enabled:true,trigger})
    const active=(await scheduler.listTasksReadOnly([])).find(s=>s.id===saved.id)!
    assert.ok(scheduledTasksText([active],owner).join('\n').includes(` ${short.padEnd(11)} `), short)
    assert.ok(scheduledTaskDetailText(active,1).includes(`Schedule  ${label}\n`))
  }
})

test('the list is a fixed-column table with an attention block, chunked and escaped', async t => {
  const dir=await mkdtemp(join(tmpdir(),'ez-schedule-table-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler=new Scheduler(dir),now=Date.UTC(2026,10,7,12,0),start='2026-01-01T00:00:00Z'
  const iso=(minutes:number)=>new Date(now+minutes*60_000).toISOString()
  const make=async(id:string,name:string,trigger:Trigger)=>scheduler.save({id,name,text:'Inspect saved work.',owner,execution,enabled:true,trigger})
  await make('a','daily-brief',{cron:'0 7 * * *',timezone:'Asia/Dubai',start})
  await make('b','nightly-sync <x>',{cron:'0 2 * * 1-5',timezone:'UTC',start})
  await make('c','weekly-review',{cron:'0 9 * * 1',timezone:'Asia/Dubai',start})
  await make('d','price-watch',{everySeconds:900,start})
  await make('e','inbox-triage',{cron:'30 * * * *',timezone:'UTC',start})
  await make('f','a-very-long-task-name',{everySeconds:3600,start})
  const base=await scheduler.listTasksReadOnly([])
  const view=(id:string,change:object)=>({...base.find(s=>s.id===id)!,...change}) as ScheduledTaskView
  const views=[
    view('a',{nextAt:now+130*60_000,runState:'running',lastRun:{status:'completed',at:iso(-21*60),currentRevision:true}}),
    view('b',{nextAt:now+14*3_600_000,lastRun:{status:'failed',at:iso(-8*60),currentRevision:true,reason:'exit 1: market <data> timeout'}}),
    view('c',{enabled:false,nextAt:null,lastRun:{status:'completed',at:iso(-3*1440),currentRevision:true}}),
    view('d',{nextAt:now+7*60_000,lastRun:{status:'completed',at:iso(-60),currentRevision:true}}),
    view('e',{nextAt:null,runState:'queued',quotaWait:{retryAt:iso(180)}}),
    view('f',{nextAt:now+4*86_400_000}),
  ]
  const [text]=scheduledTasksText(views,owner,now)
  assert.equal(text,[
    '<b>📅 Scheduled tasks</b> · 5 active · 1 paused','',
    '<b>⚠ Needs attention</b>',
    '◌ <b>inbox-triage</b> waiting for quota · next check in 3h 0m',
    '✕ <b>nightly-sync &lt;x&gt;</b> failed 8h 0m ago · exit 1: market &lt;data&gt; timeout',
    '<pre> #  Task             Runs        Next    Last',
    ' 1  ● a-very-long-t… Hourly      4d 0h   —',
    ' 2  ▶ daily-brief    Daily 07:00 2h 10m  ✓',
    ' 3  ◌ inbox-triage   Hourly :30  —       —',
    ' 4  ● nightly-sync…  Wkdy 02:00  14h 0m  ✕',
    ' 5  ● price-watch    Every 15m   7m      ✓',
    ' 6  ‖ weekly-review  Cron 0 9 *… paused  ✓</pre>',
    '▶ running ◌ queued ‖ paused · ✓ ok ✕ failed ⊘ cancelled',
    '/tasks N for details',
  ].join('\n'))
  // Numbers follow the alphabetical order that /tasks N resolves.
  assert.deepEqual(ownedScheduledTasks(views,owner).map(s=>s.id),['f','a','e','b','d','c'])
  // More than 40 tasks split into several messages, each with its own balanced table.
  const many=Array.from({length:95},(_,index)=>({...views[0],id:`m${index}`,name:`task-${String(index).padStart(2,'0')}`}))
  const parts=scheduledTasksText(many,owner,now)
  assert.equal(parts.length,3)
  for(const part of parts){assert.equal(part.split('<pre>').length,2);assert.equal(part.split('</pre>').length,2);assert.ok(part.length<4000)}
  assert.ok(parts[2].endsWith('/tasks N for details'))
  assert.match(parts[2],/95  ▶ task-94/)
})
