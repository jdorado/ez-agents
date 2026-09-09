import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ControlStore, type Owner } from './control-state.js'
import { ApprovalStore } from './approval.js'
import { EventSources, sourceCall, type SourceEvent } from './event-sources.js'
import { RunStore, type RunRecord } from './runs.js'
import { requireOwnerExecution } from './execution-authority.js'

export type Task = {
  version: 1; id: string; runId: string; owner: Owner
  sourceId: string; bindingId: string; accountId: string; conversationId: string
  purpose: string; context: string; createdAt: number; expiresAt: number
  state: 'pending' | 'active' | 'revoked' | 'completed'
  notes: string[]; operations: Record<string, { text: string; state: 'uncertain' | 'accepted'; receipt?: unknown }>
}
const idOK = (v: unknown): v is string => typeof v === 'string' && /^task_[a-f0-9]{32}$/.test(v)
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
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
      if (task.version !== 1 || task.id !== id || !bounded(task.sourceId, 100) || !bounded(task.bindingId, 100) ||
        !bounded(task.accountId, 200) || !bounded(task.conversationId, 200) || !bounded(task.purpose, 1000) ||
        !bounded(task.context, 6000) || !Number.isFinite(task.createdAt) || !Number.isFinite(task.expiresAt) ||
        !['pending', 'active', 'revoked', 'completed'].includes(task.state) || !Array.isArray(task.notes) ||
        !task.operations || typeof task.operations !== 'object' || !task.owner) throw new Error('Invalid task record')
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
    if (!owner || owner.telegramUserId !== task.owner.telegramUserId || owner.telegramChatId !== task.owner.telegramChatId)
      throw new Error('Task owner is no longer paired')
    const source = (await new EventSources(this.controlDir).available(owner)).find(s => s.id === task.sourceId && s.bindingId === task.bindingId)
    if (!source) throw new Error('Task source was removed or replaced')
    const head = await sourceCall(source.socketPath, 'events-head')
    if (head.taskProtocol !== 'message-v1' || head.accountId !== task.accountId) throw new Error('Task account or protocol changed')
    return source
  }
  async authorize(run: RunRecord, checkProvider = true): Promise<Task> {
    const task = run.taskId ? await this.get(run.taskId) : null
    if (!task || task.state !== 'active' || task.expiresAt <= Date.now() || run.version !== 2 ||
      run.chatId !== task.owner.telegramChatId || run.telegramUserId !== task.owner.telegramUserId)
      throw new Error('Task is inactive or expired')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const approval = await new ApprovalStore(this.controlDir).getDecision(task.id)
    if (!owner || owner.telegramUserId !== task.owner.telegramUserId || owner.telegramChatId !== task.owner.telegramChatId ||
      approval?.decision !== 'approved' || approval.decidedBy !== owner.telegramUserId || approval.runId !== task.runId || approval.prompt !== this.prompt(task))
      throw new Error('Task approval is no longer valid')
    if (checkProvider) await this.source(task)
    if (run.external && checkProvider) {
      if (run.external.sourceId !== task.sourceId || run.external.bindingId !== task.bindingId) throw new Error('Task origin mismatch')
      const events = await new EventSources(this.controlDir).check(run.external, task.owner)
      if (events.length !== run.external.eventIds.length || events.some(e => e.conversationId !== task.conversationId || e.receivedAt < task.createdAt))
        throw new Error('Task correspondence no longer matches')
    }
    return task
  }
  async match(sourceId: string, bindingId: string, events: SourceEvent[]) {
    const matches = (await this.list()).filter(t => t.state === 'active' && t.expiresAt > Date.now() &&
      t.sourceId === sourceId && t.bindingId === bindingId && events.every(e => e.conversationId === t.conversationId && e.receivedAt >= t.createdAt))
    return matches.length === 1 ? matches[0] : undefined
  }
  async decide(id: string): Promise<boolean> {
    if (!idOK(id)) return false
    return this.serial(async () => {
      const task = await this.get(id)
      if (!task) return false
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
      if (task.state === 'active' && task.expiresAt > Date.now()) await new RunStore(this.controlDir).create({
        id: `event_${createHash('sha256').update(task.id).digest('hex')}`, taskId: task.id, chatId: task.owner.telegramChatId, telegramUserId: task.owner.telegramUserId, texts: [],
      })
      return true
    })
  }
  private prompt(task: Task) {
    return `Allow this messaging task?\nSource: ${task.sourceId}\nAccount: ${task.accountId}\nContact: ${task.conversationId}\nPurpose: ${task.purpose}\nShared context (all may be disclosed to this contact):\n${task.context}\nExpires: ${new Date(task.expiresAt).toISOString()}\nText messages only. No payments, files, other contacts, or settings changes.`
  }
  async ownerCall(runId: string, command: string, args: Record<string, unknown>) {
    return this.serial(async () => {
      const run = await requireOwnerExecution(this.controlDir, runId)
      if (run.id.startsWith('r_update_')) throw new Error('Task changes require a current owner message')
      if (command === 'list') return this.list()
      if (command === 'revoke') {
        const task = await this.get(String(args.taskId))
        if (!task || task.owner.telegramUserId !== run.telegramUserId || task.owner.telegramChatId !== run.chatId) throw new Error('Unknown task')
        task.state = 'revoked'; await this.save(task); return { id: task.id, state: task.state }
      }
      if (command !== 'propose') throw new Error('Unknown owner task command')
      if (!bounded(args.sourceId, 100) || !bounded(args.conversationId, 200) || !bounded(args.purpose, 1000) || !bounded(args.context, 6000) ||
        typeof args.hours !== 'number' || !Number.isFinite(args.hours) || args.hours <= 0 || args.hours > 72) throw new Error('Invalid task proposal (maximum 72 hours)')
      const owner = (await new ControlStore(this.controlDir, 900000).status()).owner!
      const source = (await new EventSources(this.controlDir).available(owner)).find(s => s.id === args.sourceId)
      if (!source) throw new Error('Unknown source')
      const head = await sourceCall(source.socketPath, 'events-head')
      if (head.taskProtocol !== 'message-v1' || !bounded(head.accountId, 200)) throw new Error('Source does not support task messaging')
      if ((await this.list()).some(t => ['active', 'pending'].includes(t.state) && t.expiresAt > Date.now() && t.sourceId === source.id && t.conversationId === args.conversationId))
        throw new Error('This contact already has a task; complete or revoke it first')
      const task: Task = { version: 1, id: `task_${randomUUID().replaceAll('-', '')}`, runId, owner, sourceId: source.id,
        bindingId: source.bindingId, accountId: head.accountId, conversationId: args.conversationId, purpose: args.purpose,
        context: args.context, createdAt: Date.now(), expiresAt: Date.now() + args.hours * 3600000, state: 'pending', notes: [], operations: {} }
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
      if (command === 'context') {
        const incoming = run.external ? await new EventSources(this.controlDir).check(run.external, task.owner) : []
        if (incoming.some(e => e.conversationId !== task.conversationId || e.receivedAt < task.createdAt)) throw new Error('Task correspondence changed')
        return { purpose: task.purpose, context: task.context, contact: task.conversationId,
        expiresAt: task.expiresAt, notes: task.notes, operations: task.operations,
        incoming }
      }
      if (!bounded(args.text, 4096)) throw new Error('Supply text (maximum 4096 characters)')
      if (command === 'note') {
        if (task.notes.join('').length + args.text.length > 16000) throw new Error('Task notes are full')
        task.notes.push(args.text); await this.save(task); return { saved: true }
      }
      if (command === 'report' || command === 'complete') {
        const item = await new RunStore(this.controlDir).enqueueMessage(run.id, `Task ${task.id} (${task.conversationId}) reports:\n${args.text}`)
        if (command === 'complete') { task.state = 'completed'; await this.save(task) }
        return { queued: item.id }
      }
      if (command !== 'send' || typeof args.key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(args.key)) throw new Error('Invalid task send')
      const prior = Object.hasOwn(task.operations, args.key) ? task.operations[args.key] : undefined
      if (prior) {
        if (prior.text !== args.text) throw new Error('Message key already used for different text')
        return prior // Uncertain sends are never blindly retried.
      }
      if (Object.keys(task.operations).length >= 30) throw new Error('Task message limit reached; report to the owner')
      task.operations = { ...task.operations, [args.key]: { text: args.text, state: 'uncertain' } }
      await this.save(task)
      const source = await this.source(task)
      try {
        if (task.expiresAt <= Date.now()) throw new Error('Task expired before dispatch')
        const receipt = await sourceCall(source.socketPath, 'task-send', {
          accountId: task.accountId, conversationId: task.conversationId, text: args.text, key: `${task.id}_${args.key}`,
        })
        if (receipt.accountId !== task.accountId || receipt.conversationId !== task.conversationId || receipt.key !== `${task.id}_${args.key}` || receipt.state !== 'accepted')
          throw new Error('Uncertain provider receipt')
        task.operations = { ...task.operations, [args.key]: { text: args.text, state: 'accepted', receipt } }
        await this.save(task)
      } catch { /* Preserve uncertain across timeouts, crashes, and malformed receipts. */ }
      return task.operations[args.key]
    })
  }
}
