import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ControlStore, sameOwner, ownerId, ownerEpoch, type Owner } from './control-state.js'
import { ApprovalStore } from './approval.js'
import { EventSources, sourceCall, type SourceEvent } from './event-sources.js'
import { RunStore, type RunRecord } from './runs.js'
import { requireOwnerExecution } from './execution-authority.js'
import { ownsRun } from './identity.js'

export type TaskCapability = { id: string; description: string; command: string; args: string[] }
type PublicBudget = {windowStartedAt:number;runs:number;responses:number;totalRuns:number;totalResponses:number}
const validPublicBudget = (value: unknown): value is PublicBudget => {
  if (!value || typeof value !== 'object') return false
  const budget = value as Record<string, unknown>
  return Object.keys(budget).length === 5 && ['windowStartedAt','runs','responses','totalRuns','totalResponses']
    .every(key => Number.isSafeInteger(budget[key]) && Number(budget[key]) >= 0)
}
export type Task = {
  version: 1 | 2 | 3 | 4; waitForIncoming?: true; untilRevoked?: true; anyConversation?: true; capabilities?: TaskCapability[]; unwatchPending?: true; id: string; runId: string; owner: Owner
  sourceId: string; bindingId: string; accountId: string; conversationId: string
  purpose: string; context: string; createdAt: number; expiresAt: number
  state: 'pending' | 'active' | 'revoked' | 'completed'
  notes: string[]; operations: Record<string, { text: string; state: 'uncertain' | 'accepted'; receipt?: unknown }>
  capabilityOperations?: Record<string, { capabilityId: string; inputHash: string; lease: string; state: 'authorized' | 'completed' }>
  publicBudget?: PublicBudget
}
const idOK = (v: unknown): v is string => typeof v === 'string' && /^task_[a-f0-9]{32}$/.test(v)
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const capability = (value: unknown): value is TaskCapability => {
  const item = value as TaskCapability | undefined
  return !!item && typeof item === 'object' && Object.keys(item).every(key => ['id','description','command','args'].includes(key)) &&
    typeof item.id === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(item.id) && bounded(item.description,200) && !/[\x00-\x1f\x7f]/.test(item.description) &&
    typeof item.command === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item.command) && Array.isArray(item.args) && item.args.length >= 2 && item.args.length <= 20 &&
    item.args.every(arg => typeof arg === 'string' && arg.length <= 200 && !/[\x00-\x1f\x7f]/.test(arg)) && item.args.at(-2) === '--' && item.args.at(-1) === '{input}' &&
    item.args.filter(arg => arg === '{input}').length === 1
}
export async function atomicTaskFile(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
}
export class Tasks {
  private work: Promise<unknown> = Promise.resolve()
  constructor(readonly controlDir: string) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.work.then(fn, fn); this.work = next.catch(() => {}); return next
  }
  private get directory() { return join(this.controlDir, 'tasks') }
  async get(id: string): Promise<Task | null> {
    if (!idOK(id)) throw new Error('Invalid task ID')
    try {
      const task: Task = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'))
      if (!((task.version === 1 && task.waitForIncoming === undefined && task.untilRevoked === undefined && task.anyConversation === undefined) || (task.version === 2 && task.waitForIncoming === true && task.untilRevoked === undefined && task.anyConversation === undefined) || (task.version === 3 && task.waitForIncoming === true && task.untilRevoked === true && task.anyConversation === undefined && task.expiresAt === 8640000000000000) ||
        (task.version === 4 && task.waitForIncoming === true && task.untilRevoked === true && task.anyConversation === true && task.conversationId === '*' && task.expiresAt === 8640000000000000)) ||
        (task.capabilities !== undefined && (!Array.isArray(task.capabilities) || task.capabilities.length < 1 || task.capabilities.length > 8 || new Set(task.capabilities.map(item => item.id)).size !== task.capabilities.length || task.capabilities.some(item => !capability(item)))) || task.id !== id || !bounded(task.sourceId, 100) || !bounded(task.bindingId, 100) ||
        !bounded(task.accountId, 200) || !bounded(task.conversationId, 200) || !bounded(task.purpose, 1000) ||
        !bounded(task.context, 6000) || !Number.isFinite(task.createdAt) || !Number.isFinite(task.expiresAt) ||
        !['pending', 'active', 'revoked', 'completed'].includes(task.state) || !Array.isArray(task.notes) ||
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
    if (!task || (task.waitForIncoming && !run.external) || task.state !== 'active' || task.expiresAt <= Date.now() || run.version !== 2 ||
      !ownsRun(task.owner, run))
      throw new Error('Task is inactive or expired')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const approval = await new ApprovalStore(this.controlDir).getDecision(task.id)
    const approvedByOwner = approval?.version === 2
      ? approval.decidedOwnerId === ownerId(task.owner) && approval.decidedOwnerEpoch === ownerEpoch(task.owner)
      : !!owner && ownsRun(owner,{telegramUserId:approval?.decidedBy!,chatId:task.owner.telegramChatId})
    if (!sameOwner(task.owner, owner) || approval?.decision !== 'approved' || !approvedByOwner || approval.runId !== task.runId || approval.prompt !== this.prompt(task))
      throw new Error('Task approval is no longer valid')
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
  async match(sourceId: string, bindingId: string, events: SourceEvent[]) {
    if (!events.length || new Set(events.map(event => event.conversationId)).size !== 1) return
    const matches = (await this.list()).filter(t => t.state === 'active' && t.expiresAt > Date.now() &&
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
      const approval = await new ApprovalStore(this.controlDir).getDecision(id)
      if (!approval || approval.runId !== task.runId || approval.prompt !== this.prompt(task)) throw new Error('Task approval mismatch')
      if (task.state === 'pending' && approval.decision !== 'pending') {
        task.state = approval.decision === 'approved' ? 'active' : 'revoked'
        if (task.state === 'active') {
          const source = await this.source(task)
          await sourceCall(source.socketPath, 'task-watch', { accountId: task.accountId, conversationId: task.conversationId, expiresAt: task.expiresAt })
        }
        await this.save(task)
      }
      if (task.state === 'active' && !task.waitForIncoming && task.expiresAt > Date.now()) await new RunStore(this.controlDir).create({
        id: `event_${createHash('sha256').update(task.id).digest('hex')}`, taskId: task.id, chatId: task.owner.telegramChatId, telegramUserId: task.owner.telegramUserId, texts: [],
      })
      return true
    })
  }
  private prompt(task: Task) {
    const audience = task.anyConversation ? `Any human conversation received by source ${task.sourceId}` : `Contact: ${task.conversationId}`
    const capabilities = task.capabilities ? `\nApproved capabilities (their output may be disclosed):\n${task.capabilities.map(item => `- ${item.id}: ${item.description}; ez ${item.command} ${item.args.join(' ')}`).join('\n')}` : ''
    return `Allow this messaging task?${task.waitForIncoming ? '\nWait for incoming messages; do not initiate contact.' : ''}\nSource: ${task.sourceId}\nAccount: ${task.accountId}\nAudience: ${audience}\nPurpose: ${task.purpose}\nShared context (all may be disclosed to this audience):\n${task.context}${capabilities}\n${task.anyConversation ? 'Budget: 60 conversations and 60 responses per hour; 1000 total, then owner review.' : ''}\n${task.untilRevoked ? 'Enabled until owner revocation.' : `Expires: ${new Date(task.expiresAt).toISOString()}`}\nText messages only. No payments, files, owner memory, unlisted capabilities, or settings changes.`
  }
  async ownerCall(runId: string, command: string, args: Record<string, unknown>) {
    return this.serial(async () => {
      const run = await requireOwnerExecution(this.controlDir, runId)
      if (run.scheduled || run.id.startsWith('r_update_') || run.id.startsWith('r_schedule_')) throw new Error('Task changes require a current owner message')
      if (command === 'list') return this.list()
      if (command === 'revoke') {
        const task = await this.get(String(args.taskId))
        if (!task || !ownsRun(task.owner, run)) throw new Error('Unknown task')
        if(task.state === 'revoked' && !task.unwatchPending) return {id:task.id,state:task.state}
        task.state = 'revoked'
        if(task.untilRevoked) task.unwatchPending=true
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
      if (command !== 'propose') throw new Error('Unknown owner task command')
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
      if ((await this.list()).some(t => ((['active', 'pending'].includes(t.state) && t.expiresAt > Date.now()) || t.unwatchPending) && t.sourceId === source.id &&
        (t.conversationId === args.conversationId || t.anyConversation || args.anyConversation)))
        throw new Error('This contact already has a task; complete or revoke it first')
      const task: Task = { version: args.anyConversation ? 4 : args.untilRevoked ? 3 : args.waitForIncoming ? 2 : 1, ...(args.untilRevoked ? {untilRevoked:true as const} : {}), ...(args.waitForIncoming ? { waitForIncoming: true as const } : {}), ...(args.anyConversation ? {anyConversation:true as const,publicBudget:{windowStartedAt:Date.now(),runs:0,responses:0,totalRuns:0,totalResponses:0}} : {}), ...(capabilities ? {capabilities} : {}), id: `task_${randomUUID().replaceAll('-', '')}`, runId, owner, sourceId: source.id,
        bindingId: source.bindingId, accountId: head.accountId, conversationId: args.conversationId, purpose: args.purpose,
        context: args.context, createdAt: Date.now(), expiresAt: args.untilRevoked ? 8640000000000000 : Date.now() + args.hours * 3600000, state: 'pending', notes: [], operations: {} }
      if (this.prompt(task).length > 3500) throw new Error('Proposal is too long for owner review; shorten the shared context')
      await this.save(task)
      await new ApprovalStore(this.controlDir).requestApproval(task.id, this.prompt(task), runId)
      await new RunStore(this.controlDir).enqueueApproval(runId, this.prompt(task), task.id)
      return { id: task.id, state: task.state }
    })
  }
  async workerCall(runId: string, command: string, args: Record<string, unknown>) {
    // One relay owns mutations. Revocation and dispatch acceptance share this lock.
    return this.serial(async () => {
      const run = await new RunStore(this.controlDir).get(runId)
      if (!run || run.status !== 'running') throw new Error('No active task run')
      const task = await this.authorize(run)
      const incoming = run.external ? await new EventSources(this.controlDir).check(run.external, task.owner) : []
      const contact = task.anyConversation ? incoming[0]?.conversationId : task.conversationId
      if (!contact || incoming.some(event => event.conversationId !== contact)) throw new Error('Task correspondence changed')
      if (command === 'context') {
        return { purpose: task.purpose, context: task.context, contact,
        waitForIncoming: task.waitForIncoming === true, capabilities: task.capabilities?.map(({id,description}) => ({id,description})),
        expiresAt: task.untilRevoked ? null : task.expiresAt, notes: task.notes, operations: task.untilRevoked ? Object.fromEntries(Object.entries(task.operations).filter(([key])=>key.startsWith(`${run.id}_`))) : task.operations,
        incoming }
      }
      if (command === 'capability_begin' || command === 'capability_result') {
        const selected = task.capabilities?.find(item => item.id === args.id)
        if (!selected || !bounded(args.input, 1000)) throw new Error('Channel capability is not authorized or has invalid input')
        const inputHash = createHash('sha256').update(args.input).digest('hex')
        const key = `${run.id}_${selected.id}_${inputHash}`
        const prior = task.capabilityOperations?.[key]
        if (command === 'capability_result') {
          if (!prior || prior.lease !== args.lease) throw new Error('Channel capability lease is invalid')
          prior.state = 'completed'; await this.save(task); return {accepted:true}
        }
        if (prior) return {capability:selected,lease:prior.lease}
        task.capabilityOperations = Object.fromEntries(Object.entries(task.capabilityOperations ?? {}).filter(([item]) => item.startsWith(`${run.id}_`)))
        if (Object.keys(task.capabilityOperations ?? {}).filter(item => item.startsWith(`${run.id}_`)).length >= 8) throw new Error('Channel capability limit reached')
        const operation = {capabilityId:selected.id,inputHash,lease:randomUUID(),state:'authorized' as const}
        task.capabilityOperations = {...task.capabilityOperations,[key]:operation}
        await this.save(task)
        return {capability:selected,lease:operation.lease}
      }
      if (!bounded(args.text, 4096)) throw new Error('Supply text (maximum 4096 characters)')
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
      const key = task.untilRevoked ? `${run.id}_${args.key}` : args.key
      const providerKey = `${task.id}_${task.untilRevoked ? createHash('sha256').update(key).digest('hex') : key}`
      const prior = Object.hasOwn(task.operations, key) ? task.operations[key] : undefined
      if (prior) {
        if (prior.text !== args.text) throw new Error('Message key already used for different text')
        return prior // Uncertain sends are never blindly retried.
      }
      if(task.anyConversation){const budget=task.publicBudget!,now=Date.now();if(now-budget.windowStartedAt>=3600000){budget.windowStartedAt=now;budget.runs=0;budget.responses=0}
        if(budget.responses>=60||budget.totalResponses>=1000)throw new Error('Public response budget reached; owner review is required')
        budget.responses++;budget.totalResponses++;await this.save(task)}
      if(task.untilRevoked)task.operations=Object.fromEntries(Object.entries(task.operations).filter(([item,value])=>item.startsWith(`${run.id}_`)||value.state==='uncertain'))
      if (Object.keys(task.operations).filter(k=>!task.untilRevoked || k.startsWith(`${run.id}_`)).length >= 30) throw new Error('Task message limit reached; report to the owner')
      task.operations = { ...task.operations, [key]: { text: args.text, state: 'uncertain' } }
      await this.save(task)
      const source = await this.source(task)
      try {
        if (task.expiresAt <= Date.now()) throw new Error('Task expired before dispatch')
        const receipt = await sourceCall(source.socketPath, 'task-send', {
          accountId: task.accountId, conversationId: contact, text: args.text, key: providerKey,
        })
        if (receipt.accountId !== task.accountId || receipt.conversationId !== contact || receipt.key !== providerKey || receipt.state !== 'accepted')
          throw new Error('Uncertain provider receipt')
        task.operations = { ...task.operations, [key]: { text: args.text, state: 'accepted', receipt } }
        await this.save(task)
      } catch { /* Preserve uncertain across timeouts, crashes, and malformed receipts. */ }
      return task.operations[key]
    })
  }
}
