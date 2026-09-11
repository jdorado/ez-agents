import assert from 'node:assert/strict'
import test from 'node:test'
import { Api, GrammyError } from 'grammy'
import type { Update } from 'grammy/types'
import { ApprovalChannel } from '../src/approval-channel.js'
import { telegramMessages } from '../src/telegram-message.js'

const identity = { bot_id: 1001, owner_id: 2002, chat_id: 3003, offset: 40 }
const card = {
  id: 'abcdefabcdefabcdefabcdef',
  text: 'Approve **the change**?',
  token: 'Nonce_123456789012345678',
  chat_id: identity.chat_id,
}

type Call = { path: string; body: unknown }
type TestBackend = <T>(path: string, body?: unknown) => Promise<T>

const asBackend = (fn: (path: string, body?: unknown) => Promise<unknown>): TestBackend => fn as TestBackend

const callbackUpdate = (overrides: Record<string, unknown> = {}): Update => ({
  update_id: 41,
  callback_query: {
    id: 'callback-1',
    from: { id: identity.owner_id, is_bot: false, first_name: 'Owner' },
    chat_instance: 'chat-instance',
    data: `${card.id}:${card.token}:a`,
    message: {
      message_id: 77,
      date: 1_700_000_000,
      text: card.text,
      from: { id: identity.bot_id, is_bot: true, first_name: 'Approval bot' },
      chat: { id: identity.chat_id, type: 'private', first_name: 'Owner' },
    },
    ...overrides,
  },
}) as unknown as Update

const mockApi = (overrides: Record<string, unknown> = {}) => ({
  answerCallbackQuery: async (..._args: unknown[]) => true,
  getUpdates: async (..._args: unknown[]) => [],
  sendMessage: async (..._args: unknown[]) => ({ chat: { id: identity.chat_id }, message_id: 88 }),
  editMessageText: async (..._args: unknown[]) => true,
  ...overrides,
}) as unknown as Api

test('ignores callbacks from the wrong user, bot, group, chat, and free text', async () => {
  const decideCalls: Call[] = []
  const backend = asBackend(async (path: string, body?: unknown) => {
    if (path === 'decide') decideCalls.push({ path, body })
    return undefined
  })
  let answers = 0
  const api = mockApi({ answerCallbackQuery: async () => { answers++; return true } })
  const channel = new ApprovalChannel(api, backend, { ...identity }, async () => {})

  const cases = [
    callbackUpdate({ from: { id: 9999, is_bot: false, first_name: 'Other' } }),
    callbackUpdate({ from: { id: identity.owner_id, is_bot: true, first_name: 'Owner bot' } }),
    callbackUpdate({ message: { ...((callbackUpdate().callback_query as any).message), from: { id: 9998, is_bot: true, first_name: 'Other bot' } } }),
    callbackUpdate({ message: { ...((callbackUpdate().callback_query as any).message), chat: { id: -4004, type: 'group', title: 'Group' } } }),
    callbackUpdate({ message: { ...((callbackUpdate().callback_query as any).message), chat: { id: 9999, type: 'private', first_name: 'Other' } } }),
    { update_id: 42, message: { message_id: 78, date: 1_700_000_001, text: 'approve this', from: { id: identity.owner_id, is_bot: false, first_name: 'Owner' }, chat: { id: identity.chat_id, type: 'private', first_name: 'Owner' } } } as unknown as Update,
  ]
  for (const update of cases) await channel.handle(update)

  assert.equal(decideCalls.length, 0)
  assert.equal(answers, 0)
})

test('passes the exact callback identity and decision metadata to the backend', async () => {
  const calls: Call[] = []
  const backend = asBackend(async (path: string, body?: unknown) => {
    calls.push({ path, body })
    return undefined
  })
  const answered: unknown[] = []
  const api = mockApi({ answerCallbackQuery: async (...args: unknown[]) => { answered.push(args); return true } })
  const channel = new ApprovalChannel(api, backend, { ...identity }, async () => {})

  await channel.handle(callbackUpdate())

  assert.deepEqual(calls, [{
    path: 'decide',
    body: {
      id: card.id,
      token: card.token,
      decision: 'approve',
      bot_id: identity.bot_id,
      user_id: identity.owner_id,
      chat_id: identity.chat_id,
      message_id: 77,
      update_id: 41,
      callback_id: 'callback-1',
    },
  }])
  assert.deepEqual(answered, [['callback-1', { text: 'Approval recorded' }]])
})

test('does not advance the cursor when callback handling has a network failure', async () => {
  const calls: Call[] = []
  const backend = asBackend(async (path: string, body?: unknown) => {
    calls.push({ path, body })
    if (path === 'decide') throw Error('backend offline')
    return undefined
  })
  const api = mockApi({ getUpdates: async () => [callbackUpdate()] })
  const current = { ...identity }
  const channel = new ApprovalChannel(api, backend, current, async () => {})

  await assert.rejects(channel.poll(), /backend offline/)
  assert.deepEqual(calls.map(call => call.path), ['decide'])
  assert.equal(current.offset, identity.offset)
})

test('handles an already-decided backend 409 and then commits the cursor', async () => {
  const calls: Call[] = []
  const backend = asBackend(async (path: string, body?: unknown) => {
    calls.push({ path, body })
    if (path === 'decide') throw Object.assign(Error('already decided'), { status: 409 })
    return undefined
  })
  const answered: unknown[] = []
  const api = mockApi({
    getUpdates: async () => [callbackUpdate()],
    answerCallbackQuery: async (...args: unknown[]) => { answered.push(args); return true },
  })
  const current = { ...identity }
  const channel = new ApprovalChannel(api, backend, current, async () => {})

  await channel.poll()

  assert.deepEqual(calls, [
    { path: 'decide', body: {
      id: card.id, token: card.token, decision: 'approve', bot_id: identity.bot_id,
      user_id: identity.owner_id, chat_id: identity.chat_id, message_id: 77,
      update_id: 41, callback_id: 'callback-1',
    } },
    { path: 'cursor', body: { offset: 42 } },
  ])
  assert.deepEqual(answered, [['callback-1', { text: 'Expired, changed or already decided' }]])
  assert.equal(current.offset, 42)
})

test('does not send a second actionable card after an uncertain delivery timeout', async () => {
  let claims = 0
  let sends = 0
  const backend = asBackend(async (path: string) => {
    if (path !== 'claim') return undefined
    claims++
    return claims === 1 ? card : null
  })
  const api = mockApi({ sendMessage: async () => { sends++; throw Error('Telegram request timed out') } })
  const channel = new ApprovalChannel(api, backend, { ...identity }, async () => {})

  await assert.rejects(channel.deliver(), /timed out/)
  await channel.deliver()

  assert.equal(claims, 2)
  assert.equal(sends, 1)
})

test('escapes outgoing markdown, paces sends and edits, and only retries definite parse errors', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let parseFailure = true
  const api = {
    sendMessage: async (...args: unknown[]) => {
      calls.push({ method: 'sendMessage', args })
      if (parseFailure) {
        parseFailure = false
        throw new GrammyError('parse failed', { ok: false, error_code: 400, description: 'Bad Request: can\'t parse entities' }, 'sendMessage', {})
      }
      return { chat: { id: 123 }, message_id: 90 }
    },
    editMessageText: async (...args: unknown[]) => {
      calls.push({ method: 'editMessageText', args })
      return true as const
    },
  }
  let paces = 0
  const messages = telegramMessages(api as unknown as Pick<Api, 'sendMessage' | 'editMessageText'>, async () => { paces++ })

  await messages.send(123, 'Danger <tag> & **bold**', { reply_markup: 'fixture' } as never)
  await messages.edit(123, 90, 'Edit <tag> & **bold**', { reply_markup: 'fixture' } as never)

  assert.equal(paces, 3)
  assert.deepEqual(calls, [
    { method: 'sendMessage', args: [123, 'Danger &lt;tag&gt; &amp; <b>bold</b>', { reply_markup: 'fixture', parse_mode: 'HTML' }] },
    { method: 'sendMessage', args: [123, 'Danger <tag> & **bold**', { reply_markup: 'fixture' }] },
    { method: 'editMessageText', args: [123, 90, 'Edit &lt;tag&gt; &amp; <b>bold</b>', { reply_markup: 'fixture', parse_mode: 'HTML' }] },
  ])

  let uncertainSends = 0
  const uncertain = telegramMessages({
    sendMessage: async () => { uncertainSends++; throw Error('network timeout') },
    editMessageText: async () => true as const,
  } as unknown as Pick<Api, 'sendMessage' | 'editMessageText'>, async () => {})
  await assert.rejects(uncertain.send(123, 'maybe delivered'), /network timeout/)
  assert.equal(uncertainSends, 1)
})
