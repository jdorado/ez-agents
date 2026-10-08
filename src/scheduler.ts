import { validPreflight, installedPreflight, type Preflight, type PreflightReceipt } from './schedule-preflight.js'
import { assertEffort, assertScheduledModel } from './model-policy.js'
import { needsFailureReview } from './failure.js'
import { mkdir, readFile, readdir, writeFile, rename, link, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { type Owner, sameOwner, validOwner, ownerId, ownerEpoch } from './control-state.js'
import { validApplicationOrigin } from './application-origin.js'
import { ApplicationBindings } from './application-channel.js'
import { assertId, ownsRun } from './identity.js'
import { type AiPreset, type ExecutionChoice, isExecutionChoice, persistedPreset } from './ai.js'
import { type Trigger, validateTrigger, nextOccurrence } from './schedule-time.js'
import { RunStore, type RunRecord } from './runs.js'
import { Scripts, assertScriptArgs, assertScriptId, type ScriptRunRef } from './scripts.js'

export type Schedule = {
  originRunId?: string
  when?: 'unreviewed-failures'
  preflight?: Preflight
  version: 1; id: string; revision: string; name: string; text: string; trigger: Trigger; enabled: boolean
  owner: Owner
  // Exactly one execution type: an agent turn (execution) or a registered script.
  execution?: ExecutionChoice
  script?: { id: string; args: string[] }
  delivery?: { bindingId: string; scope: string }
}
export type ScheduledRunSummary = {
  status: 'completed' | 'failed' | 'cancelled'
  at: string
  currentRevision: boolean
}
export type ActiveSchedule = Schedule & { nextAt: number | null; runState?: 'queued' | 'running'; lastRun?: ScheduledRunSummary; scriptRevision?: string }
export type ScheduledOrigin = { id: string; revision: string; dueAt: string; pairedAt: string; originRunId?: string }
export const validScheduledOrigin = (v: unknown): v is ScheduledOrigin => {
  const s = v as ScheduledOrigin
  return Boolean(s && /^[a-zA-Z0-9_-]+$/.test(s.id) && /^[a-zA-Z0-9_-]+$/.test(s.revision) &&
    Number.isFinite(Date.parse(s.dueAt)) && typeof s.pairedAt === 'string' && (s.originRunId === undefined || /^[a-zA-Z0-9_-]+$/.test(s.originRunId)))
}
export const executionType = (s: Pick<Schedule,'script'>): 'agent' | 'script' => s.script ? 'script' : 'agent'
const validExecution = (s: Pick<Schedule,'execution'|'script'|'text'>) => s.script
  ? s.execution === undefined && (() => { try { assertScriptId(s.script!.id); assertScriptArgs(s.script!.args); return true } catch { return false } })()
  : isExecutionChoice(s.execution) && typeof s.text === 'string' && Boolean(s.text.trim())
// The run carries the registration revision/hash current when it was queued.
const scriptRef = async (controlDir: string, s: Schedule, owner: Owner): Promise<ScriptRunRef> => {
  const ref: ScriptRunRef = { id: s.script!.id, args: s.script!.args }
  try { const r = await new Scripts(controlDir).owned(s.script!.id, owner); return { ...ref, revision: r.revision, sha256: r.sha256 } }
  catch { return ref }
}
const runTexts = (s: Schedule, dueAt: string) => s.script ? [`[schedule ${s.id} due ${dueAt}] script ${s.script.id}`] : [`[schedule ${s.id} due ${dueAt}]`, s.text]
export const scheduledRunId = (s: Schedule, due: number) => 'r_schedule_' + createHash('sha256')
  .update(JSON.stringify([s.id,s.revision,due])).digest('hex')
export const holdsSchedule = (s: Schedule, r: RunRecord): boolean =>
  r.scheduled?.id === s.id && r.scheduled.revision === s.revision &&
  Boolean(r.interrupted || (s.when === 'unreviewed-failures' && r.status === 'failed'))
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
  constructor(private controlDir: string, private checkPreflight = installedPreflight) { this.dir = join(controlDir,'schedules') }
  private async ensure() { await mkdir(this.dir,{recursive:true,mode:0o700}) }
  async get(id: string): Promise<Schedule> {
    const s = JSON.parse(await readFile(join(this.dir,assertId(id)+'.json'),'utf8')) as Schedule
    if (s.version !== 1 || s.id !== id || !validScheduledOrigin({id:s.id,revision:s.revision,dueAt:new Date().toISOString(),pairedAt:s.owner?.pairedAt,originRunId:s.originRunId}) ||
      (s.when !== undefined && s.when !== 'unreviewed-failures') || (s.preflight !== undefined && !validPreflight(s.preflight)) || typeof s.enabled !== 'boolean' || !s.name || typeof s.text !== 'string' ||
      !validOwner(s.owner) || !validExecution(s) ||
      (s.delivery !== undefined && !validApplicationOrigin({...s.delivery, requestId: s.id})))
      throw new Error('Invalid schedule record')
    validateTrigger(s.trigger)
    return s
  }
  async list(): Promise<Schedule[]> {
    await this.ensure()
    return this.listReadOnly()
  }
  async listReadOnly(): Promise<Schedule[]> {
    let names: string[]
    try { names = await readdir(this.dir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const result: Schedule[] = []
    for (const name of names) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue
      try { result.push(await this.get(name.slice(0,-5))) } catch { console.error('Unreadable schedule',name) }
    }
    return result
  }
  async pendingOccurrence(s: Schedule): Promise<number | null> {
    try {
      const saved = JSON.parse(await readFile(join(this.dir,`${s.id}.${s.revision}.cursor`),'utf8'))
      if (saved.next !== null && !Number.isFinite(saved.next)) throw new Error('Invalid schedule cursor')
      return saved.next
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return nextOccurrence(s.trigger,-1)
    }
  }
  async listActiveReadOnly(runs: RunRecord[]): Promise<ActiveSchedule[]> {
    const active: ActiveSchedule[] = []
    for (const s of await this.listReadOnly()) {
      if (!s.enabled) continue
      const current = runs.filter(r => r.scheduled?.id === s.id && r.scheduled.revision === s.revision && ownsRun(s.owner,r))
      const history = runs.filter(r => r.scheduled?.id === s.id && r.scheduled.pairedAt === s.owner.pairedAt && ownsRun(s.owner,r))
        .filter((r): r is RunRecord & { status: ScheduledRunSummary['status'] } =>
          r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled')
        .sort((a,b) => (b.endedAt ?? b.startedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.startedAt ?? a.createdAt))
      const last = history[0]
      const runState = current.some(r => r.status === 'running') ? 'running' : current.some(r => r.status === 'queued') ? 'queued' : undefined
      if (!runState && current.some(r => holdsSchedule(s,r))) continue
      try {
        const nextAt = await this.pendingOccurrence(s)
        const scriptRevision = s.script ? await new Scripts(this.controlDir).get(s.script.id).then(r => r.revision, () => undefined) : undefined
        if (runState || nextAt !== null) active.push({...s,nextAt,runState,...(scriptRevision ? {scriptRevision} : {}),...(last ? {
          lastRun: {status:last.status,at:last.endedAt ?? last.startedAt ?? last.createdAt,currentRevision:last.scheduled!.revision===s.revision},
        } : {})})
      }
      catch { console.error('Unreadable schedule cursor',s.id) }
    }
    return active
  }
  async save(input: Omit<Schedule,'version'|'revision'>, exclusive = false): Promise<Schedule> {
    await this.ensure(); assertId(input.id)
    if (input.when !== undefined && input.when !== 'unreviewed-failures') throw new Error('Unknown schedule condition')
    if(input.preflight !== undefined && !validPreflight(input.preflight)) throw Error('Invalid schedule preflight')
    let s: Schedule
    if (input.script) {
      if (input.execution !== undefined || !input.name) throw new Error('Script schedules need a name and no AI selection')
      const script = {id:assertScriptId(input.script.id),args:assertScriptArgs(input.script.args)}
      await new Scripts(this.controlDir).owned(script.id, input.owner)
      s = {...input, text:'', script, trigger:validateTrigger(input.trigger),version:1,revision:randomUUID()}
    } else {
      if (!input.execution) throw new Error('Schedule needs name, text and an AI selection')
      const execution: ExecutionChoice = {...input.execution, preset: persistedPreset(input.execution.preset)}
      if (!input.name || !input.text?.trim() || !isExecutionChoice(execution)) throw new Error('Schedule needs name, text and an AI selection')
      const setups = [execution.preset, ...execution.fallbacks ?? []]
      for (const preset of setups) {
        assertScheduledModel(preset.model)
        assertEffort(preset.effort, preset.model, preset.cli)
      }
      const key = (p: AiPreset) => JSON.stringify([p.cli, p.provider, p.model, p.effort])
      if (new Set(setups.map(key)).size !== setups.length) throw new Error('Task setups must be distinct')
      s = {...input, execution, trigger:validateTrigger(input.trigger),version:1,revision:randomUUID()}
    }
    const now = Date.now()
    let next = nextOccurrence(s.trigger,now-1)
    if (next === null) throw new Error('Schedule has no future occurrence within eight years')
    if (!exclusive) {
      let previous: Schedule | null = null
      try { previous = await this.get(s.id) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (previous) {
        if (sameOwner(previous.owner,s.owner) && JSON.stringify(previous.trigger) === JSON.stringify(s.trigger)) {
          const pending = await this.pendingOccurrence(previous)
          if (pending !== null && pending >= now) next = pending
        }
        // Publish the cursor first so a crash cannot expose a new revision with
        // a missing cursor that falls back to the trigger's historical start.
        const prior=await this.preflightReceipt(previous)
        await atomic(join(this.dir,`${s.id}.${s.revision}.cursor`),{next,...(JSON.stringify(previous.preflight)===JSON.stringify(s.preflight) && prior ? {preflight:prior} : {})})
      }
    }
    await atomic(join(this.dir,s.id+'.json'),s,exclusive)
    return s
  }
  async preflight(id:string, revision:string) {
    const s=await this.get(id)
    if(s.revision!==revision || !s.enabled || !s.preflight) throw Error('Schedule preflight is unavailable')
    const receipt=await this.checkPreflight(id,revision)
    const cursor=join(this.dir,`${s.id}.${s.revision}.cursor`)
    const previous=await readFile(cursor,'utf8').then(v=>JSON.parse(v)).catch(async e=>{if(e.code==='ENOENT')return {next:await this.pendingOccurrence(s)};throw e})
    const admitted=receipt.eligible && (s.preflight.on!=='changed' || previous.preflight?.fingerprint!==receipt.fingerprint)
    return {receipt,admitted,previous,cursor}
  }
  async preflightReceipt(s:Schedule) {
    try {return JSON.parse(await readFile(join(this.dir,`${s.id}.${s.revision}.cursor`),'utf8')).preflight}
    catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e}
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
      return s.revision === run.scheduled.revision && sameOwner(s.owner, owner) &&
        (!!s.delivery || ((s.owner.telegramLinkedAt ?? s.owner.pairedAt) === (owner.telegramLinkedAt ?? owner.pairedAt) && s.owner.telegramChatId === owner.telegramChatId))
    } catch { return false }
  }
  async cancel(runId: string, run?: RunRecord | null) {
    assertId(runId); await this.ensure()
    const record = run ?? await new RunStore(this.controlDir).get(runId)
    if (!record?.scheduled) throw new Error('Unknown background run')
    await atomic(join(this.dir,runId+'.cancel'),{})
  }
  async cancelled(runId: string): Promise<boolean> {
    try { await readFile(join(this.dir,assertId(runId)+'.cancel')); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  async trigger(id: string, revision: string, key: string, owner: Owner, runs: RunStore): Promise<RunRecord> {
    const s=await this.get(id)
    if (!sameOwner(s.owner,owner) || !s.enabled || s.revision !== revision) throw new Error('Schedule is disabled, changed or outside this owner binding')
    if (s.script) await new Scripts(this.controlDir).owned(s.script.id, owner)
    else assertScheduledModel(s.execution!.preset.model)
    if (s.delivery) {
      const binding=(await new ApplicationBindings(this.controlDir).list()).find(b=>b.bindingId===s.delivery!.bindingId)
      if (!binding || !sameOwner(binding.owner,owner)) throw new Error('Schedule delivery binding is unavailable')
    } else if (!owner.telegramChatId || owner.telegramChatId !== s.owner.telegramChatId || owner.telegramUserId !== s.owner.telegramUserId || (owner.telegramLinkedAt ?? owner.pairedAt) !== (s.owner.telegramLinkedAt ?? s.owner.pairedAt)) throw new Error('Schedule Telegram binding is unavailable')
    const runId='r_schedule_manual_'+createHash('sha256').update(JSON.stringify([s.id,ownerId(owner),ownerEpoch(owner),assertId(key)])).digest('hex')
    const existing=await runs.get(runId)
    if (existing) {
      if (!ownsRun(owner,existing) || existing.scheduled?.revision !== s.revision) throw new Error('Request key belongs to a different task revision or owner')
      return existing
    }
    const all=await runs.list()
    if (all.some(r=>holdsSchedule(s,r))) throw new Error('Inspect the held occurrence and edit the schedule before retrying')
    if (s.when === 'unreviewed-failures' && !all.some(r=>needsFailureReview(r) && ownsRun(owner,r) && (!r.scheduled || r.scheduled.pairedAt===owner.pairedAt))) throw new Error('Schedule condition is not met')
    let checked: Awaited<ReturnType<Scheduler['preflight']>> | undefined
    if(s.preflight) {
      checked=await this.preflight(s.id,s.revision)
      if(!checked.receipt.eligible) throw Error('Schedule preflight has no eligible work')
      const current=await this.get(s.id)
      if(!current.enabled || current.revision!==s.revision) throw Error('Schedule changed during preflight')
    }
    const dueAt=new Date().toISOString()
    const run=await runs.create({id:runId,ownerId:ownerId(owner),ownerEpoch:ownerEpoch(owner),
      ...(s.delivery ? {delivery:s.delivery} : {chatId:s.owner.telegramChatId,telegramUserId:s.owner.telegramUserId,telegramEpoch:s.owner.telegramLinkedAt ?? s.owner.pairedAt}),
      texts:runTexts(s,dueAt),...(s.script ? {script:await scriptRef(this.controlDir,s,owner)} : {execution:{...s.execution!,sessionId:randomUUID()}}),
      scheduled:{id:s.id,revision:s.revision,dueAt,pairedAt:s.owner.pairedAt,...(s.originRunId ? {originRunId:s.originRunId} : {})}},true)
    if(checked) await atomic(checked.cursor,{...checked.previous,preflight:checked.receipt})
    return run
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
      if (!s.enabled || !sameOwner(s.owner, owner)) continue
      if (s.delivery) {
        const binding = (await new ApplicationBindings(this.controlDir).list()).find(b => b.bindingId === s.delivery!.bindingId)
        if (!binding || !sameOwner(binding.owner, owner)) continue
      } else if (!owner.telegramChatId || owner.telegramChatId !== s.owner.telegramChatId || owner.telegramUserId !== s.owner.telegramUserId || (owner.telegramLinkedAt ?? owner.pairedAt) !== (s.owner.telegramLinkedAt ?? s.owner.pairedAt)) continue
      const cursor = join(this.dir,`${s.id}.${s.revision}.cursor`)
      try {
        const next = await this.pendingOccurrence(s)
        if (next === null || next > now) continue
        if (!s.script) assertScheduledModel(s.execution!.preset.model)
        // One occurrence at a time. A failed reviewer stops this revision just like
        // interrupted work: retain its receipt until an explicit schedule edit.
        if ((await runs.list()).some(r => r.scheduled?.id === s.id &&
          (['queued','running'].includes(r.status) || holdsSchedule(s, r)))) continue
        const future = nextOccurrence(s.trigger,now)
        if (s.when === 'unreviewed-failures' && !(await runs.list()).some(r => needsFailureReview(r) && ownsRun(owner, r) && (!r.scheduled || r.scheduled.pairedAt === owner.pairedAt))) {
          await atomic(cursor,{next:future}); continue
        }
        let preflight: PreflightReceipt | undefined
        if(s.preflight) {
          try {
            const checked=await this.preflight(s.id,s.revision)
            preflight=checked.receipt
            if(!checked.admitted) {await atomic(cursor,{next:future,preflight});continue}
            const current=await this.get(s.id);if(!current.enabled || current.revision!==s.revision)continue
          } catch (error) {console.error('Schedule preflight unavailable',s.id,error instanceof Error ? error.message : 'Unknown error');const prior=await readFile(cursor,'utf8').then(v=>JSON.parse(v)).catch(e=>{if(e.code==='ENOENT')return {};throw e});await atomic(cursor,{next:future,preflight:{...prior.preflight,state:'unavailable',observedAt:new Date().toISOString()}});continue}
        }
        const dueAt = new Date(next).toISOString()
        await runs.create({id:scheduledRunId(s,next),
          ownerId:ownerId(owner),ownerEpoch:ownerEpoch(owner),
          ...(s.delivery ? {delivery:s.delivery} : {chatId:s.owner.telegramChatId,telegramUserId:s.owner.telegramUserId,telegramEpoch:s.owner.telegramLinkedAt ?? s.owner.pairedAt}),
          texts:runTexts(s,dueAt),...(s.script ? {script:await scriptRef(this.controlDir,s,owner)} : {execution:s.execution}),
          scheduled:{id:s.id,revision:s.revision,dueAt,pairedAt:s.owner.pairedAt,...(s.originRunId?{originRunId:s.originRunId}:{})}},true)
        // A restart between run creation and this cursor write sees the same occurrence ID.
        await atomic(cursor,{next:future,...(preflight ? {preflight} : {})})
      } catch (error) { console.error('Schedule dispatch failed',s.id,error instanceof Error ? error.message : 'Unknown error') }
    }
  }
}
