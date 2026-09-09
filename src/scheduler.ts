import { mkdir, readFile, readdir, writeFile, rename, link, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { assertId } from './identity.js'
import { type ExecutionChoice, isExecutionChoice } from './ai.js'
import { type Trigger, validateTrigger, nextOccurrence } from './schedule-time.js'
import { RunStore, type RunRecord } from './runs.js'

export type Schedule = {
  version: 1; id: string; revision: string; name: string; text: string; trigger: Trigger; enabled: boolean
  owner: { telegramUserId: number; telegramChatId: number; pairedAt: string }; execution: ExecutionChoice
}
export type ScheduledOrigin = { id: string; revision: string; dueAt: string; pairedAt: string }
export const validScheduledOrigin = (v: unknown): v is ScheduledOrigin => {
  const s = v as ScheduledOrigin
  return Boolean(s && /^[a-zA-Z0-9_-]+$/.test(s.id) && /^[a-zA-Z0-9_-]+$/.test(s.revision) &&
    Number.isFinite(Date.parse(s.dueAt)) && typeof s.pairedAt === 'string')
}
export const scheduledRunId = (s: Schedule, due: number) => 'r_schedule_' + createHash('sha256')
  .update(JSON.stringify([s.id,s.revision,due])).digest('hex')
const atomic = async (file: string, value: unknown, exclusive = false) => {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'})
    if (exclusive) await link(tmp,file)
    else await rename(tmp,file)
  } finally { await rm(tmp,{force:true}) }
}
export class Scheduler {
  private dir: string
  constructor(private controlDir: string) { this.dir = join(controlDir,'schedules') }
  private async ensure() { await mkdir(this.dir,{recursive:true,mode:0o700}) }
  async get(id: string): Promise<Schedule> {
    const s = JSON.parse(await readFile(join(this.dir,assertId(id)+'.json'),'utf8')) as Schedule
    if (s.version !== 1 || s.id !== id || !validScheduledOrigin({id:s.id,revision:s.revision,dueAt:new Date().toISOString(),pairedAt:s.owner?.pairedAt}) ||
      typeof s.enabled !== 'boolean' || !s.name || typeof s.text !== 'string' || !s.text.trim() ||
      !Number.isSafeInteger(s.owner?.telegramUserId) || !Number.isSafeInteger(s.owner?.telegramChatId) || !isExecutionChoice(s.execution))
      throw new Error('Invalid schedule record')
    validateTrigger(s.trigger)
    return s
  }
  async list(): Promise<Schedule[]> {
    await this.ensure()
    const result: Schedule[] = []
    for (const name of await readdir(this.dir)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue
      try { result.push(await this.get(name.slice(0,-5))) } catch { console.error('Unreadable schedule',name) }
    }
    return result
  }
  async save(input: Omit<Schedule,'version'|'revision'>, exclusive = false): Promise<Schedule> {
    await this.ensure(); assertId(input.id)
    if (!input.name || !input.text?.trim() || !isExecutionChoice(input.execution)) throw new Error('Schedule needs name, text and an AI selection')
    const s: Schedule = {...input,trigger:validateTrigger(input.trigger),version:1,revision:randomUUID()}
    if (nextOccurrence(s.trigger,Date.now()-1) === null) throw new Error('Schedule has no future occurrence within eight years')
    await atomic(join(this.dir,s.id+'.json'),s,exclusive)
    return s
  }
  async enable(id: string, enabled: boolean): Promise<Schedule> {
    const s = await this.get(id)
    // Pausing preserves the cursor. Resuming coalesces missed recurrences like restart.
    await atomic(join(this.dir,assertId(id)+'.json'),{...s,enabled})
    return {...s,enabled}
  }
  async remove(id: string) { await rm(join(this.dir,assertId(id)+'.json')) }
  async current(run: RunRecord, owner: Schedule['owner']): Promise<boolean> {
    if (!run.scheduled) return false
    try {
      const s = await this.get(run.scheduled.id)
      return s.revision === run.scheduled.revision && s.owner.pairedAt === owner.pairedAt &&
        s.owner.telegramUserId === owner.telegramUserId && s.owner.telegramChatId === owner.telegramChatId
    } catch { return false }
  }
  async cancel(runId: string) {
    assertId(runId); await this.ensure()
    const run = await new RunStore(this.controlDir).get(runId)
    if (!run?.scheduled) throw new Error('Unknown background run')
    await atomic(join(this.dir,runId+'.cancel'),{})
  }
  async cancelled(runId: string): Promise<boolean> {
    try { await readFile(join(this.dir,assertId(runId)+'.cancel')); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  async recover(runs: RunStore) {
    for (const run of await runs.list()) {
      if (!run.scheduled || run.status !== 'running') continue
      // The old relay owned the process. Stop any host-side counterpart, but do
      // not replay or claim to know whether its external actions completed.
      await mkdir(join(this.controlDir,'host-executor'),{recursive:true,mode:0o700})
      await writeFile(join(this.controlDir,'host-executor',assertId(run.id)+'.cancel'),'',{mode:0o600})
      await runs.patch(run.id,{status:'failed',interrupted:true,endedAt:new Date().toISOString()})
    }
  }
  async tick(owner: Schedule['owner'], runs: RunStore, now = Date.now()) {
    for (const s of await this.list()) {
      if (!s.enabled || s.owner.telegramUserId !== owner.telegramUserId || s.owner.telegramChatId !== owner.telegramChatId || s.owner.pairedAt !== owner.pairedAt) continue
      const cursor = join(this.dir,`${s.id}.${s.revision}.cursor`)
      try {
        let next: number | null
        try {
          const saved = JSON.parse(await readFile(cursor,'utf8'))
          if (saved.next !== null && !Number.isFinite(saved.next)) throw new Error('Invalid schedule cursor')
          next = saved.next
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          next = nextOccurrence(s.trigger,-1)
        }
        if (next === null || next > now) continue
        // Keep one occurrence active/queued per schedule. Coalesce missed ticks on completion.
        if ((await runs.list()).some(r => r.scheduled?.id === s.id &&
          (['queued','running'].includes(r.status) || (r.interrupted && r.scheduled.revision === s.revision)))) continue
        const future = nextOccurrence(s.trigger,now)
        await runs.create({id:scheduledRunId(s,next),chatId:s.owner.telegramChatId,
          telegramUserId:s.owner.telegramUserId,texts:[s.text],execution:s.execution,
          scheduled:{id:s.id,revision:s.revision,dueAt:new Date(next).toISOString(),pairedAt:s.owner.pairedAt}})
        // A restart between run creation and this cursor write sees the same occurrence ID.
        await atomic(cursor,{next:future})
      } catch { console.error('Schedule dispatch failed',s.id) }
    }
  }
}
