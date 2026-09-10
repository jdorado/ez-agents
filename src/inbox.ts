import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { isExecutionChoice, type ExecutionChoice } from './ai.js'
import { isOwner } from './identity.js'
import type { Owner } from './control-state.js'

export type IncomingItem = {
  text: string
  attachment?: { path: string; type: string }
  sentAt?: number
  caption?: string
  albumId?: string
  messageId?: number
  updateId: number
  chatId: number
  fromId: number
}

type Entry = { update: Update; receivedAt: number; execution?: ExecutionChoice }
export type InboxBatch = { id: string; entries: Entry[]; status: 'pending' | 'failed' | 'cancelled' }
type State = { version: 1; seen: number[]; waiting: Entry[]; batches: InboxBatch[] }

// One relay writer. Serialize read/modify/rename, including commands arriving during STT.
export class InboxStore {
  private lock: Promise<unknown> = Promise.resolve()
  private readonly file: string
  constructor(
    private readonly directory: string,
    private readonly now = Date.now,
  ) {
    this.file = join(directory, 'inbox.json')
  }

  private async read(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8')) as State
      const entry = (e: Entry) =>
        e && Number.isSafeInteger(e.update?.update_id) && Number.isFinite(e.receivedAt) &&
        (e.execution === undefined || isExecutionChoice(e.execution))
      if (
        state.version !== 1 ||
        !Array.isArray(state.seen) ||
        !state.seen.every(Number.isSafeInteger) ||
        !Array.isArray(state.waiting) ||
        !state.waiting.every(entry) ||
        !Array.isArray(state.batches) ||
        !state.batches.every(
          (b) =>
            /^tg_\d+$/.test(b.id) &&
            ['pending', 'failed', 'cancelled'].includes(b.status) &&
            Array.isArray(b.entries) &&
            b.entries.length > 0 &&
            b.entries.every(entry),
        )
      )
        throw new Error('Invalid inbox shape')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, seen: [], waiting: [], batches: [] }
      throw new Error('Inbox unreadable; restore the local journal before accepting messages')
    }
  }

  private change<T>(work: (state: State) => T): Promise<T> {
    const next = this.lock.then(async () => {
      const state = await this.read()
      const result = work(state)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, this.file)
      return result
    })
    this.lock = next.catch(() => {})
    return next
  }

  accept(update: Update, execution?: ExecutionChoice): Promise<boolean> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid update ID')
    return this.change((state) => {
      if (state.seen.includes(update.update_id)) return false
      state.seen.push(update.update_id)
      state.waiting.push({ update, receivedAt: this.now(), execution })
      return true
    })
  }

  // Seal membership BEFORE normalization or run creation. Replay uses the same run ID.
  next(force = false): Promise<InboxBatch | undefined> {
    return this.change((state) => {
      const pending = state.batches.find((b) => b.status === 'pending')
      if (pending) return pending
      if (!state.waiting.length) return
      const first = state.waiting[0]
      const last = state.waiting.at(-1)!
      if (
        !force &&
        (state.waiting.length < 10 || last.update.message?.media_group_id) &&
        this.now() - last.receivedAt < 2000 &&
        this.now() - first.receivedAt < 30000
      )
        return
      const chatId = (update: Update) => update.message?.chat.id ?? update.callback_query?.message?.chat.id
      const boundary = state.waiting.findIndex((e) => JSON.stringify(e.execution) !== JSON.stringify(first.execution) || chatId(e.update) !== chatId(first.update))
      const entries = state.waiting.splice(0, boundary < 0 ? 10 : Math.min(10, boundary))
      // Telegram albums contain at most ten items. Don't split one at the batch boundary.
      const album = entries.at(-1)?.update.message?.media_group_id
      while (album && state.waiting[0]?.update.message?.media_group_id === album &&
        chatId(state.waiting[0].update) === chatId(first.update) &&
        JSON.stringify(state.waiting[0].execution) === JSON.stringify(first.execution))
        entries.push(state.waiting.shift()!)
      const batch: InboxBatch = { id: `tg_${first.update.update_id}`, entries, status: 'pending' }
      state.batches.push(batch)
      return batch
    })
  }

  finish(id: string, failed = false): Promise<void> {
    return this.change((state) => {
      const batch = state.batches.find((b) => b.id === id)
      if (!batch || batch.status !== 'pending') return
      if (failed) batch.status = 'failed'
      else state.batches = state.batches.filter((b) => b.id !== id)
    })
  }

  cancel(): Promise<number> {
    return this.change((state) => {
      let count = state.waiting.length
      state.waiting = []
      for (const batch of state.batches) {
        if (batch.status !== 'pending') continue
        count += batch.entries.length
        batch.status = 'cancelled'
      }
      return count
    })
  }

  retryLatest(userId: number, chatId: number, owner?: Owner | null): Promise<string | undefined> {
    return this.change((state) => {
      const batch = [...state.batches].reverse().find(
        (b) =>
          b.status === 'failed' &&
          b.entries.every((e) => {
            const message = e.update.message || e.update.callback_query?.message
            const from = e.update.message?.from || e.update.callback_query?.from
            return (
              owner?.kind === 'group' ? !e.update.message?.sender_chat && isOwner({from, chat: message?.chat}, owner) : from?.id === userId &&
              !from.is_bot &&
              message?.chat.type === 'private' &&
              message.chat.id === chatId
            )
          }),
      )
      if (!batch) return
      batch.status = 'pending'
      return batch.id
    })
  }

  async pending(id: string): Promise<boolean> {
    await this.lock
    return (await this.read()).batches.some((b) => b.id === id && b.status === 'pending')
  }

  async status(): Promise<{ pending: number; failed: number }> {
    await this.lock
    const state = await this.read()
    return {
      pending:
        state.waiting.length +
        state.batches.filter((b) => b.status === 'pending').reduce((n, b) => n + b.entries.length, 0),
      failed: state.batches.filter((b) => b.status === 'failed').length,
    }
  }
}
