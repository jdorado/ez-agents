import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler } from '../src/scheduler.js'
import { scheduledTasksText } from '../src/scheduled-tasks.js'

const owner = { telegramUserId: 101, telegramChatId: 101, pairedAt: '2026-09-11T00:00:00.000Z' }
const execution = { sessionId: randomUUID(), preset: { id: 'fixture', name: 'Fixture', cli: 'codex' } }

test('scheduled task view is read-only, owner-bound, and shows active task prompts and effective AI settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-scheduled-tasks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scheduler = new Scheduler(dir)

  assert.deepEqual(await scheduler.listReadOnly(), [])
  await assert.rejects(access(join(dir, 'schedules')), /ENOENT/)

  await scheduler.save({
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
  const text = scheduledTasksText(await scheduler.listActiveReadOnly([]), owner)

  assert.equal(text, 'Active scheduled tasks\n\n• Daily report\n  codex · client default · default effort\n  Next: 2026-01-01 05:00:00 UTC\n  Read the ledger and send the owner a concise report.')
  assert.doesNotMatch(text, /Other owner task|This must never be visible/)
  assert.equal(await readFile(join(scheduleDir, 'owner-task.json'), 'utf8'), before)
  assert.deepEqual(await readdir(scheduleDir), entries)
})

test('active view follows existing cursor and run state without changing schedules', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-active-schedules-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const { RunStore } = await import('../src/runs.js')
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
  const names = async () => (await scheduler.listActiveReadOnly(await runs.list())).map(s=>s.id).sort()
  assert.deepEqual(await names(),['expired','interrupted','once','recurring','review'])
  await scheduler.tick(owner,runs,due)
  // The empty conditional review consumes its occurrence without creating work.
  assert.deepEqual(await names(),['expired','interrupted','once','recurring'])
  const queued = (await runs.list()).find(r=>r.scheduled?.id==='once')!
  const view = (await scheduler.listActiveReadOnly(await runs.list())).find(s=>s.id==='once')!
  assert.equal(view.nextAt,null)
  assert.equal(view.runState,'queued')
  assert.match(scheduledTasksText([view],owner),/Queued/)
  await runs.patch(queued.id,{status:'running'})
  assert.equal((await scheduler.listActiveReadOnly(await runs.list())).find(s=>s.id==='once')!.runState,'running')
  for (const run of await runs.list()) await runs.patch(run.id,run.scheduled?.id==='interrupted'
    ? {status:'failed',interrupted:true} : {status:'completed'})
  const before = await readdir(join(dir,'schedules'))
  assert.deepEqual(await names(),['recurring'])
  assert.deepEqual(await readdir(join(dir,'schedules')),before)
  // A held recurring revision remains hidden even when its cursor has a later occurrence.
  const interrupted = await scheduler.get('interrupted')
  assert.equal('everySeconds' in interrupted.trigger && interrupted.trigger.everySeconds,60)
  // A new schedule revision has its own occurrence; old terminal runs cannot hide it.
  await scheduler.save({...common,id:'once',name:'once',trigger:{at:new Date(due+60_000).toISOString()}})
  assert.deepEqual(await names(),['once','recurring'])
})

test('prompt preview is one bounded Unicode sentence and preserves stored input', async t => {
  const dir = await mkdtemp(join(tmpdir(),'ez-schedule-preview-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const scheduler = new Scheduler(dir)
  const text='/goal '+ '🧪'.repeat(150)+'.\nDo not display this second sentence.'
  const saved=await scheduler.save({id:'preview',name:'Preview',text,owner,
    execution:{...execution,preset:{...execution.preset,model:'gpt-5.6-terra',effort:'high'}},
    enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}})
  const output=scheduledTasksText(await scheduler.listActiveReadOnly([]),owner)
  assert.match(output,/gpt-5.6-terra · high/)
  assert.match(output,/Next: 2027-01-01 00:00:00 UTC/)
  assert.equal(Array.from(output.split('\n').at(-1)!.trim()).length,140)
  assert.ok(output.endsWith('…'))
  assert.doesNotMatch(output,/Do not display/)
  assert.equal((await scheduler.get(saved.id)).text,text)
  const other=scheduledTasksText(await scheduler.listActiveReadOnly([]),{...owner,pairedAt:'other-pairing'})
  assert.match(other,/No active scheduled tasks/)
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

  const active = await scheduler.listActiveReadOnly([])
  assert.match(scheduledTasksText(active,owner),/codex · gpt-5.6-terra · max/)
})
