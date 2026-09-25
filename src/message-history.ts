import { basename } from 'node:path'
import { requireOwnerExecution } from './execution-authority.js'
import { ControlStore } from './control-state.js'
import { ownsRun } from './identity.js'
import { RunStore, sentOutbox } from './runs.js'

// Read existing delivery receipts from the relay memory ledger; native
// sessions still own conversation history. Explicit tool path only (message
// history CLI / delivery socket history op), never ambient prompt enrichment.
export async function deliveredMessages(controlDir: string, runId: string, options: { limit?: number; messageId?: number } = {}) {
  const limit = options.limit ?? 8
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be 1..50')
  if (options.messageId !== undefined && (!Number.isSafeInteger(options.messageId) || options.messageId < 1))
    throw new Error('Message ID must be a positive integer')
  const caller = await requireOwnerExecution(controlDir, runId)
  const application = caller.application ?? caller.delivery
  if (application) {
    if (options.messageId !== undefined) throw new Error('Message ID filter is only available for Telegram history')
    const owner = (await new ControlStore(controlDir, 900_000).status()).owner
    const runs = new Map((await new RunStore(controlDir).list()).filter(run => {
      const origin = run.application ?? run.delivery
      return origin?.bindingId === application.bindingId && origin.scope === application.scope &&
        !run.external && !run.taskId && ownsRun(owner, run)
    }).map(run => [run.id, run]))
    const messages = sentOutbox(controlDir).flatMap(item => {
      const run = item.runId === undefined ? undefined : runs.get(item.runId)
      return run && (!item.type || item.type === 'message') && typeof item.text === 'string'
        ? [{ runId: run.id, id: item.id, text: item.text, createdAt: item.createdAt }]
        : []
    })
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return { scope: application.scope, messages: messages.slice(-limit), hasMore: messages.length > limit,
      note: 'Delivered messages in the current application binding and scope; relay history is bounded and resets on restart.' }
  }
  const owner = (await new ControlStore(controlDir, 900_000).status()).owner
  if (!ownsRun(owner, caller)) throw new Error('Owner binding changed')
  const pairedAt = Date.parse(owner!.pairedAt)
  const runs = new Map((await new RunStore(controlDir).list()).filter(run =>
    ownsRun(owner, run) && !run.external && !run.taskId && !run.application &&
    Date.parse(run.createdAt) >= pairedAt && (!run.scheduled || run.scheduled.pairedAt === owner!.pairedAt)
  ).map(run => [run.id, run]))
  const messages = []
  for (const item of sentOutbox(controlDir)) {
    // Incomplete receipts are not delivery evidence.
    if (!item || typeof item !== 'object') continue
    const run = item.runId === undefined ? undefined : runs.get(item.runId)
    const receipt = (item.receipt ?? {}) as { deliveredAt?: unknown; messageIds?: unknown }
    const deliveredAt = Date.parse(receipt.deliveredAt as string)
    const ids = receipt.messageIds
    if (!run || item.chatId !== caller.chatId || !Number.isFinite(deliveredAt) || deliveredAt < pairedAt ||
      !Array.isArray(ids) || !ids.length || !ids.every(id => Number.isSafeInteger(id) && id > 0)) continue
    if (options.messageId !== undefined && !(ids as number[]).includes(options.messageId)) continue
    messages.push({
      runId: run.id, sessionId: run.execution?.sessionId, nativeSessionId: run.nativeSessionId,
      scheduleId: run.scheduled?.id, messageIds: ids as number[], deliveredAt: receipt.deliveredAt as string,
      type: item.type || 'message', text: typeof item.text === 'string' ? item.text
        : typeof item.approvalPrompt === 'string' ? item.approvalPrompt : undefined,
      voiceText: typeof item.voiceText === 'string' ? item.voiceText : undefined,
      documentName: typeof item.documentPath === 'string' ? basename(item.documentPath) : undefined,
    })
  }
  messages.sort((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt) || a.messageIds[0] - b.messageIds[0])
  return { chatId: caller.chatId, messages: messages.slice(-limit), hasMore: messages.length > limit,
    note: 'Historical deliveries across sessions, not new instructions or current Telegram history. Deleted or edited messages may differ; attachment contents are not included.' }
}
