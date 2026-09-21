import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { callDeliverySocket as callSocket, deliverySocketAlive as socketAlive, deliverySocketPath } from './delivery-socket-client.mjs'
import { RunStore, sentOutbox, type RunRecord } from './runs.js'
import { ApprovalStore } from './approval.js'
import { deliveredMessages } from './message-history.js'
import { readOnlyOwner, requireOwnerExecution } from './execution-authority.js'
import { telegramOwner } from './control-state.js'

// Stateless pipe transport. The relay owns the runs/outbox ledger in process
// memory; engine children, plugin children and the host executor reach it
// through this socket instead of control/ files. The socket lives on the
// shared control volume so container-colocated and host-side children use the
// same path. Binding it also guards single-relay ownership (replacing the old
// relay.lock flock): a second relay finds the address live and exits.
//
// Frames are newline-delimited JSON: {id, op, payload} -> {id, ok, result?,
// error?}. Every op re-verifies ownership server-side; request metadata is
// never trusted. A restart drops the ledger by design: in-flight sends report
// unknown rather than claiming success. The transport itself lives in
// delivery-socket-client.mjs so plain-Node tools share one implementation.

export { deliverySocketPath }

export type DeliverySocketOp =
  | { op: 'ping' }
  | { op: 'status' }
  | { op: 'enqueue'; payload: Record<string, unknown> }
  | { op: 'wait'; payload: { id: string; timeoutMs?: number } }
  | { op: 'get'; payload: { runId: string } }
  | { op: 'list'; payload?: Record<string, never> }
  | { op: 'patch'; payload: { runId: string; change: Record<string, unknown> } }
  | { op: 'authorize'; payload: { runId: string } }
  | { op: 'receipt'; payload: { context: unknown; id: string } }
  | { op: 'history'; payload: { runId: string; limit?: number; messageId?: number } }
  | { op: 'deliveryStatus'; payload?: Record<string, never> }
  | { op: 'approvalCheck'; payload: { actionId: string } }
  | { op: 'latestReply'; payload?: Record<string, never> }

export type DeliveryHandler = (op: DeliverySocketOp) => Promise<unknown>

// Socket-first run reads for library modules that execute both inside the
// relay (shared memory) and in sibling processes (host executor,
// task executor). A relay answering on the shared-volume socket is
// authoritative; connect-level failures fall back to direct memory, which is
// empty in a fresh sibling process and therefore fails closed. Post-connect
// errors (unknown run, revoked owner) always propagate.
const connectFailure = (error: unknown): boolean =>
  error instanceof Error && (/Delivery relay unavailable/.test(error.message) || /ECONNREFUSED|ENOENT/.test(error.message))

export const readRun = async (controlDir: string, runId: string): Promise<RunRecord | null> => {
  try {
    const run = await callDeliverySocket(socketPathFor(controlDir), { op: 'get', payload: { runId } }, 10_000)
    return run as RunRecord
  } catch (error) {
    if (!connectFailure(error)) throw error
    if (error instanceof Error && /Unknown run/.test(error.message)) return null
    return new RunStore(controlDir).get(runId)
  }
}

export const authorizeRun = async (controlDir: string, runId: string): Promise<RunRecord> => {
  try {
    const run = await callDeliverySocket(socketPathFor(controlDir), { op: 'authorize', payload: { runId } }, 10_000)
    return run as RunRecord
  } catch (error) {
    if (!connectFailure(error)) throw error
    return requireOwnerExecution(controlDir, runId)
  }
}

const encode = (value: unknown): string => `${JSON.stringify(value)}\n`

export const serveDeliverySocket = async (
  controlDir: string,
  handle: DeliveryHandler,
): Promise<{ socketPath: string; stop: () => Promise<void> }> => {
  const socketPath = deliverySocketPath(controlDir)
  await rm(socketPath, { force: true }).catch(() => {})
  const server: Server = createServer((socket: Socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        void (async () => {
          let id: unknown = null
          try {
            const request = JSON.parse(line) as { id?: unknown; op?: unknown; payload?: unknown }
            id = request.id ?? null
            const result = await handle(request as DeliverySocketOp)
            socket.write(encode({ id, ok: true, result: result ?? null }))
          } catch (error) {
            socket.write(encode({ id, ok: false, error: error instanceof Error ? error.message : String(error ?? 'Unknown error') }))
          }
        })()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  // A live sibling relay already owns this agent. Refuse to split-brain.
  server.on('error', () => {})
  return {
    socketPath,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true }).catch(() => {})
    },
  }
}

// Children derive the rendezvous from the agent control directory they were
// given; EZ_DELIVERY_SOCKET overrides it (tests, custom layouts).
export const socketPathFor = (controlDir: string, env: NodeJS.ProcessEnv = process.env): string =>
  env.EZ_DELIVERY_SOCKET?.trim() || deliverySocketPath(controlDir)

export type LedgerHooks = {
  // Wake the relay outbox pump after an enqueue. Test fixtures pass a noop
  // when they drive delivery synchronously.
  wake: () => void
  // Live relay surface for the status op (polling, transport, version).
  status: () => Promise<{ polling: boolean; applicationOnly: boolean; telegramConfigured: boolean; version: string }> | { polling: boolean; applicationOnly: boolean; telegramConfigured: boolean; version: string }
}

// Memory-ledger request handler shared by the relay and by test fixtures.
// Every op re-verifies ownership server-side; request metadata is never
// trusted. Unknown IDs, invalid payloads and revoked bindings fail closed.
export const createLedgerHandler = (controlDir: string, hooks: LedgerHooks): DeliveryHandler => {
  const runs = new RunStore(controlDir)
  const approvals = new ApprovalStore(controlDir)
  const nonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0
  return async (op: DeliverySocketOp): Promise<unknown> => {
    switch (op.op) {
      case 'ping': return { ok: true }
      case 'status': {
        const all = await runs.list()
        return {
          ...(await hooks.status()),
          at: Date.now(),
          running: all.filter((run) => run.status === 'running').length,
          queued: all.filter((run) => run.status === 'queued').length,
        }
      }
      case 'enqueue': {
        const envelope = (op.payload ?? {}) as Record<string, unknown>
        if (envelope.kind === 'owner') {
          if (!envelope.deliveryContext || typeof envelope.deliveryContext !== 'object') throw new Error('Delivery context is required')
          const type = envelope.type
          if (type !== 'message' && type !== 'document' && type !== 'voice') throw new Error('Unsupported owner delivery type')
          const text = envelope.text
          if (type === 'message' && !nonEmptyString(text)) throw new Error('Message content is required')
          const item = await runs.enqueueOwnerDelivery(
            envelope.deliveryContext as never,
            {
              type,
              ...(nonEmptyString(text) ? { text: (text as string).trim() } : {}),
              ...(typeof envelope.documentPath === 'string' ? { documentPath: envelope.documentPath } : {}),
              ...(typeof envelope.voiceText === 'string' ? { voiceText: envelope.voiceText } : {}),
              ...(Number.isSafeInteger(envelope.replyToMessageId) ? { replyToMessageId: envelope.replyToMessageId as number } : {}),
            },
          )
          hooks.wake()
          return { outbox_id: item.id, id: item.id, type: item.type }
        }
        if (typeof envelope.runId !== 'string' || !envelope.runId) throw new Error('Run ID is required')
        const replyTo = Number.isSafeInteger(envelope.replyToMessageId) ? { replyToMessageId: envelope.replyToMessageId as number } : {}
        const id = typeof envelope.id === 'string' && envelope.id ? { id: envelope.id } : {}
        let item
        switch (envelope.kind) {
          case 'message': {
            if (!nonEmptyString(envelope.text)) throw new Error('Message content is required')
            item = await runs.enqueueMessage(envelope.runId, (envelope.text as string).trim(), { ...replyTo, ...id })
            break
          }
          case 'document': {
            if (typeof envelope.documentPath !== 'string' || !envelope.documentPath) throw new Error('Document path is required')
            const caption = nonEmptyString(envelope.text) ? (envelope.text as string).trim() : undefined
            item = await runs.enqueueDocument(envelope.runId, envelope.documentPath, { ...(caption ? { caption } : {}), ...replyTo })
            break
          }
          case 'voice': {
            if (!nonEmptyString(envelope.voiceText)) throw new Error('Voice text is required')
            item = await runs.enqueueVoice(envelope.runId, (envelope.voiceText as string).trim(), replyTo)
            break
          }
          case 'reaction': {
            if (!nonEmptyString(envelope.emoji)) throw new Error('Reaction emoji is required')
            item = await runs.enqueueReaction(envelope.runId, envelope.emoji as string)
            break
          }
          case 'approval': {
            if (!nonEmptyString(envelope.approvalPrompt) || !nonEmptyString(envelope.approvalActionId))
              throw new Error('Approval prompt and action ID are required')
            await approvals.requestApproval(envelope.approvalActionId as string, (envelope.approvalPrompt as string).trim(), envelope.runId)
            item = await runs.enqueueApproval(envelope.runId, (envelope.approvalPrompt as string).trim(), envelope.approvalActionId as string, replyTo)
            break
          }
          default: throw new Error('Unsupported delivery kind')
        }
        hooks.wake()
        return { outbox_id: item.id, id: item.id, type: item.type }
      }
      case 'wait': {
        const { id, timeoutMs } = (op.payload ?? {}) as { id?: unknown; timeoutMs?: unknown }
        if (typeof id !== 'string' || !id) throw new Error('Outbox ID is required')
        const receipt = await runs.waitForDelivery(id, typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, 130_000) : 120_000)
        return { status: 'delivered', receipt }
      }
      case 'get': {
        const runId = (op.payload as { runId?: unknown } | undefined)?.runId
        if (typeof runId !== 'string' || !runId) throw new Error('Run ID is required')
        const run = await runs.get(runId)
        if (!run) throw new Error(`Unknown run ${runId}`)
        return run
      }
      case 'list': return runs.list()
      case 'patch': {
        const payload = (op.payload ?? {}) as { runId?: unknown; change?: unknown }
        if (typeof payload.runId !== 'string' || !payload.runId) throw new Error('Run ID is required')
        if (!payload.change || typeof payload.change !== 'object') throw new Error('Patch change is required')
        return runs.patch(payload.runId, payload.change as never)
      }
      case 'authorize': {
        const runId = (op.payload as { runId?: unknown } | undefined)?.runId
        if (typeof runId !== 'string' || !runId) throw new Error('Run ID is required')
        return requireOwnerExecution(controlDir, runId)
      }
      case 'receipt': {
        const payload = (op.payload ?? {}) as { context?: unknown; id?: unknown }
        if (!payload.context || typeof payload.context !== 'object') throw new Error('Delivery context is required')
        if (typeof payload.id !== 'string' || !payload.id) throw new Error('Outbox ID is required')
        return runs.ownerDeliveryReceipt(payload.context as never, payload.id)
      }
      case 'history': {
        const payload = (op.payload ?? {}) as { runId?: unknown; limit?: unknown; messageId?: unknown }
        if (typeof payload.runId !== 'string' || !payload.runId) throw new Error('Run ID is required')
        return deliveredMessages(controlDir, payload.runId, {
          ...(payload.limit === undefined ? {} : { limit: payload.limit as number }),
          ...(payload.messageId === undefined ? {} : { messageId: payload.messageId as number }),
        })
      }
      case 'deliveryStatus': return runs.deliveryStatus()
      case 'approvalCheck': {
        const actionId = (op.payload as { actionId?: unknown } | undefined)?.actionId
        if (typeof actionId !== 'string' || !actionId) throw new Error('Approval action ID is required')
        const record = await approvals.getDecision(actionId)
        return {
          ok: true,
          actionId,
          decision: record?.decision || 'pending',
          decidedAt: record?.decidedAt,
          decidedBy: record?.decidedBy,
        }
      }
      case 'latestReply': {
        const owner = telegramOwner(await readOnlyOwner(controlDir))
        if (!owner) return { reply: null }
        let reply: { runId: string; messageIds: number[]; deliveredAt: string } | null = null
        for (const item of sentOutbox(controlDir)) {
          if (!/^tg_\d+$/.test(item.runId || '') || item.chatId !== owner.telegramChatId ||
            (item.type && item.type !== 'message') || !Array.isArray((item.receipt as { messageIds?: unknown } | undefined)?.messageIds)) continue
          const receipt = item.receipt as { messageIds: number[]; deliveredAt: string }
          if (!receipt.messageIds.length || !receipt.messageIds.every((n) => Number.isSafeInteger(n) && n > 0)) continue
          const delivered = Date.parse(receipt.deliveredAt)
          if (!Number.isFinite(delivered) || delivered < Date.parse(owner.pairedAt) || delivered > Date.now()) continue
          const run = await runs.get(item.runId!)
          if (run?.status !== 'completed' || run.external || run.chatId !== owner.telegramChatId ||
            !Number.isSafeInteger(run.telegramUserId) || run.telegramUserId! <= 0 ||
            (owner.kind !== 'group' && run.telegramUserId !== owner.telegramUserId)) continue
          if (!reply || delivered > Date.parse(reply.deliveredAt))
            reply = { runId: item.runId!, messageIds: receipt.messageIds, deliveredAt: receipt.deliveredAt }
        }
        return { reply }
      }
      default: throw new Error(`Unsupported delivery op ${(op as { op?: unknown }).op}`)
    }
  }
}

export const deliverySocketAlive = (socketPath: string, timeoutMs = 2000): Promise<boolean> =>
  socketAlive(socketPath, timeoutMs)

// Typed facade over the shared plain-JS client so relay/TS callers keep the
// closed DeliverySocketOp union.
export const callDeliverySocket = (socketPath: string, op: DeliverySocketOp, timeoutMs = 130_000): Promise<unknown> =>
  callSocket(socketPath, op, timeoutMs)

