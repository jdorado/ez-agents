import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { validOrigin, type ExternalOrigin } from './event-sources.js'
import { normalizeReactionEmoji } from './reaction.js'
import { assertId } from './identity.js'
import { isExecutionChoice, type ExecutionChoice } from './ai.js'

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type RunRecord = {
  version: 1
  id: string
  chatId: number
  telegramUserId: number
  messageId?: number
  texts: string[]
  status: RunStatus
  createdAt: string
  startedAt?: string
  endedAt?: string
  pid?: number
  blockReason?: string
  execution?: ExecutionChoice
  external?: ExternalOrigin
}

export type OutboxItemType = 'message' | 'reaction' | 'document' | 'voice' | 'approval'

export type OutboxItem = {
  id: string
  runId: string
  chatId: number
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

const isRun = (value: unknown): value is RunRecord => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RunRecord>
  return (
    candidate.version === 1 &&
    typeof candidate.id === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(candidate.id) &&
    Number.isSafeInteger(candidate.chatId) &&
    Number.isSafeInteger(candidate.telegramUserId) &&
    Array.isArray(candidate.texts) &&
    candidate.texts.every((text) => typeof text === 'string') &&
    ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(candidate.status ?? '') &&
    typeof candidate.createdAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    (candidate.pid === undefined || (Number.isSafeInteger(candidate.pid) && candidate.pid > 0)) &&
    (candidate.blockReason === undefined || ['owner-mismatch', 'external-execution-unavailable'].includes(candidate.blockReason)) &&
    (candidate.external === undefined || validOrigin(candidate.external)) &&
    (candidate.execution === undefined || isExecutionChoice(candidate.execution))
  )
}

export const newRunId = (): string => `r_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class RunStore {
  private readonly runsDir: string
  private readonly outboxDir: string

  constructor(controlDir: string) {
    this.runsDir = path.join(controlDir, 'runs')
    this.outboxDir = path.join(controlDir, 'outbox')
  }

  private async ensure(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 })
    await mkdir(this.outboxDir, { recursive: true, mode: 0o700 })
  }

  private runPath(id: string): string {
    return path.join(this.runsDir, `${assertId(id)}.json`)
  }

  private async writeRun(run: RunRecord): Promise<void> {
    await this.ensure()
    const temporary = `${this.runPath(run.id)}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.runPath(run.id))
  }

  async create(input: {
    id?: string
    chatId: number
    telegramUserId: number
    texts: string[]
    messageId?: number
    execution?: ExecutionChoice
    external?: ExternalOrigin
  }): Promise<RunRecord> {
    if (input.id) {
      const existing = await this.get(input.id)
      if (existing) {
        if (existing.chatId !== input.chatId || existing.telegramUserId !== input.telegramUserId)
          throw new Error('Run ownership mismatch')
        return existing
      }
    }
    const run: RunRecord = {
      version: 1,
      id: input.id ?? newRunId(),
      chatId: input.chatId,
      telegramUserId: input.telegramUserId,
      messageId: input.messageId,
      texts: input.texts,
      execution: input.execution,
      external: input.external,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    await this.writeRun(run)
    return run
  }

  async get(id: string): Promise<RunRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.runPath(id), 'utf8'))
      if (!isRun(parsed) || parsed.id !== id) throw new Error('Run record has an unsupported shape')
      return parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async patch(
    id: string,
    change: Partial<Pick<RunRecord, 'status' | 'startedAt' | 'endedAt' | 'pid' | 'blockReason'>>,
  ): Promise<RunRecord> {
    const run = await this.get(id)
    if (!run) throw new Error(`Unknown run ${id}`)
    const next = { ...run, ...change }
    await this.writeRun(next)
    return next
  }

  async list(): Promise<RunRecord[]> {
    await this.ensure()
    const names = await readdir(this.runsDir)
    const runs: RunRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.includes('.tmp')) continue
      try {
        const run = await this.get(name.slice(0, -5))
        if (run) runs.push(run)
      } catch {
        console.error('Unreadable run record', name)
      }
    }
    return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async running(): Promise<RunRecord | undefined> {
    const runs = await this.list()
    for (const run of runs) {
      if (run.status === 'running') {
        if (run.pid && !isPidAlive(run.pid)) {
          await this.patch(run.id, { status: 'failed', endedAt: new Date().toISOString() })
          continue
        }
        return run
      }
    }
    return undefined
  }

  async nextQueued(): Promise<RunRecord | undefined> {
    return (await this.list()).find((run) => run.status === 'queued')
  }

  async deliveryStatus(): Promise<{ failed: number; unknown: number }> {
    await this.ensure()
    const names = await readdir(this.outboxDir)
    const result = { failed: 0, unknown: names.filter((name) => name.endsWith('.sending.json')).length }
    for (const name of names.filter((name) => name.endsWith('.failed.json'))) {
      try {
        const item = JSON.parse(await readFile(path.join(this.outboxDir, name), 'utf8'))
        if (item.deliveryUnknown) result.unknown++
        else result.failed++
      } catch {
        result.unknown++
      }
    }
    return result
  }

  private async writeOutboxItem(item: OutboxItem): Promise<OutboxItem> {
    await this.ensure()
    const file = path.join(this.outboxDir, `${item.id}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
    return item
  }

  async enqueueMessage(
    runId: string,
    text: string,
    options?: { replyToMessageId?: number },
  ): Promise<OutboxItem> {
    const run = await this.get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Run ${runId} cannot send`)
    const item: OutboxItem = {
      id: `${runId}_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`,
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
    const run = await this.get(runId)
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
    const run = await this.get(runId)
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
    const run = await this.get(runId)
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
    const run = await this.get(runId)
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
    await this.ensure()
    const names = (await readdir(this.outboxDir)).filter(
      (name) =>
        name.endsWith('.json') &&
        !name.endsWith('.sent.json') &&
        !name.endsWith('.failed.json') &&
        !name.endsWith('.sending.json') &&
        !name.includes('.tmp'),
    )
    const items: OutboxItem[] = []
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(this.outboxDir, name), 'utf8'))
        if (
          parsed &&
          typeof parsed === 'object' &&
          ('text' in parsed ||
            'emoji' in parsed ||
            'documentPath' in parsed ||
            'voiceText' in parsed ||
            'approvalPrompt' in parsed ||
            'type' in parsed)
        ) {
          items.push(parsed as OutboxItem)
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.error('Unreadable outbox record', name)
      }
    }
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async claimOutbox(id: string): Promise<boolean> {
    assertId(id)
    const from = path.join(this.outboxDir, `${id}.json`)
    const to = path.join(this.outboxDir, `${id}.sending.json`)
    try {
      await rename(from, to)
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async waitForDelivery(id: string, timeoutMs = 120_000): Promise<unknown> {
    assertId(id)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const status of ['sent', 'failed'] as const) {
        let item
        try {
          item = JSON.parse(await readFile(path.join(this.outboxDir, `${id}.${status}.json`), 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        if (status === 'failed' && item.deliveryUnknown)
          throw new Error(`Delivery outcome unknown; inspect before retrying: ${item.deliveryError || id}`)
        if (status === 'failed')
          throw new Error(item.deliveryError || 'Delivery failed; inspect the local outbox')
        return item.receipt ?? { delivered: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Delivery outcome unknown for ${id}; inspect the outbox before retrying`)
  }

  async failOutbox(id: string, reason = 'Delivery failed', deliveryUnknown = false): Promise<void> {
    assertId(id)
    const source = path.join(this.outboxDir, `${id}.sending.json`)
    const item = JSON.parse(await readFile(source, 'utf8'))
    const temporary = `${source}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ ...item, deliveryError: reason, deliveryUnknown }), {
      mode: 0o600,
    })
    await rename(temporary, source)
    await rename(
      path.join(this.outboxDir, `${id}.sending.json`),
      path.join(this.outboxDir, `${id}.failed.json`),
    )
  }

  async unclaimOutbox(id: string): Promise<void> {
    assertId(id)
    const from = path.join(this.outboxDir, `${id}.sending.json`)
    const to = path.join(this.outboxDir, `${id}.json`)
    try {
      await rename(from, to)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async markOutboxSent(id: string, messageIds: number[] = []): Promise<void> {
    assertId(id)
    const sendingFile = path.join(this.outboxDir, `${id}.sending.json`)
    const normalFile = path.join(this.outboxDir, `${id}.json`)
    const target = path.join(this.outboxDir, `${id}.sent.json`)
    if (messageIds.length) {
      const record = JSON.parse(await readFile(sendingFile, 'utf8'))
      const temporary = `${sendingFile}.${process.pid}.tmp`
      await writeFile(
        temporary,
        JSON.stringify({ ...record, receipt: { messageIds, deliveredAt: new Date().toISOString() } }),
        { mode: 0o600 },
      )
      await rename(temporary, sendingFile)
    }
    try {
      await rename(sendingFile, target)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await rename(normalFile, target)
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      } else {
        throw err
      }
    }
  }
}
