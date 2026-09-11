// Contract: docs/approval-channel.md. Transport only: never imports or starts an agent.
import { Api, GrammyError, InlineKeyboard } from 'grammy'
import { readFile } from 'node:fs/promises'
import type { Update } from 'grammy/types'
import { telegramMessages, telegramPacer } from './telegram-message.js'

type Identity = { bot_id: number; owner_id: number; chat_id: number; offset: number }
type Card = { id: string; text: string; token: string; chat_id: number; message_id?: number; pending?: boolean }
type Backend = <T>(path: string, body?: unknown) => Promise<T>

export function approvalBackend(origin: string, token: string): Backend {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof token !== 'string' || token.length < 32) throw Error('Invalid approval service configuration')
  return async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(url.origin + '/approval/' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw Object.assign(Error(`Approval backend HTTP ${response.status}`), { status: response.status })
    return await response.json() as T
  }
}

export class ApprovalChannel {
  private messages
  private rendered = new Map<number, string>()
  private pendingReceipt: { id: string; bot_id: number; chat_id: number; message_id: number } | undefined
  constructor(private api: Api, private backend: Backend, private identity: Identity, pace = telegramPacer()) {
    if (![identity.bot_id, identity.owner_id, identity.chat_id].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Fixed private owner binding required')
    this.messages = telegramMessages(api, pace)
  }

  private keyboard(card: Card) {
    // Telegram callback data <=64 UTF-8 bytes: 24-char id + 24-char nonce + decision.
    if (!/^[a-f0-9]{24}$/.test(card.id) || !/^[A-Za-z0-9_-]{24}$/.test(card.token)) throw Error('Invalid card identity')
    return new InlineKeyboard().text('Approve', `${card.id}:${card.token}:a`).text('Reject', `${card.id}:${card.token}:r`)
  }

  async deliver() {
    if (this.pendingReceipt) {
      await this.backend('delivered', this.pendingReceipt)
      this.pendingReceipt = undefined
    }
    const card = await this.backend<Card | null>('claim', {})
    if (!card) return
    if (card.chat_id !== this.identity.chat_id || card.text.length > 3500) throw Error('Approval card exceeds delivery boundary')
    const sent = await this.messages.send(card.chat_id, card.text, { reply_markup: this.keyboard(card) })
    // Retry the receipt, never send a second actionable card after uncertain delivery.
    this.pendingReceipt = { id: card.id, bot_id: this.identity.bot_id, chat_id: sent.chat.id, message_id: sent.message_id }
    await this.backend('delivered', this.pendingReceipt)
    this.pendingReceipt = undefined
    this.rendered.set(sent.message_id, card.text + ':true')
  }

  async handle(update: Update) {
    const callback = update.callback_query
    if (!callback) return
    const message = callback.message
    if (callback.from.is_bot || callback.from.id !== this.identity.owner_id || !message || !('text' in message) || message.chat.type !== 'private' || message.chat.id !== this.identity.chat_id || message.from?.id !== this.identity.bot_id) return
    const match = /^([a-f0-9]{24}):([A-Za-z0-9_-]{24}):([ar])$/.exec(callback.data || '')
    if (!match) return
    try {
      await this.backend('decide', { id: match[1], token: match[2], decision: match[3] === 'a' ? 'approve' : 'reject',
        bot_id: this.identity.bot_id, user_id: callback.from.id, chat_id: message.chat.id,
        message_id: message.message_id, update_id: update.update_id, callback_id: callback.id })
      await this.api.answerCallbackQuery(callback.id, { text: match[3] === 'a' ? 'Approval recorded' : 'Rejected' }).catch(() => {})
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error
      await this.api.answerCallbackQuery(callback.id, { text: 'Expired, changed or already decided' }).catch(() => {})
    }
  }

  async poll() {
    const updates = await this.api.getUpdates({ offset: this.identity.offset, timeout: 5, allowed_updates: ['callback_query'] })
    for (const update of updates) {
      await this.handle(update)
      const offset = update.update_id + 1
      await this.backend('cursor', { offset })
      this.identity.offset = offset
    }
  }

  async refresh() {
    const cards = await this.backend<Card[]>('updates')
    for (const card of cards) {
      if (card.chat_id !== this.identity.chat_id || !card.message_id || card.text.length > 3500) throw Error('Invalid status card')
      const content = card.text + ':' + String(card.pending)
      if (this.rendered.get(card.message_id) === content) continue
      try {
        await this.messages.edit(card.chat_id, card.message_id, card.text, {
          reply_markup: card.pending ? this.keyboard(card) : new InlineKeyboard(),
        })
      } catch (error) {
        if (!(error instanceof GrammyError) || !error.description.includes('message is not modified')) throw error
      }
      this.rendered.set(card.message_id, content)
    }
  }
}

export async function main() {
  const config = JSON.parse(await readFile(process.env.EZ_APPROVAL_CONFIG || '/run/secrets/approval-config.json', 'utf8'))
  const api = new Api(config.bot_token)
  const backend = approvalBackend(config.url, config.token)
  const identity = await backend<Identity>('identity')
  const me = await api.getMe()
  if (me.id !== identity.bot_id) throw Error('Wrong approval bot token')
  const channel = new ApprovalChannel(api, backend, identity)
  let stop = false
  process.once('SIGTERM', () => { stop = true })
  process.once('SIGINT', () => { stop = true })
  const loop = async (fn: () => Promise<void>) => {
    while (!stop) {
      try { await fn() } catch { console.error('Approval transport interrupted; preserving receipts for reconciliation') }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  await Promise.all([loop(() => channel.poll()), loop(async () => { await channel.deliver(); await channel.refresh() })])
}
