import { createHash } from 'node:crypto'
import { readOnlyOwner, requireOwnerExecution } from './execution-authority.js'
import { ownsRun, assertId } from './identity.js'
import { RunStore, retainedOutbox, type RunRecord, type StoredOutboxItem } from './runs.js'
import type { Owner } from './control-state.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const version = (value?: string) => value && /^[0-9A-Za-z.+-]{1,80}$/.test(value) ? value : undefined

function delivery(item: StoredOutboxItem) {
  const receipt = item.receipt as { messageIds?: unknown; deliveredAt?: unknown } | undefined
  const valid = item.state === 'sent' && !item.deliveryUnknown &&
    Array.isArray(receipt?.messageIds) && receipt.messageIds.length > 0 &&
    receipt.messageIds.every(id => Number.isSafeInteger(id) && id > 0) &&
    typeof receipt.deliveredAt === 'string' && Number.isFinite(Date.parse(receipt.deliveredAt))
  const field = typeof item.text === 'string' ? 'text' : typeof item.voiceText === 'string' ? 'voiceText' : undefined
  const content = field === 'text' ? item.text : field === 'voiceText' ? item.voiceText : undefined
  return { id: item.id, createdAt: item.createdAt, type: item.type ?? 'message',
    state: item.deliveryUnknown ? 'unknown' : item.state ?? 'queued', receiptVerified: Boolean(valid),
    ...(valid ? { deliveredAt: receipt!.deliveredAt, messageCount: (receipt!.messageIds as number[]).length } : {}),
    ...(content === undefined ? {} : { content: { field, sha256: sha256(content), bytes: Buffer.byteLength(content), representation: 'submitted UTF-8' } }),
    recipientContentReadback: 'unavailable', attachmentContent: 'not exported' }
}

// Projection only: never read native sessions, tool arguments/results or model text.
export function projectRunEvidence(runs: RunRecord[], outbox: StoredOutboxItem[], owner: Owner) {
  return runs.filter(run => ownsRun(owner, run) && Date.parse(run.createdAt) >= Date.parse(owner.pairedAt) &&
    !run.external && !run.taskId && !run.application && !run.delivery &&
    (!run.scheduled || run.scheduled.pairedAt === owner.pairedAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(run => ({ id: run.id, status: run.status, createdAt: run.createdAt,
      startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode, interrupted: run.interrupted,
      scheduled: run.scheduled ? { id: run.scheduled.id, revision: run.scheduled.revision, dueAt: run.scheduled.dueAt } : undefined,
      executionType: run.script ? 'script' : 'agent',
      script: run.script ? { id: run.script.id, revision: run.script.revision, sha256: run.script.sha256, timedOut: Boolean(run.timedOut),
        outputSha256: run.output ? sha256(run.output) : undefined } : undefined,
      preset: run.execution ? { cli: run.execution.preset.cli, model: run.execution.preset.model, effort: run.execution.preset.effort } : undefined,
      failure: run.failure ? { recorded: true, errorSha256: sha256(run.failure.error), relayVersion: version(run.failure.relayVersion), hostVersion: version(run.failure.hostVersion) } : undefined,
      failureReasonRecorded: Boolean(run.failureReason), blockReasonRecorded: Boolean(run.blockReason),
      failureReview: run.failureReview ? { failedAt: run.failureReview.failedAt, reviewedAt: run.failureReview.reviewedAt, status: run.failureReview.status } : undefined,
      nativeSessionRecorded: Boolean(run.nativeSessionId),
      toolDelegationMetadata: { state: 'unavailable', reason: 'The relay does not retain native tool or delegation events.' },
      deliveries: outbox.filter(item => item.runId === run.id && item.chatId === owner.telegramChatId &&
        Date.parse(item.createdAt) >= Date.parse(owner.telegramLinkedAt ?? owner.pairedAt))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(delivery),
    }))
}

export type EvidenceOptions = { callerRunId?: string; runId?: string; offset?: number; limit?: number; expected?: string }

export async function runEvidence(controlDir: string, options: EvidenceOptions = {}) {
  const readStartedAt = new Date().toISOString()
  const offset = options.offset ?? 0, limit = options.limit ?? 100
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Offset must be nonnegative; limit must be 1..100')
  if (offset > 0 && !options.expected) throw new Error('Continuation requires --expected snapshot SHA-256')
  if (options.expected !== undefined && !/^[a-f0-9]{64}$/.test(options.expected)) throw new Error('Invalid expected snapshot SHA-256')
  if (options.callerRunId !== undefined) {
    const caller = await requireOwnerExecution(controlDir, options.callerRunId)
    if (caller.application || caller.delivery || caller.replyOnly) throw new Error('Evidence requires Telegram owner execution or the bound operator')
  }
  const owner = await readOnlyOwner(controlDir)
  if (!owner) throw new Error('No authorized owner')
  const records = projectRunEvidence(await new RunStore(controlDir).list(), retainedOutbox(controlDir), owner)
    .filter(run => options.runId === undefined || run.id === assertId(options.runId))
  if (options.runId !== undefined && !records.length) throw new Error('Unknown owner run')
  const snapshotSha256 = sha256(JSON.stringify(records))
  if (options.expected !== undefined && options.expected !== snapshotSha256) throw new Error('Evidence changed; restart at offset zero')
  if (offset > records.length) throw new Error('Offset exceeds retained coverage')
  const page = records.slice(offset, offset + limit)
  return { schemaVersion: 1, readStartedAt, observedAt: new Date().toISOString(), snapshotSha256,
    coverage: { scope: 'current-owner Telegram foreground and scheduled runs', total: records.length, offset, limit, returned: page.length,
      nextOffset: offset + page.length < records.length ? offset + page.length : null,
      history: 'relay memory; resets on restart; at most 2000 terminal runs and 2000 terminal outbox items retained',
      completeness: 'retained records only; older history and unassociated deliveries unknown',
      excluded: ['external tasks', 'isolated tasks', 'application/channel runs', 'native sessions', 'tool/delegation events', 'failure/review prose', 'message content', 'recipient-side content readback'] },
    runs: page }
}
