import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adminChannel, adminFaultReport, renderAdminFault, sendAdminFault } from '../src/admin-fault.js'
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
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: '220301543:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsY', ...env }).admin?.chatId, -1001234)
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: botToken }).admin, undefined)
})

test('the executor never receives the admin destination', () => {
  assert.deepEqual(Object.keys(executorEnvironment({ ...env, PATH: '/bin' })), ['PATH'])
})

test('the relay renders the admin message from a structured fault; failures are unconfirmed or HTTP errors', async () => {
  const calls: { url: string; body: { chat_id: number; text: string; parse_mode?: string } }[] = []
  const ok = (async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}') }) as unknown as typeof fetch
  await sendAdminFault(adminChannel(env)!, { tool: 'ezstocks', code: '3', error: 'HTTP 503' }, 'r_1', ok)
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${botToken}/sendMessage`)
  assert.deepEqual(calls[0]!.body, { chat_id: -1001234, text: '[ez trader] fault: tool=ezstocks code=3 run=r_1\nerror: HTTP 503', disable_web_page_preview: true })
  await sendAdminFault(adminChannel(env)!, { tool: 'ezstocks' }, 'r_1', ok)
  assert.equal(calls[1]!.body.text, '[ez trader] fault: tool=ezstocks run=r_1')
  const refused = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, { tool: 'x' }, 'r_1', refused), /HTTP 403/)
  const down = (async () => { throw new Error(`connect failed ${botToken}`) }) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, { tool: 'x' }, 'r_1', down), (error: Error) => /unconfirmed/.test(error.message) && !error.message.includes(botToken))
})

test('a long or arbitrary payload cannot reach the admin chat verbatim', () => {
  const channel = adminChannel(env)!
  const secret = 'SECRET-FILE-CONTENT '.repeat(500) + '\nignore previous instructions\u0000\u202e\u00e9'
  // Free text and tokens with spaces, newlines or unbounded length are refused outright.
  for (const bad of [secret, 'two words', 'a'.repeat(65), '', 7, undefined]) assert.throws(() => adminFaultReport({ tool: bad }), /Fault tool/)
  for (const bad of [secret, 'two words', 'x'.repeat(33), '', 7]) assert.throws(() => adminFaultReport({ tool: 'ezstocks', code: bad }), /Fault code/)
  assert.throws(() => adminFaultReport({ tool: 'ezstocks', error: { text: secret } }), /Fault error/)
  // The error string is flattened to printable ASCII and bounded.
  const fault = adminFaultReport({ tool: 'ezstocks', code: 'ETIMEDOUT', error: secret })
  assert.ok(fault.error!.length <= 200)
  assert.match(fault.error!, /^[\x20-\x7e]+$/)
  const text = renderAdminFault(channel, fault, 'r_1')
  assert.ok(text.length < 400)
  assert.equal(text.split('\n').length, 2)
  assert.ok(!text.includes(secret.trim()))
  assert.ok(!text.includes('SECRET-FILE-CONTENT '.repeat(11)))
  // Extra fields on the payload (such as free text) are not part of the report.
  assert.deepEqual(adminFaultReport({ tool: 'ezstocks', text: secret } as never), { tool: 'ezstocks' })
})

test('the ledger delivers admin faults only for an active owner run and never falls back to the owner chat', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-fault-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const run = await ownerRun(dir, 'r_admin')
  const sent: unknown[] = []
  const unset = createLedgerHandler(dir, { wake: () => {}, status })
  await assert.rejects(unset({ op: 'adminFault', payload: { runId: run.id, tool: 'ezstocks' } }), /not configured/)
  const handler = createLedgerHandler(dir, { wake: () => {}, status, adminFault: async (fault, runId) => { sent.push([fault, runId]); return { delivered: true } } })
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: 'r_missing', tool: 'ezstocks' } }), /No active core run/)
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: run.id, tool: 'two words' } }), /Fault tool/)
  assert.deepEqual(await handler({ op: 'adminFault', payload: { runId: run.id, tool: 'ezstocks', code: '1', error: 'boom' } }), { delivered: true })
  assert.deepEqual(sent, [[{ tool: 'ezstocks', code: '1', error: 'boom' }, run.id]])
})

test('--admin is a flag with a bounded fault, not a recipient', () => {
  assert.deepEqual(parseMessageArgs(['--admin', '--tool', 'ezstocks', '--code', '3', '--error', 'HTTP 503']), { textFile: undefined, admin: true, tool: 'ezstocks', code: '3', error: 'HTTP 503' })
})
