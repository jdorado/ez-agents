import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { requireOwnerExecution } from './execution-authority.js'
import { ControlStore } from './control-state.js'
import { ownsRun } from './identity.js'
import { RunStore } from './runs.js'

// Read existing delivery receipts; native sessions still own conversation history.
export async function deliveredMessages(controlDir: string, runId: string, options: { limit?: number; messageId?: number } = {}) {
  const limit = options.limit ?? 8
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be 1..50')
  if (options.messageId !== undefined && (!Number.isSafeInteger(options.messageId) || options.messageId < 1))
    throw new Error('Message ID must be a positive integer')
  const caller = await requireOwnerExecution(controlDir, runId)
  if (caller.application || caller.delivery) throw new Error('History requires a Telegram owner run')
  const owner = (await new ControlStore(controlDir, 900_000).status()).owner
  if (!ownsRun(owner, caller)) throw new Error('Owner binding changed')
  const pairedAt = Date.parse(owner!.pairedAt)
  const runs = new Map((await new RunStore(controlDir).list()).filter(run =>
    ownsRun(owner, run) && !run.external && !run.taskId && !run.application &&
    Date.parse(run.createdAt) >= pairedAt && (!run.scheduled || run.scheduled.pairedAt === owner!.pairedAt)
  ).map(run => [run.id, run]))
  const directory = join(controlDir, 'outbox')
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const messages = []
  for (const file of files.filter(file => file.endsWith('.sent.json'))) {
    // Corrupt or incomplete receipts are not delivery evidence.
    let item
    try { item = JSON.parse(await readFile(join(directory, file), 'utf8')) } catch { continue }
    if (!item || typeof item !== 'object') continue
    const run = runs.get(item.runId)
    const deliveredAt = Date.parse(item.receipt?.deliveredAt)
    const ids = item.receipt?.messageIds
    if (!run || item.chatId !== caller.chatId || !Number.isFinite(deliveredAt) || deliveredAt < pairedAt ||
      !Array.isArray(ids) || !ids.length || !ids.every(id => Number.isSafeInteger(id) && id > 0)) continue
    if (options.messageId !== undefined && !ids.includes(options.messageId)) continue
    messages.push({
      runId: run.id, sessionId: run.execution?.sessionId, nativeSessionId: run.nativeSessionId,
      scheduleId: run.scheduled?.id, messageIds: ids as number[], deliveredAt: item.receipt.deliveredAt as string,
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
