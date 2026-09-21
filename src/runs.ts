import { validApplicationOrigin, type ApplicationOrigin } from './application-origin.js'
import { type FailureEvidence, type FailureReview, validFailureReview, failureStamp, failureEvidence } from './failure.js'
import { randomBytes } from 'node:crypto'
import { validOrigin, type ExternalOrigin } from './event-sources.js'
import { normalizeReactionEmoji } from './reaction.js'
import { validScheduledOrigin, type ScheduledOrigin } from './scheduler.js'
import type { IncomingItem } from './inbox.js'
import { assertId } from './identity.js'
import { isExecutionChoice, type ExecutionChoice } from './ai.js'
import {authorizeDeliveryContext,currentDeliveryOwner,type DeliveryContext} from './delivery-context.mjs'

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type RunRecord = {
  version: 1 | 2
  taskId?: string
  id: string
  ownerId?: string
  ownerEpoch?: string
  telegramEpoch?: string
  chatId?: number
  telegramUserId?: number
  messageId?: number
  items?: IncomingItem[]
  texts: string[]
  status: RunStatus
  createdAt: string
  startedAt?: string
  endedAt?: string
  backendSubmitted?: boolean
  pid?: number
  blockReason?: string
  execution?: ExecutionChoice
  replyOnly?: boolean
  exitCode?: number | null
  failureReason?: string
  failure?: FailureEvidence
  failureReview?: FailureReview
  interrupted?: boolean
  nativeSessionId?: string
  scheduled?: ScheduledOrigin
  external?: ExternalOrigin
  externalReleased?: true
  application?: ApplicationOrigin
  telegramApplication?: ApplicationOrigin
  delivery?: { bindingId: string; scope: string }
}

export type OutboxItemType = 'message' | 'reaction' | 'document' | 'voice' | 'approval'

export type OutboxItem = {
  id: string
  runId?: string
  deliveryContext?: DeliveryContext
  chatId?: number
  type?: OutboxItemType
  text?: string
  emoji?: string
  messageId?: number
  replyToMessageId?: number
  documentPath?: string
  voiceText?: string
  approvalPrompt?: string
  approvalActionId?: string
  createdAt: string
}

export type StoredOutboxItem = OutboxItem & { state?: 'queued' | 'sending' | 'sent' | 'failed'; deliveryError?: string; deliveryUnknown?: boolean; receipt?: unknown }

// Memory scan of settled outbox items for explicit history reads.
export const sentOutbox = (controlDir: string): StoredOutboxItem[] =>
  [...outboxFor(controlDir).values()].filter(item => item.state === 'sent')

// Stateless pipe: the relay owns the ledger in process memory. Cross-process
// producers (engine children, plugin children, host executor) reach it through
// the delivery socket (see delivery-socket.ts), never through control/ files.
// A restart drops in-flight runs and queued items by design; in-flight sends
// report unknown rather than claiming success. Long-lived relays cap retained
// terminal records so memory stays bounded.
const MAX_TERMINAL_RUNS = 2000
const MAX_TERMINAL_OUTBOX = 2000

const runsByControl = new Map<string, Map<string, RunRecord>>()
const outboxByControl = new Map<string, Map<string, StoredOutboxItem>>()
const deliveryWaiters = new Map<string, Map<string, Set<() => void>>>()

const runsFor = (controlDir: string): Map<string, RunRecord> => {
  let map = runsByControl.get(controlDir)
  if (!map) { map = new Map(); runsByControl.set(controlDir, map) }
  return map
}

const outboxFor = (controlDir: string): Map<string, StoredOutboxItem> => {
  let map = outboxByControl.get(controlDir)
  if (!map) { map = new Map(); outboxByControl.set(controlDir, map) }
  return map
}

const waitersFor = (controlDir: string): Map<string, Set<() => void>> => {
  let map = deliveryWaiters.get(controlDir)
  if (!map) { map = new Map(); deliveryWaiters.set(controlDir, map) }
  return map
}

const notifyDelivery = (controlDir: string, id: string): void => {
  const waiters = deliveryWaiters.get(controlDir)?.get(id)
  if (!waiters) return
  deliveryWaiters.get(controlDir)!.delete(id)
  for (const resolve of [...waiters]) resolve()
}

const pruneTerminals = (controlDir: string): void => {
  const store = runsFor(controlDir)
  const terminal = [...store.values()].filter(run => ['completed', 'failed', 'cancelled'].includes(run.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const run of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_RUNS))) store.delete(run.id)
  const outbox = outboxFor(controlDir)
  const settled = [...outbox.values()].filter(item => item.state === 'sent' || item.state === 'failed').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const item of settled.slice(0, Math.max(0, settled.length - MAX_TERMINAL_OUTBOX))) {
    if (!deliveryWaiters.get(controlDir)?.has(item.id)) outbox.delete(item.id)
  }
}

export const newRunId = (): string => `r_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`

export class RunStore {
  constructor(private readonly controlDir: string) {}

  async create(input: {
    id?: string
    ownerId?: string
    ownerEpoch?: string
    telegramEpoch?: string
    chatId?: number
    telegramUserId?: number
    items?: IncomingItem[]
    texts: string[]
    messageId?: number
    execution?: ExecutionChoice
    scheduled?: ScheduledOrigin
    external?: ExternalOrigin
    taskId?: string
    application?: ApplicationOrigin
    delivery?: { bindingId: string; scope: string }
  }): Promise<RunRecord> {
    const store = runsFor(this.controlDir)
    if (input.id) {
      assertId(input.id)
      const existing = store.get(input.id)
      if (existing) {
        if (existing.ownerId !== input.ownerId || existing.ownerEpoch !== input.ownerEpoch || existing.chatId !== input.chatId || existing.telegramUserId !== input.telegramUserId)
          throw new Error('Run ownership mismatch')
        return existing
      }
    }
    const run: RunRecord = {
      version: input.taskId ? 2 : 1,
      taskId: input.taskId,
      id: input.id ?? newRunId(),
      ownerId: input.ownerId,
      ownerEpoch: input.ownerEpoch,
      telegramEpoch: input.telegramEpoch,
      chatId: input.chatId,
      telegramUserId: input.telegramUserId,
      messageId: input.messageId,
      texts: input.texts,
      items: input.items,
      execution: input.execution,
      external: input.external,
      application: input.application,
      delivery: input.delivery,
      scheduled: input.scheduled,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    store.set(run.id, run)
    pruneTerminals(this.controlDir)
    return run
  }

  async get(id: string): Promise<RunRecord | null> {
    assertId(id)
    return runsFor(this.controlDir).get(id) ?? null
  }

  async patch(
    id: string,
    change: Partial<Pick<RunRecord, 'status' | 'startedAt' | 'endedAt' | 'pid' | 'nativeSessionId' | 'interrupted' | 'blockReason' | 'backendSubmitted' | 'replyOnly' | 'exitCode' | 'failureReason' | 'failure' | 'failureReview' | 'externalReleased'>>,
  ): Promise<RunRecord> {
    const store = runsFor(this.controlDir)
    const run = store.get(id)
    if (!run) throw new Error(`Unknown run ${id}`)
    if (change.failureReview && (!validFailureReview(change.failureReview) || run.status !== 'failed' || change.failureReview.failedAt !== failureStamp(run))) throw new Error('Failure changed or review is invalid; inspect the run again')
    const failure = change.status === 'failed' && !change.failure
      ? await failureEvidence(this.controlDir, change.failureReason || (change.interrupted ? 'Execution interrupted by relay restart; inspect effects before recovery' : 'No error detail recorded'))
      : undefined
    const next = { ...run, ...(failure ? { failure } : {}), ...change }
    store.set(id, next)
    pruneTerminals(this.controlDir)
    return next
  }

  async attachTelegramApplication(id: string, application: ApplicationOrigin): Promise<RunRecord> {
    const store = runsFor(this.controlDir)
    const run = store.get(id)
    if (!run) throw new Error(`Unknown run ${id}`)
    if (run.application || run.telegramApplication || run.taskId || run.external || run.scheduled || run.replyOnly || run.telegramUserId === undefined)
      throw new Error('Run is not an unadmitted Telegram run')
    if (run.status !== 'queued' && run.status !== 'running')
      throw new Error('Run already finished; application admission conflicts with its terminal state')
    if (!validApplicationOrigin(application)) throw new Error('Invalid application context')
    const next = { ...run, telegramApplication: application }
    store.set(id, next)
    return next
  }

  async list(): Promise<RunRecord[]> {
    return [...runsFor(this.controlDir).values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async pruneTaskHistory(taskId:string,keep=100):Promise<void>{
    const terminal=[...runsFor(this.controlDir).values()].filter(run=>run.taskId===taskId&&['completed','failed','cancelled'].includes(run.status)&&(run.external===undefined||run.externalReleased===true)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
    const store = runsFor(this.controlDir)
    for(const run of terminal.slice(0,Math.max(0,terminal.length-keep)))store.delete(run.id)
  }

  async running(background?: boolean): Promise<RunRecord | undefined> {
    let first: RunRecord | undefined
    for (const run of [...runsFor(this.controlDir).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))) {
      if (run.status === 'running' && (background === undefined || Boolean(run.scheduled) === background)) {
        first ??= run
      }
    }
    return first
  }

  async nextQueued(background?: boolean): Promise<RunRecord | undefined> {
    const queued = [...runsFor(this.controlDir).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).filter((run) => run.status === 'queued' && (background === undefined || Boolean(run.scheduled) === background))
    return queued.find(run => !run.taskId) ?? queued[0]
  }

  async deliveryStatus(): Promise<{ failed: number; unknown: number }> {
    let failed = 0, unknown = 0
    for (const item of outboxFor(this.controlDir).values()) {
      // A claimed but unsettled send is awaiting confirmation, exactly like a
      // failed send with an unknown outcome.
      if (item.state === 'sending') unknown++
      else if (item.state === 'failed' && item.deliveryUnknown) unknown++
      else if (item.state === 'failed') failed++
    }
    return { failed, unknown }
  }

  private writeOutboxItem(item: OutboxItem): OutboxItem {
    const stored: StoredOutboxItem = { ...item, state: 'queued' }
    outboxFor(this.controlDir).set(item.id, stored)
    notifyDelivery(this.controlDir, item.id)
    return item
  }

  async enqueueOwnerDelivery(context: DeliveryContext, payload: {type:'message'|'document'|'voice';text?:string;documentPath?:string;voiceText?:string;replyToMessageId?:number}): Promise<OutboxItem> {
    const authorized=authorizeDeliveryContext(context,await currentDeliveryOwner(this.controlDir))
    const item:OutboxItem={...payload,id:`delivery_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`,deliveryContext:authorized,chatId:authorized.owner.telegramChatId,createdAt:new Date().toISOString()}
    return this.writeOutboxItem(item)
  }

  async ownerDeliveryReceipt(context:DeliveryContext,id:string) {
    assertId(id)
    const owner=await currentDeliveryOwner(this.controlDir)
    authorizeDeliveryContext(context,owner)
    const item = outboxFor(this.controlDir).get(id)
    if (!item) throw new Error('Unknown owner delivery receipt')
    authorizeDeliveryContext(item.deliveryContext,owner)
    if(item.runId||item.chatId!==owner!.telegramChatId)throw new Error('Outbox ownership mismatch')
    const status = item.state === 'sent' ? 'delivered' : item.state === 'failed' ? 'failed' : item.state === 'sending' ? 'sending' : 'queued'
    return {outbox_id:id,status:item.deliveryUnknown?'unknown':status,...(item.receipt?{receipt:item.receipt}:{}),...(item.deliveryError?{error:item.deliveryError}:{})}
  }

  async enqueueMessage(
    runId: string,
    text: string,
    options?: { replyToMessageId?: number; id?: string },
  ): Promise<OutboxItem> {
    const run = runsFor(this.controlDir).get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Run ${runId} cannot send`)
    if (options?.id) {
      assertId(options.id)
      const existing = outboxFor(this.controlDir).get(options.id)
      if (existing) return existing
    }
    const item: OutboxItem = {
      id: options?.id ?? `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
      runId,
      chatId: run.chatId,
      type: 'message',
      text,
      replyToMessageId: options?.replyToMessageId,
      createdAt: new Date().toISOString(),
    }
    return this.writeOutboxItem(item)
  }

  async enqueueDocument(
    runId: string,
    documentPath: string,
    options?: { caption?: string; replyToMessageId?: number },
  ): Promise<OutboxItem> {
    const run = runsFor(this.controlDir).get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Run ${runId} cannot send`)
    const item: OutboxItem = {
      id: `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
      runId,
      chatId: run.chatId,
      type: 'document',
      documentPath,
      text: options?.caption,
      replyToMessageId: options?.replyToMessageId,
      createdAt: new Date().toISOString(),
    }
    return this.writeOutboxItem(item)
  }

  async enqueueVoice(
    runId: string,
    voiceText: string,
    options?: { replyToMessageId?: number },
  ): Promise<OutboxItem> {
    const run = runsFor(this.controlDir).get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Run ${runId} cannot send`)
    const item: OutboxItem = {
      id: `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
      runId,
      chatId: run.chatId,
      type: 'voice',
      voiceText,
      replyToMessageId: options?.replyToMessageId,
      createdAt: new Date().toISOString(),
    }
    return this.writeOutboxItem(item)
  }

  async enqueueApproval(
    runId: string,
    prompt: string,
    actionId: string,
    options?: { replyToMessageId?: number },
  ): Promise<OutboxItem> {
    const run = runsFor(this.controlDir).get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued')
      throw new Error(`Run ${runId} cannot request approval`)
    const item: OutboxItem = {
      id: `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
      runId,
      chatId: run.chatId,
      type: 'approval',
      approvalPrompt: prompt,
      approvalActionId: actionId,
      replyToMessageId: options?.replyToMessageId,
      createdAt: new Date().toISOString(),
    }
    return this.writeOutboxItem(item)
  }

  async enqueueReaction(runId: string, rawEmoji: string): Promise<OutboxItem> {
    const run = runsFor(this.controlDir).get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Run ${runId} cannot react`)
    if (!run.messageId) throw new Error(`Run ${runId} has no messageId to react to`)
    const emoji = normalizeReactionEmoji(rawEmoji)
    if (!emoji) {
      throw new Error(`Invalid Telegram reaction emoji "${rawEmoji}"`)
    }
    const item: OutboxItem = {
      id: `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
      runId,
      chatId: run.chatId,
      type: 'reaction',
      emoji,
      messageId: run.messageId,
      createdAt: new Date().toISOString(),
    }
    return this.writeOutboxItem(item)
  }

  async pendingOutbox(): Promise<OutboxItem[]> {
    return [...outboxFor(this.controlDir).values()].filter(item => item.state === 'queued').sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async applicationMessages(runId: string): Promise<{ id: string; text: string }[]> {
    assertId(runId)
    return [...outboxFor(this.controlDir).values()].filter(item => item.runId === runId && (!item.type || item.type === 'message') && typeof item.text === 'string' && item.state !== 'failed').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(item => ({ id: item.id, text: item.text! }))
  }

  async applicationApprovals(runId:string):Promise<{id:string;prompt:string;state:string}[]> {
    assertId(runId)
    return [...outboxFor(this.controlDir).values()].filter(item=>item.runId===runId&&item.type==='approval'&&item.approvalActionId&&item.approvalPrompt&&item.state!=='failed').map(item=>({id:item.approvalActionId!,prompt:item.approvalPrompt!,state:item.state==='sent'?'delivered':'pending'}))
  }

  async claimOutbox(id: string): Promise<boolean> {
    assertId(id)
    const item = outboxFor(this.controlDir).get(id)
    if (!item || item.state !== 'queued') return false
    outboxFor(this.controlDir).set(id, { ...item, state: 'sending' })
    return true
  }

  // Resolves when the relay pump settles the item. Same contract as the
  // former file poll: delivered receipt, failed error, or unknown on timeout.
  async waitForDelivery(id: string, timeoutMs = 120_000): Promise<unknown> {
    assertId(id)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const item = outboxFor(this.controlDir).get(id)
      if (item && (item.state === 'sent' || item.state === 'failed')) {
        if (item.state === 'failed' && item.deliveryUnknown)
          throw new Error(`Delivery outcome unknown; inspect before retrying: ${item.deliveryError || id}`)
        if (item.state === 'failed')
          throw new Error(item.deliveryError || 'Delivery failed; inspect the local outbox')
        return item.receipt ?? { delivered: true }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Delivery outcome unknown for ${id}; inspect the outbox before retrying`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waitersFor(this.controlDir).get(id)?.delete(wrapped)
          resolve()
        }, remaining)
        const wrapped = () => { clearTimeout(timer); resolve() }
        let set = waitersFor(this.controlDir).get(id)
        if (!set) { set = new Set(); waitersFor(this.controlDir).set(id, set) }
        set.add(wrapped)
      })
    }
  }

  async failOutbox(id: string, reason = 'Delivery failed', deliveryUnknown = false): Promise<void> {
    assertId(id)
    const item = outboxFor(this.controlDir).get(id)
    if (!item) return
    const next = { ...item, state: 'failed' as const, deliveryError: reason, deliveryUnknown }
    outboxFor(this.controlDir).set(id, next)
    notifyDelivery(this.controlDir, id)
    pruneTerminals(this.controlDir)
  }

  async unclaimOutbox(id: string): Promise<void> {
    assertId(id)
    const item = outboxFor(this.controlDir).get(id)
    if (item && item.state === 'sending') outboxFor(this.controlDir).set(id, { ...item, state: 'queued' })
  }

  async markOutboxSent(id: string, messageIds: number[] = []): Promise<void> {
    assertId(id)
    const item = outboxFor(this.controlDir).get(id)
    if (!item) return
    const next = { ...item, state: 'sent' as const, ...(messageIds.length ? { receipt: { messageIds, deliveredAt: new Date().toISOString() } } : {}) }
    outboxFor(this.controlDir).set(id, next)
    notifyDelivery(this.controlDir, id)
    pruneTerminals(this.controlDir)
  }
}
