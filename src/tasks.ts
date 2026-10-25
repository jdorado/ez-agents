import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { ControlStore, sameOwner, ownerId, ownerEpoch, type Owner } from './control-state.js'
import { ApprovalStore } from './approval.js'
import { EventSources, sourceCall, type SourceEvent } from './event-sources.js'
import { RunStore, type RunRecord } from './runs.js'
import { requireOwnerExecution } from './execution-authority.js'
import { ownsRun } from './identity.js'
import {MAX_INCOMING_ATTACHMENT_BYTES,readChatAttachment} from './files.js'
import {ApplicationBindings} from './application-channel.js'
import {readTaskAttachment,type TaskAttachment} from './task-attachments.js'
import {applicationId} from './application-origin.js'

export type TaskCapability = { id: string; description: string; command: string; args: string[]; output?:'file'; access?:'read'|'write' }
// Owner-chosen admission caps for a scoped application grant, within core ceilings.
export type TaskLimits = {outstanding:number;hourly:number;total:number}
export const TASK_LIMIT_CEILINGS: TaskLimits = {outstanding:8,hourly:60,total:1000}
const validLimits = (value: unknown): value is TaskLimits => {
  const limits = value as Record<string, unknown> | undefined
  return !!limits && typeof limits === 'object' && Object.keys(limits).length === 3 && (Object.keys(TASK_LIMIT_CEILINGS) as (keyof TaskLimits)[])
    .every(key => Number.isSafeInteger(limits[key]) && Number(limits[key]) >= 1 && Number(limits[key]) <= TASK_LIMIT_CEILINGS[key])
}
const validScopes = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= TASK_LIMIT_CEILINGS.total &&
  value.every(applicationId) && new Set(value).size === value.length
type ContextReceipt = {runId:string;sha256:string;bytes:number;at:number}
type PublicBudget = {windowStartedAt:number;runs:number;responses:number;totalRuns:number;totalResponses:number}
const validPublicBudget = (value: unknown): value is PublicBudget => {
  if (!value || typeof value !== 'object') return false
  const budget = value as Record<string, unknown>
  return Object.keys(budget).length === 5 && ['windowStartedAt','runs','responses','totalRuns','totalResponses']
    .every(key => Number.isSafeInteger(budget[key]) && Number(budget[key]) >= 0)
}
export type Task = {
  version: 1 | 2 | 3 | 4 | 5; waitForIncoming?: true; untilRevoked?: true; anyConversation?: true; capabilities?: TaskCapability[]; unwatchPending?: true; id: string; runId: string; owner: Owner
  sourceId: string; bindingId: string; accountId: string; conversationId: string
  purpose: string; context: string; createdAt: number; expiresAt: number
  state: 'pending' | 'active' | 'revoked' | 'completed'
  grant?: string; initialRunDispatched?: true
  notes: string[]; operations: Record<string, { text: string; attachmentId?:string; voice?:true; state: 'uncertain' | 'accepted'; receipt?: unknown }>
  capabilityOperations?: Record<string, { capabilityId: string; inputHash: string; lease: string; attachment?:TaskAttachment; state: 'authorized' | 'completed'; runId?: string; tokenHash?: string; tokenExpiresAt?: number }>
  publicBudget?: PublicBudget
  // Version 5: a scoped application grant. sourceId/bindingId name the application
  // channel binding; each scope runs as its own task conversation.
  scopes?: string[]; limits?: TaskLimits; contextCapability?: string; seenEvents?: string[]; contextReceipts?: ContextReceipt[]
}
const idOK = (v: unknown): v is string => typeof v === 'string' && /^task_[a-f0-9]{32}$/.test(v)
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
// Channel queries end with literal `-- {input}`. Scoped capabilities also bind
// exactly one core-filled `{scope}` and may take no input at all.
const capability = (value: unknown, scoped = false): value is TaskCapability => {
  const item = value as TaskCapability | undefined
  if (!item || typeof item !== 'object' || !Object.keys(item).every(key => ['id','description','command','args','output','access'].includes(key)) ||
    typeof item.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(item.id) || !bounded(item.description,200) || /[\x00-\x1f\x7f]/.test(item.description) ||
    typeof item.command !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.command) || !Array.isArray(item.args) || item.args.length > 20 ||
    !item.args.every(arg => typeof arg === 'string' && arg.length <= 200 && !/[\x00-\x1f\x7f]/.test(arg))) return false
  const inputs = item.args.filter(arg => arg === '{input}').length, tail = item.args.at(-2) === '--' && item.args.at(-1) === '{input}'
  if (!scoped) return item.access === undefined && (item.output===undefined||item.output==='file') && inputs === 1 && tail
  return (item.access === 'read' || item.access === 'write') && item.output === undefined && item.args.filter(arg => arg === '{scope}').length === 1 && (inputs === 0 || (inputs === 1 && tail))
}
export const takesInput = (item: TaskCapability) => item.args.includes('{input}')
const capabilityList = (value: unknown, scoped: boolean) => Array.isArray(value) && value.length >= 1 && value.length <= 8 &&
  new Set(value.map((item: any) => item?.id)).size === value.length && value.every(item => capability(item, scoped))
const scopedTask = (task: Task) => task.waitForIncoming === true && task.anyConversation === undefined && task.conversationId === '*' &&
  (task.untilRevoked === undefined || (task.untilRevoked === true && task.expiresAt === 8640000000000000)) && validScopes(task.scopes) && validLimits(task.limits) &&
  validPublicBudget(task.publicBudget) && Array.isArray(task.seenEvents) && task.seenEvents.length <= task.limits.total && task.seenEvents.every(applicationId) &&
  Array.isArray(task.contextReceipts) && task.contextReceipts.length <= 100 &&
  (task.contextCapability === undefined || !!task.capabilities?.some(item => item.id === task.contextCapability && item.access === 'read' && !takesInput(item)))
export async function atomicTaskFile(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
}
// One mutation chain per control directory, shared by every Tasks instance in this
// process: application events, owner calls and worker calls edit the same records.
const chains = new Map<string, Promise<unknown>>()
export class Tasks {
  constructor(readonly controlDir: string, private speech?: (text:string) => Promise<{buffer:Buffer;mimeType:string}>) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(this.controlDir) ?? Promise.resolve()).then(fn, fn)
    chains.set(this.controlDir, next.catch(() => {})); return next
  }
  private get directory() { return join(this.controlDir, 'tasks') }
  async get(id: string): Promise<Task | null> {
    if (!idOK(id)) throw new Error('Invalid task ID')
    try {
      const task: Task = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'))
      if (!((task.version === 1 && task.waitForIncoming === undefined && task.untilRevoked === undefined && task.anyConversation === undefined) || (task.version === 2 && task.waitForIncoming === true && task.untilRevoked === undefined && task.anyConversation === undefined) || (task.version === 3 && task.waitForIncoming === true && task.untilRevoked === true && task.anyConversation === undefined && task.expiresAt === 8640000000000000) ||
        (task.version === 4 && task.waitForIncoming === true && task.untilRevoked === true && task.anyConversation === true && task.conversationId === '*' && task.expiresAt === 8640000000000000)) &&
        !(task.version === 5 && scopedTask(task)) ||
        (task.version !== 5 && [task.scopes,task.limits,task.contextCapability,task.seenEvents,task.contextReceipts].some(value => value !== undefined)) ||
        (task.capabilities !== undefined && !capabilityList(task.capabilities, task.version === 5)) || task.id !== id || !bounded(task.sourceId, 100) || !bounded(task.bindingId, 100) ||
        !bounded(task.accountId, 200) || !bounded(task.conversationId, 200) || !bounded(task.purpose, 1000) ||
        !bounded(task.context, 6000) || !Number.isFinite(task.createdAt) || !Number.isFinite(task.expiresAt) ||
        !['pending', 'active', 'revoked', 'completed'].includes(task.state) || !Array.isArray(task.notes) ||
        (task.grant !== undefined && (typeof task.grant !== 'string' || !/^[a-f0-9]{64}$/.test(task.grant))) ||
        (task.initialRunDispatched !== undefined && task.initialRunDispatched !== true) ||
        !task.operations || typeof task.operations !== 'object' || (task.capabilityOperations !== undefined && (!task.capabilityOperations || typeof task.capabilityOperations !== 'object')) ||
        (task.anyConversation && !validPublicBudget(task.publicBudget)) || !task.owner) throw new Error('Invalid task record')
      return task
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async save(task: Task) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await atomicTaskFile(join(this.directory, `${task.id}.json`), task)
  }
  async list(): Promise<Task[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const result: Task[] = []
    for (const file of await readdir(this.directory)) if (file.endsWith('.json')) {
      const task = await this.get(file.slice(0, -5)); if (task) result.push(task)
    }
    return result
  }
  private async source(task: Task) {
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    if (!owner || !sameOwner(task.owner, owner)) throw new Error('Task owner is no longer paired')
    const source = (await new EventSources(this.controlDir).available(owner)).find(s => s.id === task.sourceId && s.bindingId === task.bindingId)
    if (!source) throw new Error('Task source was removed or replaced')
    const head = await sourceCall(source.socketPath, 'events-head')
    if (head.taskProtocol !== 'message-v1' || head.accountId !== task.accountId) throw new Error('Task account or protocol changed')
    return source
  }
  async authorize(run: RunRecord, checkProvider = true): Promise<Task> {
    const task = run.taskId ? await this.get(run.taskId) : null
    if (!task || (task.waitForIncoming && !run.external && !run.application?.taskAccess && !run.application?.taskScope) || task.state !== 'active' || task.expiresAt <= Date.now() || run.version !== 2 ||
      !ownsRun(task.owner, run))
      throw new Error('Task is inactive or expired')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    if (!sameOwner(task.owner, owner) || (task.grant ? task.grant !== this.scopeHash(task) : !await this.approved(task)))
      throw new Error('Task approval is no longer valid')
    if (task.version === 5 || run.application?.taskScope) {
      if (task.version !== 5 || !run.application?.taskScope || run.application.bindingId !== task.bindingId || run.external || !task.scopes!.includes(run.application.scope))
        throw new Error('Task application scope mismatch')
      await this.application(task)
      return task
    }
    if(run.application?.taskAccess) {
      const access=await this.applicationAccess(run.application.taskAccess,run.application.bindingId,checkProvider)
      if(access.task.id!==task.id)throw Error('Task application scope mismatch')
    }
    if (checkProvider) await this.source(task)
    if (run.external && checkProvider) {
      if (run.external.sourceId !== task.sourceId || run.external.bindingId !== task.bindingId) throw new Error('Task origin mismatch')
      const events = await new EventSources(this.controlDir).check(run.external, task.owner)
      if (events.length !== run.external.eventIds.length || new Set(events.map(event => event.conversationId)).size !== 1 || events.some(e =>
        (!task.anyConversation && e.conversationId !== task.conversationId) || e.receivedAt < task.createdAt))
        throw new Error('Task correspondence no longer matches')
    }
    return task
  }
  async authorizeApplicationLaunch(runId:string,ticketHash:string) {
    const run=await new RunStore(this.controlDir).get(runId)
    if(!run || run.status!=='running' || run.application)throw Error('No active channel task')
    const task=await this.authorize(run)
    if(!/^[a-f0-9]{64}$/.test(ticketHash))throw Error('Invalid task launch')
    const record=JSON.parse(await readFile(join(this.controlDir,'task-applications',ticketHash+'.json'),'utf8'))
    const access=await this.applicationAccess(ticketHash,record.bindingId)
    if(access.runId!==runId || access.task.id!==task.id)throw Error('Task launch admission mismatch')
    const binding=(await new ApplicationBindings(this.controlDir).list()).find(b=>b.bindingId===record.bindingId)!
    return {launch:binding.taskLaunch!,taskId:task.id,expiresAt:access.expiresAt}
  }
  async applicationAccess(ticketHash: string, bindingId: string, checkProvider=true) {
    if(!/^[a-f0-9]{64}$/.test(ticketHash))throw Error('Invalid task access')
    const record=JSON.parse(await readFile(join(this.controlDir,'task-applications',ticketHash+'.json'),'utf8'))
    const task=await this.get(record.taskId), owner=(await new ControlStore(this.controlDir,900000).status()).owner
    const binding=(await new ApplicationBindings(this.controlDir).list()).find(b=>b.bindingId===bindingId)
    if(!task || task.state!=='active' || task.expiresAt<=Date.now() || record.expiresAt<=Date.now() || record.bindingId!==bindingId || record.grant!==this.scopeHash(task) || !binding?.taskLaunch || (binding.taskLaunch.tasks!=="all" && !binding.taskLaunch.tasks.includes(task.id)) || !sameOwner(binding.owner,owner) || !sameOwner(task.owner,owner) || (task.grant ? task.grant!==this.scopeHash(task) : !await this.approved(task)))throw Error('Task application access revoked or expired')
    if(checkProvider)await this.source(task)
    if(!bounded(record.contact,200) || (!task.anyConversation && record.contact!==task.conversationId))throw Error('Task application contact mismatch')
    return {task,contact:record.contact,runId:record.runId as string,expiresAt:record.expiresAt as number,execution:record.execution as RunRecord['execution']}
  }
  // A scoped grant's audience is one application channel binding of this owner.
  private async application(task: Task) {
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const binding = (await new ApplicationBindings(this.controlDir).list()).find(b => b.id === task.sourceId && b.bindingId === task.bindingId)
    if (!binding || !sameOwner(binding.owner, owner) || !sameOwner(task.owner, owner)) throw new Error('Task application channel was revoked or replaced')
    return binding
  }
  // Persist only the bounded grant, not transient approval/outbox state. Bind every
  // immutable authority field so later scope changes cannot reuse an old grant.
  private scopeHash(task: Task) {
    return createHash('sha256').update(JSON.stringify([
      task.id, task.runId, task.owner, task.sourceId, task.bindingId, task.accountId,
      task.conversationId, task.purpose, task.context, task.createdAt, task.expiresAt,
      task.waitForIncoming, task.untilRevoked, task.anyConversation, task.capabilities,
      // Appended only for version 5 so earlier grants keep their digest.
      ...(task.version === 5 ? [task.scopes, task.limits, task.contextCapability ?? null] : []),
    ])).digest('hex')
  }
  private async approved(task: Task) {
    const approval = await new ApprovalStore(this.controlDir).getDecision(task.id)
    const approvedByOwner = approval?.version === 2
      ? approval.decidedOwnerId === ownerId(task.owner) && approval.decidedOwnerEpoch === ownerEpoch(task.owner)
      : ownsRun(task.owner,{telegramUserId:approval?.decidedBy!,chatId:task.owner.telegramChatId})
    return approval?.decision === 'approved' && approvedByOwner && approval.runId === task.runId && approval.prompt === this.prompt(task)
  }
  private async dispatchInitial(task: Task) {
    if (task.waitForIncoming || task.initialRunDispatched) return
    // Runs are intentionally memory-only. Do not replay an opener after restart,
    // when its delivery may be unknown; subsequent inbound events still resume.
    task.initialRunDispatched = true
    await this.save(task)
    await new RunStore(this.controlDir).create({
      id: `event_${createHash('sha256').update(task.id).digest('hex')}`, taskId: task.id,
      ownerId: ownerId(task.owner), ownerEpoch: ownerEpoch(task.owner),
      chatId: task.owner.telegramChatId, telegramUserId: task.owner.telegramUserId, texts: [],
    })
  }
  async match(sourceId: string, bindingId: string, events: SourceEvent[]) {
    if (!events.length || new Set(events.map(event => event.conversationId)).size !== 1) return
    const matches = (await this.list()).filter(t => t.version !== 5 && t.state === 'active' && t.expiresAt > Date.now() &&
      t.sourceId === sourceId && t.bindingId === bindingId && events.every(e =>
        (t.anyConversation || e.conversationId === t.conversationId) && e.receivedAt >= t.createdAt))
    return matches.length === 1 ? matches[0] : undefined
  }
  async admitPublic(id:string):Promise<'admitted'|'defer'|'revoked'> {
    return this.serial(async()=>{
      const task=await this.get(id)
      if(!task?.anyConversation||task.state!=='active')return 'revoked'
      const now=Date.now(),budget=task.publicBudget!
      if(now-budget.windowStartedAt>=3600000){budget.windowStartedAt=now;budget.runs=0;budget.responses=0}
      if(budget.totalRuns>=1000||budget.totalResponses>=1000){task.state='revoked';task.unwatchPending=true;await this.save(task);await this.unwatch(task);return 'revoked'}
      if(budget.runs>=60)return 'defer'
      budget.runs++;budget.totalRuns++;await this.save(task);return 'admitted'
    })
  }
  private async unwatch(task: Task) {
    const source=await this.source(task)
    await sourceCall(source.socketPath,'task-unwatch',{accountId:task.accountId,conversationId:task.conversationId})
    delete task.unwatchPending
    await this.save(task)
  }
  async decide(id: string): Promise<boolean> {
    if (!idOK(id)) return false
    return this.serial(async () => {
      const task = await this.get(id)
      if (!task) return false
      if (task.state === 'revoked' && task.unwatchPending) { await this.unwatch(task); return true }
      if (!['pending', 'active'].includes(task.state) || task.expiresAt <= Date.now()) return false
      if (!task.grant) {
        const approval = await new ApprovalStore(this.controlDir).getDecision(id)
        if (!approval || approval.runId !== task.runId || approval.prompt !== this.prompt(task)) throw new Error('Task approval mismatch')
        if (approval.decision === 'pending') return true
        if (approval.decision === 'denied') {
          task.state = 'revoked'; await this.save(task); return true
        }
        if (!await this.approved(task)) throw new Error('Task approval is no longer valid')
        if (task.version === 5) await this.application(task)
        else {
          const source = await this.source(task)
          await sourceCall(source.socketPath, 'task-watch', { accountId: task.accountId, conversationId: task.conversationId, expiresAt: task.expiresAt })
        }
        if (task.state === 'active' && !task.waitForIncoming) task.initialRunDispatched = true
        task.state = 'active'; task.grant = this.scopeHash(task)
        await this.save(task)
      }
      if (task.grant !== this.scopeHash(task)) throw new Error('Task grant scope changed')
      await this.dispatchInitial(task)
      return true
    })
  }
  private prompt(task: Task) {
    if (task.version === 5) {
      const scopes = task.scopes!, limits = task.limits!
      const capabilities = task.capabilities ? `\nApproved scope-bound capabilities (output may be disclosed; write commands change application records):\n${task.capabilities.map(item => `- ${item.id} (${item.access}): ${item.description}; ez ${item.command} ${item.args.join(' ')}`).join('\n')}` : ''
      return `Allow this application task?\nApplication: ${task.sourceId}\nScopes: ${scopes.length} (${scopes.slice(0,5).join(', ')}${scopes.length > 5 ? ', ...' : ''}; list sha256 ${createHash('sha256').update(JSON.stringify(scopes)).digest('hex').slice(0,16)})\nPurpose: ${task.purpose}\nShared context (all may be disclosed to each scope's correspondent):\n${task.context}${capabilities}${task.contextCapability ? `\nFresh context each run: ${task.contextCapability}` : ''}\nLimits: ${limits.outstanding} outstanding; ${limits.hourly} runs and ${limits.hourly} replies per hour; ${limits.total} total, then owner review.\n${task.untilRevoked ? 'Enabled until owner revocation.' : `Expires: ${new Date(task.expiresAt).toISOString()}`}\nRuns start only on application events for these scopes; replies go to the application's channel. No payments, owner memory, unlisted capabilities, or settings changes.`
    }
    const audience = task.anyConversation ? `Any human conversation received by source ${task.sourceId}` : `Contact: ${task.conversationId}`
    const capabilities = task.capabilities ? `\nApproved capabilities (their output may be disclosed):\n${task.capabilities.map(item => `- ${item.id}: ${item.description}; ez ${item.command} ${item.args.join(' ')}`).join('\n')}` : ''
    return `Allow this messaging task?${task.waitForIncoming ? '\nWait for incoming messages; do not initiate contact.' : ''}\nSource: ${task.sourceId}\nAccount: ${task.accountId}\nAudience: ${audience}\nPurpose: ${task.purpose}\nShared context (all may be disclosed to this audience):\n${task.context}${capabilities}\n${task.anyConversation ? 'Budget: 60 conversations and 60 responses per hour; 1000 total, then owner review.' : ''}\n${task.untilRevoked ? 'Enabled until owner revocation.' : `Expires: ${new Date(task.expiresAt).toISOString()}`}\n${task.capabilities?.some(item=>item.output==='file') ? 'Text and files returned by the approved file capabilities only. No payments, owner memory, unlisted capabilities, or settings changes.' : 'Text messages only. No payments, files, owner memory, unlisted capabilities, or settings changes.'}`
  }
  async ownerCall(runId: string, command: string, args: Record<string, unknown>) {
    return this.serial(async () => {
      const run = await requireOwnerExecution(this.controlDir, runId)
      if (run.scheduled || run.id.startsWith('r_schedule_')) throw new Error('Task changes require a current owner message')
      if (command === 'list') return this.list()
      if (command === 'revoke') {
        const task = await this.get(String(args.taskId))
        if (!task || !ownsRun(task.owner, run)) throw new Error('Unknown task')
        if(task.state === 'revoked' && !task.unwatchPending) return {id:task.id,state:task.state}
        task.state = 'revoked'
        if(task.untilRevoked && task.version !== 5) task.unwatchPending=true
        await this.save(task)
        const runStore = new RunStore(this.controlDir)
        for (const candidate of await runStore.list()) if(candidate.taskId===task.id && candidate.status==='queued') {
          await runStore.patch(candidate.id,{status:'cancelled',endedAt:new Date().toISOString()})
          if(candidate.external)try {
            await new EventSources(this.controlDir).release(candidate.external,task.owner)
            await runStore.patch(candidate.id,{externalReleased:true})
          } catch { /* The relay retries unreleased terminal events. */ }
        }
        await runStore.pruneTaskHistory(task.id)
        if(task.unwatchPending) await this.unwatch(task)
        return { id: task.id, state: task.state }
      }
      if (command !== 'start' && command !== 'propose') throw new Error('Unknown owner task command')
      if (args.application !== undefined) return this.ownerScoped(runId, command, args)
      if (args.waitForIncoming !== undefined && typeof args.waitForIncoming !== 'boolean') throw new Error('Invalid incoming-only option')
      if (args.untilRevoked !== undefined && (typeof args.untilRevoked !== 'boolean' || (args.untilRevoked && args.waitForIncoming !== true))) throw new Error('Persistent permission requires incoming-only mode')
      if (args.anyConversation !== undefined && typeof args.anyConversation !== 'boolean') throw new Error('Invalid any-conversation option')
      const capabilities = args.capabilities === undefined ? undefined : args.capabilities
      if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 8 || new Set(capabilities.map((item: any) => item?.id)).size !== capabilities.length || capabilities.some(item => !capability(item))))
        throw new Error('Supply one to eight valid channel capabilities')
      if (capabilities && args.waitForIncoming !== true) throw new Error('Channel capabilities require incoming-only mode')
      if (args.anyConversation && (args.conversationId !== '*' || args.waitForIncoming !== true || args.untilRevoked !== true))
        throw new Error('Any-conversation access requires contact *, incoming-only, and until-revoked')
      if (!bounded(args.sourceId, 100) || !bounded(args.conversationId, 200) || !bounded(args.purpose, 1000) || !bounded(args.context, 6000) ||
        typeof args.hours !== 'number' || !Number.isFinite(args.hours) || args.hours <= 0 || args.hours > 72) throw new Error('Invalid task proposal (maximum 72 hours)')
      const owner = (await new ControlStore(this.controlDir, 900000).status()).owner!
      const source = (await new EventSources(this.controlDir).available(owner)).find(s => s.id === args.sourceId)
      if (!source) throw new Error('Unknown source')
      const head = await sourceCall(source.socketPath, 'events-head')
      if (args.untilRevoked && head.persistentWatch !== true) throw new Error('Source needs persistent-watch support before enabling an ongoing conversation')
      if (args.anyConversation && head.wildcardWatch !== true) throw new Error('This channel source does not support any-conversation access')
      if (head.taskProtocol !== 'message-v1' || !bounded(head.accountId, 200)) throw new Error('Source does not support task messaging')
      if ((await this.list()).some(t => t.version !== 5 && ((['active', 'pending'].includes(t.state) && t.expiresAt > Date.now()) || t.unwatchPending) && t.sourceId === source.id &&
        (t.conversationId === args.conversationId || t.anyConversation || args.anyConversation)))
        throw new Error('This contact already has a task; complete or revoke it first')
      const task: Task = { version: args.anyConversation ? 4 : args.untilRevoked ? 3 : args.waitForIncoming ? 2 : 1, ...(args.untilRevoked ? {untilRevoked:true as const} : {}), ...(args.waitForIncoming ? { waitForIncoming: true as const } : {}), ...(args.anyConversation ? {anyConversation:true as const,publicBudget:{windowStartedAt:Date.now(),runs:0,responses:0,totalRuns:0,totalResponses:0}} : {}), ...(capabilities ? {capabilities} : {}), id: `task_${randomUUID().replaceAll('-', '')}`, runId, owner, sourceId: source.id,
        bindingId: source.bindingId, accountId: head.accountId, conversationId: args.conversationId, purpose: args.purpose,
        context: args.context, createdAt: Date.now(), expiresAt: args.untilRevoked ? 8640000000000000 : Date.now() + args.hours * 3600000, state: 'pending', notes: [], operations: {} }
      if (command === 'start') {
        await sourceCall(source.socketPath, 'task-watch', { accountId: task.accountId, conversationId: task.conversationId, expiresAt: task.expiresAt })
        task.state = 'active'; task.grant = this.scopeHash(task)
        await this.save(task)
        await this.dispatchInitial(task)
        return { id: task.id, state: task.state }
      }
      if (this.prompt(task).length > 3500) throw new Error('Proposal is too long for owner review; shorten the shared context')
      await this.save(task)
      await new ApprovalStore(this.controlDir).requestApproval(task.id, this.prompt(task), runId)
      await new RunStore(this.controlDir).enqueueApproval(runId, this.prompt(task), task.id)
      return { id: task.id, state: task.state }
    })
  }
  // Caller holds the serial lock (ownerCall).
  private async ownerScoped(runId: string, command: 'start' | 'propose', args: Record<string, unknown>) {
    if (Object.keys(args).some(key => !['application','scopes','purpose','context','capabilities','contextCapability','limits','untilRevoked','hours'].includes(key) && args[key] !== undefined))
      throw new Error('Application tasks take an application, scopes, purpose, context, capabilities, limits and an expiry')
    const limits = args.limits ?? TASK_LIMIT_CEILINGS
    if (!applicationId(args.application) || !validScopes(args.scopes) || !bounded(args.purpose, 1000) || !bounded(args.context, 6000) || !validLimits(limits))
      throw new Error(`Supply an application, one to ${TASK_LIMIT_CEILINGS.total} unique scope IDs, purpose, context, and limits within ${JSON.stringify(TASK_LIMIT_CEILINGS)}`)
    if (args.capabilities !== undefined && !capabilityList(args.capabilities, true)) throw new Error('Supply one to eight valid scoped capabilities')
    const capabilities = args.capabilities as TaskCapability[] | undefined
    if (args.contextCapability !== undefined && !capabilities?.some(item => item.id === args.contextCapability && item.access === 'read' && !takesInput(item)))
      throw new Error('The context capability must be an approved read capability that takes no input')
    if (args.untilRevoked !== undefined && typeof args.untilRevoked !== 'boolean') throw new Error('Invalid until-revoked option')
    if (!args.untilRevoked && (typeof args.hours !== 'number' || !Number.isFinite(args.hours) || args.hours <= 0 || args.hours > 72)) throw new Error('Invalid task expiry (maximum 72 hours, or until revoked)')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner!
    const binding = (await new ApplicationBindings(this.controlDir).list()).find(item => item.id === args.application && sameOwner(item.owner, owner))
    if (!binding) throw new Error('Unknown application channel')
    const scopes = args.scopes as string[]
    if ((await this.list()).some(t => t.version === 5 && ['active', 'pending'].includes(t.state) && t.expiresAt > Date.now() && t.bindingId === binding.bindingId && t.scopes!.some(scope => scopes.includes(scope))))
      throw new Error('A scope already has an application task; revoke it first')
    const task: Task = { version: 5, waitForIncoming: true, ...(args.untilRevoked ? {untilRevoked: true as const} : {}), id: `task_${randomUUID().replaceAll('-', '')}`, runId, owner,
      sourceId: binding.id, bindingId: binding.bindingId, accountId: binding.id, conversationId: '*', purpose: args.purpose as string, context: args.context as string,
      createdAt: Date.now(), expiresAt: args.untilRevoked ? 8640000000000000 : Date.now() + (args.hours as number) * 3600000, state: 'pending', notes: [], operations: {},
      scopes, limits: limits as TaskLimits, publicBudget: {windowStartedAt:Date.now(),runs:0,responses:0,totalRuns:0,totalResponses:0}, seenEvents: [], contextReceipts: [],
      ...(capabilities ? {capabilities} : {}), ...(args.contextCapability ? {contextCapability: args.contextCapability as string} : {}) }
    if (command === 'start') {
      task.state = 'active'; task.grant = this.scopeHash(task)
      await this.save(task)
      return { id: task.id, state: task.state }
    }
    if (this.prompt(task).length > 3500) throw new Error('Proposal is too long for owner review; shorten the shared context')
    await this.save(task)
    await new ApprovalStore(this.controlDir).requestApproval(task.id, this.prompt(task), runId)
    await new RunStore(this.controlDir).enqueueApproval(runId, this.prompt(task), task.id)
    return { id: task.id, state: task.state }
  }
  private async refuse(bindingId: string, eventId: string, scope: string, reason: string) {
    const file = join(this.controlDir, 'task-event-refusals.json')
    const prior = await readFile(file, 'utf8').then(JSON.parse, () => [])
    await atomicTaskFile(file, [...(Array.isArray(prior) ? prior : []), {at: Date.now(), bindingId, eventId, scope, reason}].slice(-100))
    return {refused: reason}
  }
  // Admit one application event for a granted scope. Idempotent by event ID: a
  // retried event returns its run, and unmatched scopes never reach the owner.
  async applicationEvent(bindingId: string, input: unknown): Promise<{refused: string} | {defer: string} | {runId: string; duplicate: boolean}> {
    const value = input as {eventId?: unknown; scope?: unknown} | undefined
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'eventId' && key !== 'scope') || !applicationId(value.eventId) || !applicationId(value.scope))
      throw new Error('Invalid application task event: supply eventId and scope')
    const eventId = value.eventId, scope = value.scope
    return this.serial(async () => {
      const runId = `r_app_${createHash('sha256').update(JSON.stringify([bindingId, 'task-event', eventId])).digest('hex')}`
      const runs = new RunStore(this.controlDir), existing = await runs.get(runId)
      if (existing) {
        if (existing.application?.bindingId !== bindingId || existing.application.scope !== scope) throw new Error('Application task event ID conflicts with a prior event')
        return {runId, duplicate: true}
      }
      const now = Date.now()
      const task = (await this.list()).find(t => t.version === 5 && t.state === 'active' && t.expiresAt > now && t.bindingId === bindingId && t.scopes!.includes(scope))
      if (!task) return this.refuse(bindingId, eventId, scope, 'No active task grant for this scope')
      if (task.seenEvents!.includes(eventId)) return {runId, duplicate: true}
      if (task.grant !== this.scopeHash(task)) return this.refuse(bindingId, eventId, scope, 'Task grant scope changed')
      try { await this.application(task) } catch (error) { return this.refuse(bindingId, eventId, scope, (error as Error).message) }
      const budget = task.publicBudget!, limits = task.limits!
      if (budget.totalRuns >= limits.total) {
        task.state = 'revoked'; await this.save(task)
        return this.refuse(bindingId, eventId, scope, 'Task lifetime limit reached; owner review is required')
      }
      if (now - budget.windowStartedAt >= 3600000) { budget.windowStartedAt = now; budget.runs = 0; budget.responses = 0 }
      const outstanding = (await runs.list()).filter(run => run.taskId === task.id && ['queued','running'].includes(run.status)).length
      if (budget.runs >= limits.hourly || outstanding >= limits.outstanding) return {defer: 'Task admission limit reached; retry later'}
      budget.runs++; budget.totalRuns++; task.seenEvents!.push(eventId)
      await this.save(task)
      await runs.pruneTaskHistory(task.id)
      await runs.create({id: runId, ownerId: ownerId(task.owner), ownerEpoch: ownerEpoch(task.owner), taskId: task.id, texts: [],
        application: {bindingId, scope, requestId: eventId, taskScope: true}})
      return {runId, duplicate: false}
    })
  }
  // An application backend proves a plugin call is inside an active scoped grant.
  async verifyScopeToken(bindingId: string, token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid task scope token')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    for (const task of await this.list()) if (task.version === 5 && task.bindingId === bindingId) {
      const operation = Object.values(task.capabilityOperations ?? {}).find(item => item.tokenHash === tokenHash)
      if (!operation) continue
      const run = operation.runId ? await new RunStore(this.controlDir).get(operation.runId) : null
      if (operation.state !== 'authorized' || !(operation.tokenExpiresAt! > Date.now()) || !run || run.status !== 'running') break
      await this.authorize(run)
      const selected = task.capabilities!.find(item => item.id === operation.capabilityId)!
      return {taskId: task.id, scope: run.application!.scope, capability: selected.id, command: selected.command, access: selected.access, expiresAt: operation.tokenExpiresAt}
    }
    throw new Error('Task scope token is invalid, expired or revoked')
  }
  // Isolated executors reach plugins only through the broker; it asks the relay to
  // resolve a capability lease the task runner already holds for this run.
  async capabilityGrant(runId: string, input: unknown) {
    const value = input as {lease?: unknown; input?: unknown; token?: unknown}
    const run = await new RunStore(this.controlDir).get(runId)
    if (!run || run.status !== 'running' || typeof value?.lease !== 'string') throw new Error('No active task capability')
    const task = await this.authorize(run)
    const operation = Object.entries(task.capabilityOperations ?? {}).find(([key, item]) => key.startsWith(`${run.id}_`) && item.lease === value.lease && item.state === 'authorized')?.[1]
    const selected = task.capabilities?.find(item => item.id === operation?.capabilityId)
    const text = typeof value.input === 'string' ? value.input : ''
    if (!operation || !selected || createHash('sha256').update(text).digest('hex') !== operation.inputHash) throw new Error('Task capability lease is invalid')
    if (task.version === 5 && (typeof value.token !== 'string' || createHash('sha256').update(value.token).digest('hex') !== operation.tokenHash || !(operation.tokenExpiresAt! > Date.now())))
      throw new Error('Task capability token is invalid')
    const scope = task.version === 5 ? run.application!.scope : undefined
    return {command: selected.command, output: selected.output, access: selected.access,
      args: selected.args.map(arg => arg === '{input}' ? text : arg === '{scope}' && scope ? scope : arg),
      ...(scope ? {pluginContext: {task: {taskId: task.id, scope, capability: selected.id, access: selected.access, token: value.token, expiresAt: operation.tokenExpiresAt}}} : {})}
  }
  async workerCall(runId: string, command: string, args: Record<string, unknown>) {
    // One relay owns mutations. Revocation and dispatch acceptance share this lock.
    return this.serial(async () => {
      const run = await new RunStore(this.controlDir).get(runId)
      if (!run || run.status !== 'running') throw new Error('No active task run')
      const task = await this.authorize(run)
      const access=run.application?.taskAccess ? await this.applicationAccess(run.application.taskAccess,run.application.bindingId) : undefined
      const incoming = run.external ? await new EventSources(this.controlDir).check(run.external, task.owner) : []
      const scope = task.version === 5 ? run.application!.scope : undefined
      const contact = scope ?? access?.contact ?? (task.anyConversation ? incoming[0]?.conversationId : task.conversationId)
      if (!contact || incoming.some(event => event.conversationId !== contact)) throw new Error('Task correspondence changed')
      if(command==='application_launch') {
        if(run.application || task.anyConversation || scope || Object.keys(args).some(k=>!['application','ticketHash'].includes(k)) || typeof args.ticketHash!=='string' || !/^[a-f0-9]{64}$/.test(args.ticketHash))throw Error('Invalid task application launch')
        const binding=(await new ApplicationBindings(this.controlDir).list()).find(b=>b.id===args.application && b.taskLaunch && sameOwner(b.owner,task.owner))
        if(!binding?.taskLaunch || (binding.taskLaunch.tasks!=="all" && !binding.taskLaunch.tasks.includes(task.id)))throw Error('Task application launch is not authorized')
        const root=join(this.controlDir,'task-applications');await mkdir(root,{recursive:true,mode:0o700})
        let count=0
        for(const file of await readdir(root))if(/^[a-f0-9]{64}\.json$/.test(file)) {
          const value=await readFile(join(root,file),'utf8').then(JSON.parse,()=>null);if(!value || !(value.expiresAt>Date.now()))await unlink(join(root,file)).catch(()=>{});else count++
        }
        if(count>=128)throw Error('Too many task application launches')
        const expiresAt=Math.min(Date.now()+20*60*1000,task.expiresAt)
        await atomicTaskFile(join(root,args.ticketHash+'.json'),{taskId:task.id,bindingId:binding.bindingId,grant:this.scopeHash(task),contact,expiresAt,runId:run.id,execution:run.execution})
        return {launch:binding.taskLaunch,taskId:task.id,expiresAt}
      }
      if (command === 'context' && scope) {
        return { purpose: task.purpose, context: task.context, scope, expiresAt: task.untilRevoked ? null : task.expiresAt,
          capabilities: task.capabilities?.map(({id,description,access}) => ({id,description,access})),
          contextReceipt: task.contextReceipts!.find(item => item.runId === run.id),
          operations: Object.fromEntries(Object.entries(task.operations).filter(([key]) => key.startsWith(`${run.id}_`))) }
      }
      if (command === 'context') {
        return { purpose: task.purpose, context: task.context, contact,
        waitForIncoming: task.waitForIncoming === true, capabilities: task.capabilities?.map(({id,description}) => ({id,description})),
        expiresAt: task.untilRevoked ? null : task.expiresAt, notes: task.notes, operations: task.untilRevoked ? Object.fromEntries(Object.entries(task.operations).filter(([key])=>key.startsWith(`${run.id}_`))) : task.operations,
        incoming, ...(access ? {request:run.texts.join("\n")} : {}) }
      }
      if (command === 'read_attachment') {
        if (!run.external || typeof args.incomingId !== 'string' || !run.external.eventIds.includes(args.incomingId) || !incoming.some(event => event.id === args.incomingId)) throw Error('Document is outside this incoming task run')
        const source = (await new EventSources(this.controlDir).available(task.owner)).find(item => item.id === task.sourceId && item.bindingId === task.bindingId)
        if (!source) throw Error('Task source changed')
        const maximum = Math.ceil(MAX_INCOMING_ATTACHMENT_BYTES / 3) * 4
        const file = await sourceCall(source.socketPath, 'task-document', {accountId:task.accountId,conversationId:contact,incomingId:args.incomingId}, maximum + 1000)
        if (!file || typeof file.name !== 'string' || file.name.length > 255 || typeof file.data !== 'string' || file.data.length > maximum || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid incoming document')
        const bytes = Buffer.from(file.data,'base64')
        if (bytes.toString('base64') !== file.data || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Incoming document changed')
        const result = await readChatAttachment(this.controlDir,file.name,bytes)
        const current = await new RunStore(this.controlDir).get(runId)
        if (!current || current.status !== 'running') throw Error('Task run cancelled')
        await this.authorize(current)
        return {incomingId:args.incomingId,sha256:file.sha256,...result}
      }
      if (command === 'capability_begin' || command === 'capability_result') {
        const selected = task.capabilities?.find(item => item.id === args.id)
        if (!selected || (takesInput(selected) ? !bounded(args.input, 1000) : args.input !== undefined)) throw new Error('Channel capability is not authorized or has invalid input')
        const inputHash = createHash('sha256').update(typeof args.input === 'string' ? args.input : '').digest('hex')
        const key = `${run.id}_${selected.id}_${inputHash}`
        const prior = task.capabilityOperations?.[scope && typeof args.lease === 'string' ? `${key}_${args.lease}` : key]
        if (command === 'capability_result') {
          if (!prior || prior.lease !== args.lease) throw new Error('Channel capability lease is invalid')
          if(selected.output==='file') {
            const file=args.attachment as TaskAttachment
            if(file?.runId!==run.id||file?.id!==prior.lease)throw Error('Attachment lease mismatch')
            await readTaskAttachment(this.controlDir,file)
            prior.attachment=file
          }else if(args.attachment!==undefined)throw Error('Text capability cannot register an attachment')
          if (selected.id === task.contextCapability && scope) {
            if (typeof args.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.outputSha256) || !Number.isSafeInteger(args.bytes)) throw Error('Context fetch receipt is invalid')
            task.contextReceipts = [...task.contextReceipts!.filter(item => item.runId !== run.id), {runId: run.id, sha256: args.outputSha256, bytes: args.bytes as number, at: Date.now()}].slice(-100)
          }
          prior.state = 'completed'; delete prior.tokenHash; delete prior.tokenExpiresAt; await this.save(task); return {accepted:true}
        }
        // A scoped call carries a fresh short-lived token for the application backend.
        const token = scope ? randomBytes(32).toString('hex') : undefined
        const scoped = token ? {runId: run.id, tokenHash: createHash('sha256').update(token).digest('hex'), tokenExpiresAt: Date.now() + 60000} : {}
        const resolved = scope ? {...selected, args: selected.args.map(arg => arg === '{scope}' ? scope : arg)} : selected
        // Text queries reuse their lease; scoped calls get their own lease and token each.
        if (prior && !scope) {
          if (prior.state !== 'authorized') { prior.state = 'authorized'; await this.save(task) }
          return {capability:resolved,lease:prior.lease}
        }
        const active=(await new RunStore(this.controlDir).list()).filter(item=>item.taskId===task.id&&['queued','running'].includes(item.status)).map(item=>`${item.id}_`)
        task.capabilityOperations = Object.fromEntries(Object.entries(task.capabilityOperations ?? {}).filter(([item]) => active.some(prefix=>item.startsWith(prefix))))
        if (Object.keys(task.capabilityOperations ?? {}).filter(item => item.startsWith(`${run.id}_`)).length >= (scope ? 16 : 8)) throw new Error('Channel capability limit reached')
        const operation = {capabilityId:selected.id,inputHash,lease:randomUUID(),state:'authorized' as const,...scoped}
        task.capabilityOperations = {...task.capabilityOperations,[scope ? `${key}_${operation.lease}` : key]:operation}
        await this.save(task)
        return {capability:resolved,lease:operation.lease,...(token ? {token} : {})}
      }
      if (!bounded(args.text, 4096)) throw new Error('Supply text (maximum 4096 characters)')
      if (scope && command !== 'send') throw new Error('Application tasks reply and use their capabilities only')
      if (command === 'note') {
        if (task.anyConversation) throw new Error('Any-conversation tasks do not retain cross-conversation notes')
        if (task.untilRevoked) while (task.notes.join('').length + args.text.length > 16000) task.notes.shift()
        if (task.notes.join('').length + args.text.length > 16000) throw new Error('Task notes are full')
        task.notes.push(args.text); await this.save(task); return { saved: true }
      }
      if (command === 'complete' && task.waitForIncoming) throw new Error('This incoming-only watch stays active until expiry or owner revocation. Save a note and end this run; do not close the watch after replying.')
      if (command === 'report' || command === 'complete') {
        const item = await new RunStore(this.controlDir).enqueueMessage(run.id, `Task ${task.id} (${contact}) reports:\n${args.text}`)
        if (command === 'complete') { task.state = 'completed'; await this.save(task) }
        return { queued: item.id }
      }
      if (command !== 'send' || typeof args.key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(args.key)) throw new Error('Invalid task send')
      if (args.voice !== undefined && typeof args.voice !== 'boolean') throw new Error('Invalid voice flag')
      if (args.voice && (args.attachmentId !== undefined || args.text.length > 1000)) throw new Error('Voice replies require at most 1000 characters and no attachment')
      let attachment:TaskAttachment|undefined
      if(args.attachmentId!==undefined) {
        const operation=Object.entries(task.capabilityOperations??{}).find(([key,value])=>key.startsWith(`${run.id}_`)&&value.lease===args.attachmentId&&value.state==='completed')?.[1]
        attachment=operation?.attachment
        if(!attachment||attachment.runId!==run.id)throw Error('Attachment is not authorized for this run')
      }
      if (scope) {
        if (args.voice || args.attachmentId !== undefined) throw Error('Application task replies support text only')
        const key = `${run.id}_${args.key}`, prior = task.operations[key]
        if (prior) { if (prior.text !== args.text) throw Error('Message key already used for different text'); return prior }
        const budget = task.publicBudget!, limits = task.limits!, now = Date.now()
        if (now - budget.windowStartedAt >= 3600000) { budget.windowStartedAt = now; budget.runs = 0; budget.responses = 0 }
        if (budget.responses >= limits.hourly || budget.totalResponses >= limits.total) throw new Error('Application reply budget reached; owner review is required')
        const active = (await new RunStore(this.controlDir).list()).filter(item => item.taskId === task.id && ['queued','running'].includes(item.status)).map(item => `${item.id}_`)
        task.operations = Object.fromEntries(Object.entries(task.operations).filter(([item]) => active.some(prefix => item.startsWith(prefix))))
        if (Object.keys(task.operations).filter(item => item.startsWith(`${run.id}_`)).length >= 30) throw new Error('Task message limit reached for this run')
        budget.responses++; budget.totalResponses++
        const item = await new RunStore(this.controlDir).enqueueMessage(run.id, args.text)
        task.operations[key] = {text: args.text, state: 'accepted', receipt: {application: task.sourceId, queued: item.id}}
        await this.save(task); return task.operations[key]
      }
      if(access) {
        if(args.voice || args.attachmentId!==undefined)throw Error('Application task replies support text only')
        const key=`${run.id}_${args.key}`, prior=task.operations[key]
        if(prior){if(prior.text!==args.text)throw Error('Message key already used for different text');return prior}
        const item=await new RunStore(this.controlDir).enqueueMessage(run.id,args.text)
        task.operations[key]={text:args.text,state:'accepted',receipt:{application:run.application!.bindingId,queued:item.id}}
        await this.save(task);return task.operations[key]
      }
      const key = task.untilRevoked ? `${run.id}_${args.key}` : args.key
      const providerKey = `${task.id}_${task.untilRevoked ? createHash('sha256').update(key).digest('hex') : key}`
      const prior = Object.hasOwn(task.operations, key) ? task.operations[key] : undefined
      if (prior) {
        if (prior.text !== args.text || prior.attachmentId!==args.attachmentId || Boolean(prior.voice)!==Boolean(args.voice)) throw new Error('Message key already used for different text or attachment')
        return prior // Uncertain sends are never blindly retried.
      }
      const source = await this.source(task)
      if(args.voice) {
        const head=await sourceCall(source.socketPath,'events-head')
        if(head.taskVoice!==true)throw Error('This channel does not support voice replies')
        if(!this.speech)throw Error('Speech synthesis is not configured')
      }
      if(attachment) {
        const head=await sourceCall(source.socketPath,'events-head')
        if(head.taskAttachments!==true)throw Error('This channel does not support task attachments')
        if(Number.isSafeInteger(head.attachmentCaptionLimit)&&args.text.length>head.attachmentCaptionLimit)throw Error(`Attachment caption exceeds channel limit of ${head.attachmentCaptionLimit}`)
        await readTaskAttachment(this.controlDir,attachment)
      }
      if(task.anyConversation){const budget=task.publicBudget!,now=Date.now();if(now-budget.windowStartedAt>=3600000){budget.windowStartedAt=now;budget.runs=0;budget.responses=0}
        if(budget.responses>=60||budget.totalResponses>=1000)throw new Error('Public response budget reached; owner review is required')
        budget.responses++;budget.totalResponses++;await this.save(task)}
      if(task.untilRevoked) {
        const active=(await new RunStore(this.controlDir).list()).filter(item=>item.taskId===task.id&&['queued','running'].includes(item.status)).map(item=>`${item.id}_`)
        task.operations=Object.fromEntries(Object.entries(task.operations).filter(([item,value])=>active.some(prefix=>item.startsWith(prefix))||value.state==='uncertain'))
      }
      if (Object.keys(task.operations).filter(k=>!task.untilRevoked || k.startsWith(`${run.id}_`)).length >= 30) throw new Error('Task message limit reached; report to the owner')
      const message={text:args.text,...(args.voice?{voice:true as const}:{}),...(attachment?{attachmentId:attachment.id}:{})}
      // Synthesis happens before the provider is contacted, so its failure is a
      // definite non-send the engine may correct, not an uncertain operation.
      const audio = args.voice ? await this.speech!(args.text) : undefined
      if(audio && (audio.mimeType!=='audio/ogg' || audio.buffer.length>256000 || audio.buffer.subarray(0,4).toString()!=='OggS'))throw Error('Voice audio exceeds channel limits or has invalid format')
      task.operations = { ...task.operations, [key]: { ...message, state: 'uncertain' } }
      await this.save(task)
      try {
        const current = await new RunStore(this.controlDir).get(run.id)
        if (!current || current.status !== 'running') throw new Error('Task run ended before voice dispatch')
        await this.authorize(current)
        if ((await new RunStore(this.controlDir).get(run.id))?.status !== 'running') throw new Error('Task run ended before dispatch')
        if (task.expiresAt <= Date.now()) throw new Error('Task expired before dispatch')
        const receipt = await sourceCall(source.socketPath, 'task-send', {
          accountId: task.accountId, conversationId: contact, text: args.text, key: providerKey,
          ...(attachment?{attachment}:{}), ...(audio?{audio:{data:audio.buffer.toString('base64'),mimeType:audio.mimeType}}:{}),
        })
        if (receipt.accountId !== task.accountId || receipt.conversationId !== contact || receipt.key !== providerKey || receipt.state !== 'accepted')
          throw new Error('Uncertain provider receipt')
        task.operations = { ...task.operations, [key]: { ...message, state: 'accepted', receipt } }
        await this.save(task)
      } catch { /* Preserve uncertain across timeouts, crashes, and malformed receipts. */ }
      return task.operations[key]
    })
  }
}
