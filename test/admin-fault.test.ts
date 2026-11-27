import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adminChannel, sendAdminFault } from '../src/admin-fault.js'
import { loadConfig } from '../src/config.js'
import { createLedgerHandler } from '../src/delivery-socket.js'
import { parseMessageArgs } from '../src/message-send.js'
import { executorEnvironment } from '../src/executor.js'
import { ownerRun } from './helpers/owner-run.js'

const botToken = '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'
const env = { EZ_ADMIN_TELEGRAM_BOT_TOKEN: botToken, EZ_ADMIN_TELEGRAM_CHAT_ID: '-1001234', EZ_ADMIN_AGENT_NAME: 'trader' }
const status = () => ({ polling: false, applicationOnly: false, telegramConfigured: true, version: 'test' })

test('the admin destination is all-or-nothing operator configuration', () => {
  assert.equal(adminChannel({}), undefined)
  assert.deepEqual(adminChannel(env), { botToken, chatId: -1001234, name: 'trader' })
  for (const missing of Object.keys(env)) assert.throws(() => adminChannel({ ...env, [missing]: '' }))
  assert.throws(() => adminChannel({ ...env, EZ_ADMIN_TELEGRAM_CHAT_ID: 'owner' }), /chat ID/)
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: botToken, ...env }).admin?.chatId, -1001234)
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: botToken }).admin, undefined)
})

test('the executor never receives the admin destination', () => {
  assert.deepEqual(Object.keys(executorEnvironment({ ...env, PATH: '/bin' })), ['PATH'])
})

test('admin text goes to the admin chat with the agent prefix and a bounded size; failures are unconfirmed or HTTP errors', async () => {
  const calls: { url: string; body: { chat_id: number; text: string; parse_mode?: string } }[] = []
  const ok = (async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}') }) as unknown as typeof fetch
  await sendAdminFault(adminChannel(env)!, 'plugin failed', ok)
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${botToken}/sendMessage`)
  assert.deepEqual(calls[0]!.body, { chat_id: -1001234, text: '[ez trader] fault: plugin failed', disable_web_page_preview: true })
  await sendAdminFault(adminChannel(env)!, 'x'.repeat(9000), ok)
  assert.equal(calls[1]!.body.text.length, 4000)
  const refused = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, 'x', refused), /HTTP 403/)
  const down = (async () => { throw new Error(`connect failed ${botToken}`) }) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, 'x', down), (error: Error) => /unconfirmed/.test(error.message) && !error.message.includes(botToken))
})

test('the ledger delivers admin faults only for an active owner run and never falls back to the owner chat', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-fault-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const run = await ownerRun(dir, 'r_admin')
  const sent: string[] = []
  const unset = createLedgerHandler(dir, { wake: () => {}, status })
  await assert.rejects(unset({ op: 'adminFault', payload: { runId: run.id, text: 'boom' } }), /not configured/)
  const handler = createLedgerHandler(dir, { wake: () => {}, status, adminFault: async text => { sent.push(text); return { delivered: true } } })
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: 'r_missing', text: 'boom' } }), /No active core run/)
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: run.id, text: '  ' } }), /content is required/)
  assert.deepEqual(await handler({ op: 'adminFault', payload: { runId: run.id, text: 'boom' } }), { delivered: true })
  assert.deepEqual(sent, ['boom'])
})

test('--admin is a flag, not a recipient', () => {
  assert.deepEqual(parseMessageArgs(['--admin', '--text', 'x']), { textFile: undefined, text: 'x', admin: true })
})
