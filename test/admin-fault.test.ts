import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { access } from 'node:fs/promises'
import { adminChannel, adminFaultFromReceipt, reportAdminFault, reportAdminFaultOnce, sendAdminFault } from '../src/admin-fault.js'
import { loadConfig } from '../src/config.js'
import { createLedgerHandler, serveDeliverySocket } from '../src/delivery-socket.js'
import { parseMessageArgs } from '../src/message-send.js'
import { executorEnvironment } from '../src/executor.js'
import { ownerRun } from './helpers/owner-run.js'

const botToken = '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsY'
const env = { EZ_ADMIN_TELEGRAM_BOT_TOKEN: botToken, EZ_ADMIN_TELEGRAM_CHAT_ID: '-1001234', EZ_ADMIN_AGENT_NAME: 'trader' }
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const R3 = '33333333-3333-4333-8333-333333333333'
// The relay's own record of a plugin invocation, as the broker writes it.
const recordReceipt = async (controlDir: string, runId: string, id: string, fields: object = {}) => {
  await mkdir(join(controlDir, 'plugin-receipts', runId), { recursive: true })
  await writeFile(join(controlDir, 'plugin-receipts', runId, `${id}.json`), JSON.stringify({ version: 1, kind: 'plugin-invocation', receiptId: id, runId, plugin: 'ezstocks', alias: 'ezstocks', status: 'plugin-failed', exitCode: 3, ...fields }))
}
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

test('the relay renders the admin message from a recorded fault; failures are unconfirmed or HTTP errors', async () => {
  const calls: { url: string; body: { chat_id: number; text: string; parse_mode?: string } }[] = []
  const ok = (async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}') }) as unknown as typeof fetch
  const fault = { receipt: R1, tool: 'ezstocks', code: '3', class: 'plugin-failed' }
  await sendAdminFault(adminChannel(env)!, fault, 'r_1', ok)
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${botToken}/sendMessage`)
  assert.deepEqual(calls[0]!.body, { chat_id: -1001234, text: `[ez trader] fault: tool=ezstocks code=3 class=plugin-failed receipt=${R1} run=r_1`, disable_web_page_preview: true })
  const refused = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, fault, 'r_1', refused), /HTTP 403/)
  const down = (async () => { throw new Error(`connect failed ${botToken}`) }) as unknown as typeof fetch
  await assert.rejects(sendAdminFault(adminChannel(env)!, fault, 'r_1', down), (error: Error) => /unconfirmed/.test(error.message) && !error.message.includes(botToken))
})

test('every admin fault leaves one structured relay log line; a failed send is one error line with the receipt and the reason', async () => {
  const channel = adminChannel(env)!
  const lines: unknown[][] = []
  const log = (level: string, fields: object) => { lines.push([level, fields]) }
  const fault = { receipt: R1, tool: 'ezstocks', code: '3', class: 'plugin-failed' }
  const ok = (async () => ({ delivered: true as const })) as unknown as typeof sendAdminFault
  assert.deepEqual(await reportAdminFault(channel, fault, 'r_1', ok, log), { delivered: true })
  const down = (async () => { throw new Error('Admin delivery unconfirmed: request failed or timed out') }) as unknown as typeof sendAdminFault
  await assert.rejects(reportAdminFault(channel, fault, 'r 2', down, log), /unconfirmed/)
  const base = { tool: 'ezstocks', code: '3', class: 'plugin-failed', receipt: R1 }
  assert.deepEqual(lines, [
    ['info', { run_id: 'r_1', ...base, delivered: true }],
    ['error', { run_id: 'r2', ...base, delivered: false, reason: 'Admin delivery unconfirmed: request failed or timed out' }],
  ])
  // The default sink is one JSON line at error level on stderr.
  const errors: string[] = []
  const original = console.error
  console.error = (line: string) => { errors.push(line) }
  try { await assert.rejects(reportAdminFault(channel, fault, 'r_1', down), /unconfirmed/) } finally { console.error = original }
  assert.equal(errors.length, 1)
  assert.deepEqual(JSON.parse(errors[0]!), { level: 'error', event: 'admin fault', run_id: 'r_1', ...base, delivered: false, reason: 'Admin delivery unconfirmed: request failed or timed out' })
})

test('one admin message per receipt: a repeat sends nothing, a failed send records nothing, concurrent calls share one send', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-once-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await recordReceipt(dir, 'r_1', R1)
  const fault = { receipt: R1, tool: 'ezstocks', code: '3', class: 'plugin-failed' }
  let sends = 0
  let fail = true
  const report = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 20)); if (fail) throw new Error('Admin delivery failed: Telegram HTTP 403'); return { delivered: true } }
  await assert.rejects(reportAdminFaultOnce(dir, 'r_1', fault, report), /403/)
  await assert.rejects(access(join(dir, 'plugin-receipts', 'r_1', `${R1}.admin-reported`)))
  fail = false
  const [a, b] = await Promise.all([reportAdminFaultOnce(dir, 'r_1', fault, report), reportAdminFaultOnce(dir, 'r_1', fault, report)])
  assert.deepEqual([a, b], [{ delivered: true }, { delivered: true }])
  assert.equal(sends, 2)
  await access(join(dir, 'plugin-receipts', 'r_1', `${R1}.admin-reported`))
  assert.deepEqual(await reportAdminFaultOnce(dir, 'r_1', fault, report), { delivered: true, alreadyReported: true })
  assert.equal(sends, 2)
})

test('a fault is read only from the relay record of a failed invocation of this run, never from caller text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-receipt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await recordReceipt(dir, 'r_1', R1)
  await recordReceipt(dir, 'r_1', R2, { status: 'completed', exitCode: 0 })
  await recordReceipt(dir, 'r_other', R3)
  assert.deepEqual(await adminFaultFromReceipt(dir, 'r_1', R1), { receipt: R1, tool: 'ezstocks', code: '3', class: 'plugin-failed' })
  // Caller free text, an unrecorded ID, another run's receipt, a path trick and a completed invocation are all refused.
  for (const bad of ['SECRET private note', 'x'.repeat(500), '', 7, undefined, `../r_other/${R3}`]) await assert.rejects(adminFaultFromReceipt(dir, 'r_1', bad), /receipt/i)
  await assert.rejects(adminFaultFromReceipt(dir, 'r_1', '44444444-4444-4444-8444-444444444444'), /No relay receipt/)
  await assert.rejects(adminFaultFromReceipt(dir, 'r_1', R3), /No relay receipt/)
  await assert.rejects(adminFaultFromReceipt(dir, 'r_1', R2), /did not fail/)
})

test('the ledger delivers admin faults only for an active owner run and a recorded failure, and never falls back to the owner chat', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-admin-fault-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const run = await ownerRun(dir, 'r_admin')
  await recordReceipt(dir, run.id, R1, { alias: 'ibkr', exitCode: 7 })
  const sent: unknown[] = []
  const unset = createLedgerHandler(dir, { wake: () => {}, status })
  await assert.rejects(unset({ op: 'adminFault', payload: { runId: run.id, receipt: R1 } }), /not configured/)
  const handler = createLedgerHandler(dir, { wake: () => {}, status, adminFault: async (fault, runId) => { sent.push([fault, runId]); return { delivered: true } } })
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: 'r_missing', receipt: R1 } }), /No active core run/)
  // Regression: the old payload carried a tool and free text the relay forwarded verbatim; it is now refused and nothing is sent.
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: run.id, tool: 'ezstocks', error: 'SECRET private note' } as never }), /receipt/i)
  await assert.rejects(handler({ op: 'adminFault', payload: { runId: run.id, receipt: R2 } }), /No relay receipt/)
  assert.deepEqual(sent, [])
  // Caller extras beside a valid receipt never reach the fault.
  assert.deepEqual(await handler({ op: 'adminFault', payload: { runId: run.id, receipt: R1, error: 'SECRET private note', tool: 'x' } as never }), { delivered: true })
  assert.deepEqual(sent, [[{ receipt: R1, tool: 'ibkr', code: '7', class: 'plugin-failed' }, run.id]])
  // The same receipt again is answered as already reported and sends nothing.
  assert.deepEqual(await handler({ op: 'adminFault', payload: { runId: run.id, receipt: R1 } }), { delivered: true, alreadyReported: true })
  assert.equal(sent.length, 1)
})

test('message --admin exits non-zero saying the fault was NOT delivered, records nothing, and succeeds on a later call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-a-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const run = await ownerRun(dir, 'r_cli')
  await recordReceipt(dir, run.id, R1)
  let down = true
  const sends: string[] = []
  const handler = createLedgerHandler(dir, { wake: () => {}, status, adminFault: async fault => { sends.push(fault.receipt); if (down) throw new Error('Admin delivery unconfirmed: request failed or timed out'); return { delivered: true } } })
  const server = await serveDeliverySocket(dir, handler)
  t.after(() => server.stop())
  const run_ = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/message.ts', import.meta.url).pathname, '--admin', '--receipt', R1], { env: { PATH: process.env.PATH, EZ_CONTROL_DIR: dir, EZ_RUN_ID: run.id, EZ_DELIVERY_SOCKET: server.socketPath } })
    let out = '', err = ''
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c)
    const [code] = await once(child, 'close')
    return { code, out, err }
  }
  const failed = await run_()
  assert.equal(failed.code, 1)
  assert.equal(JSON.parse(failed.err).delivered, false)
  assert.match(JSON.parse(failed.err).error, /NOT delivered.*unconfirmed/)
  down = false
  const sent = await run_()
  assert.equal(sent.code, 0)
  assert.equal(JSON.parse(sent.out).status, 'delivered')
  const repeat = await run_()
  assert.equal(repeat.code, 0)
  assert.equal(JSON.parse(repeat.out).status, 'already-reported')
  assert.deepEqual(sends, [R1, R1])
  const missing = spawn(process.execPath, ['--import', 'tsx', new URL('../src/message.ts', import.meta.url).pathname, '--admin'], { env: { PATH: process.env.PATH, EZ_CONTROL_DIR: dir, EZ_RUN_ID: run.id, EZ_DELIVERY_SOCKET: server.socketPath } })
  assert.equal((await once(missing, 'close'))[0], 1)
})

test('ez prints a receipt ID only when the relay stored it; otherwise it says there is none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ez-b-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const socket = join(root, 'b.sock')
  let invoked: object = {}
  const broker = createServer(connection => {
    let buffer = ''
    connection.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const frame = JSON.parse(buffer)
      connection.end(JSON.stringify(frame.operation === 'resolve' ? { ok: true, revision: 'a'.repeat(64), capability: 'c'.repeat(64) } : invoked) + '\n')
    })
  })
  await new Promise<void>(resolve => broker.listen(socket, resolve))
  t.after(() => broker.close())
  const ez = async () => {
    const child = spawn(process.execPath, [new URL('../bin/ez', import.meta.url).pathname, 'sample', 'read'], { env: { PATH: process.env.PATH, EZ_PLUGIN_BROKER_SOCKET: socket, EZ_RUN_ID: 'r_ez' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', c => err += c)
    const [code] = await once(child, 'close')
    return { code, err }
  }
  const stored = { receipt: { receiptId: R1 } }
  invoked = { ok: true, code: 3, stdout: '', stderr: 'boom', ...stored }
  assert.match((await ez()).err, new RegExp(`ez receipt: ${R1}`))
  invoked = { ok: true, code: 3, stdout: '', stderr: 'boom', ...stored, receiptError: 'disk full' }
  const unstored = await ez()
  assert.equal(unstored.code, 3)
  assert.match(unstored.err, /ez receipt: none \(the relay could not store it\)/)
  assert.ok(!unstored.err.includes(R1))
  invoked = { ok: false, error: 'plugin unavailable' }
  assert.match((await ez()).err, /ez receipt: none/)
})

test('--admin is a flag naming a recorded receipt, not a recipient or text', () => {
  assert.deepEqual(parseMessageArgs(['--admin', '--receipt', R1]), { textFile: undefined, admin: true, receipt: R1 })
  assert.deepEqual(parseMessageArgs(['--admin', '--tool', 'ezstocks', '--error', 'private note']), { textFile: undefined, admin: true })
})
