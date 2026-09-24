import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { ownerRun } from './helpers/owner-run.js'
import { serveTestLedger } from './helpers/ledger.js'
import { deliveredMessages } from '../src/message-history.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'
import { ownerId, ownerEpoch } from '../src/control-state.js'
import { ApplicationBindings } from '../src/application-channel.js'
import { randomBytes } from 'node:crypto'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ez-history-'))
  // Child CLI assertions below reach the memory ledger through the socket.
  const ledger = await serveTestLedger(dir)
  t.after(async () => { await ledger.stop(); await rm(dir, { recursive: true, force: true }) })
  await ownerRun(dir, 'tg_1')
  const runs = new RunStore(dir)
  const send = async (runId: string, text: string, ids: number[]) => {
    const item = await runs.enqueueMessage(runId, text)
    await runs.claimOutbox(item.id)
    await runs.markOutboxSent(item.id, ids)
    return item
  }
  return { dir, runs, send }
}

test('CLI retrieves Synopsys delivery from another session without changing sessions or sending', async t => {
  const { dir, runs, send } = await fixture(t)
  const owner = (await new ControlStore(dir, 1000).status()).owner!
  const report = await runs.create({ id: 'r_schedule_report', chatId: 101, telegramUserId: 101, texts: ['quarterly results'],
    execution: { sessionId: 'report_session', preset: { id: 'fixture', name: 'Fixture', cli: 'codex' } },
    scheduled: { id: 's_earnings', revision: 'rev', dueAt: new Date().toISOString(), pairedAt: owner.pairedAt } })
  await runs.patch(report.id, { status: 'running', nativeSessionId: 'report_session' })
  await send('r_schedule_report', 'Synopsys (SNPS): quarterly results', [10, 11])
  await runs.patch('r_schedule_report', { status: 'completed' })
  await send('tg_1', 'Other report', [12])
  const controlBefore = await new ControlStore(dir, 1000).status()
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/ezenciel-agents-message.mjs', 'history', '--message-id', '11'], {
    env: { ...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: 'tg_1' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text, 'Synopsys (SNPS): quarterly results')
  assert.equal(result.messages[0].nativeSessionId, 'report_session')
  assert.equal(result.messages[0].scheduleId, 's_earnings')
  assert.deepEqual(result.messages[0].messageIds, [10, 11])
  assert.deepEqual(await new ControlStore(dir, 1000).status(), controlBefore)
  // History reads never create outbox state on disk.
  await assert.rejects(stat(join(dir, 'outbox')))
  const latest = await deliveredMessages(dir, 'tg_1', { limit: 1 })
  assert.equal(latest.messages[0].text, 'Other report')
  assert.equal(latest.hasMore, true)
})

test('only confirmed deliveries in current owner binding are exposed', async t => {
  const { dir, runs, send } = await fixture(t)
  await send('tg_1', 'included', [1])
  await runs.enqueueMessage('tg_1', 'pending')
  const failed = await runs.enqueueMessage('tg_1', 'uncertain')
  await runs.claimOutbox(failed.id)
  await runs.failOutbox(failed.id, 'unknown', true)
  // Receipts without usable message IDs are not delivery evidence.
  const invalid = await runs.enqueueMessage('tg_1', 'invalid receipt')
  await runs.claimOutbox(invalid.id)
  await runs.markOutboxSent(invalid.id, [])
  for (const input of [
    { id: 'r_other_chat', chatId: 202, telegramUserId: 101 },
    { id: 'r_other_owner', chatId: 101, telegramUserId: 202 },
    { id: 'r_external', chatId: 101, telegramUserId: 101, external: { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] } },
  ]) {
    await runs.create({ ...input, texts: ['excluded'] })
    await runs.patch(input.id, { status: 'running' })
    await send(input.id, 'excluded', [3])
  }
  assert.deepEqual((await deliveredMessages(dir, 'tg_1')).messages.map(m => m.text), ['included'])
  assert.equal((await deliveredMessages(dir, 'tg_1')).messages.length, 1)
})

test('unauthorized callers and invalid arguments fail closed', async t => {
  const { dir, runs } = await fixture(t)
  for (const limit of [0, 51, NaN, 1.5]) await assert.rejects(deliveredMessages(dir, 'tg_1', { limit }), /Limit/)
  await assert.rejects(deliveredMessages(dir, 'tg_1', { messageId: -1 }), /Message ID/)
  await assert.rejects(deliveredMessages(dir, '../tg_1'), /identifier/)
  await assert.rejects(deliveredMessages(dir, 'missing'), /No active/)
  await ownerRun(dir, 'r_external', { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] })
  await assert.rejects(deliveredMessages(dir, 'r_external'), /blocked/)
  await runs.create({ id: 'r_stranger', chatId: 101, telegramUserId: 202, texts: ['other'] })
  await runs.patch('r_stranger', { status: 'running' })
  await assert.rejects(deliveredMessages(dir, 'r_stranger'), /owner-mismatch/)
  await runs.patch('tg_1', { status: 'completed' })
  await assert.rejects(deliveredMessages(dir, 'tg_1'), /No active/)
  await runs.patch('tg_1', { status: 'running' })
  await new ControlStore(dir, 1000).revokeOwner()
  await assert.rejects(deliveredMessages(dir, 'tg_1'), /owner-mismatch/)
})

test('approval messages retain the content delivered to Telegram', async t => {
  const { dir, runs } = await fixture(t)
  const item = await runs.enqueueApproval('tg_1', 'Approve this messaging task?', 'act_history')
  await runs.claimOutbox(item.id)
  await runs.markOutboxSent(item.id, [20])
  assert.equal((await deliveredMessages(dir, 'tg_1')).messages[0].text, 'Approve this messaging task?')
})

test('CLI flushes complete long reports and rejects send options in history mode', async t => {
  const { dir, send } = await fixture(t)
  const text = 'Report evidence. '.repeat(8000)
  await send('tg_1', text, [30])
  const env = { ...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: 'tg_1' }
  const cli = [ 'bin/ezenciel-agents-message.mjs', 'history' ]
  const { stdout } = await promisify(execFile)(process.execPath, cli, { env })
  assert.equal(JSON.parse(stdout).messages[0].text, text)
  await assert.rejects(promisify(execFile)(process.execPath, [...cli, '--text', 'do not send'], { env }), /Unknown option/)
  // History reads never create outbox state on disk.
  await assert.rejects(stat(join(dir, 'outbox')))
})

test('application history reads only delivered literal text in its current binding and scope', async t => {
  const { dir, runs } = await fixture(t)
  const owner = (await new ControlStore(dir, 1000).status()).owner!
  const bindings = new ApplicationBindings(dir)
  const first = (await bindings.register('first', randomBytes(32).toString('base64url'), owner))!
  const second = (await bindings.register('second', randomBytes(32).toString('base64url'), owner))!
  const create = async (id: string, bindingId: string, scope: string) => {
    const run = await runs.create({ id, ownerId: ownerId(owner), ownerEpoch: ownerEpoch(owner),
      texts: ['test'], application: { bindingId, scope, requestId: id } })
    await runs.patch(id, { status: 'running' })
    return run
  }
  const earlier = await create('r_app_earlier', first.bindingId, 'book')
  const current = await create('r_app_current', first.bindingId, 'book')
  const otherScope = await create('r_app_other_scope', first.bindingId, 'private')
  const otherBinding = await create('r_app_other_binding', second.bindingId, 'book')
  const deliver = async (runId: string, text: string) => {
    const item = await runs.enqueueMessage(runId, text)
    await runs.claimOutbox(item.id)
    await runs.markOutboxSent(item.id)
    return item
  }
  const literal = 'Book is $1,234; path C:\\reports\\$raw'
  const firstItem = await deliver(earlier.id, literal)
  await runs.patch(earlier.id, { status: 'completed' })
  await deliver(otherScope.id, 'other scope secret')
  await deliver(otherBinding.id, 'other binding secret')
  await deliver('tg_1', 'Telegram secret')
  await runs.enqueueMessage(current.id, 'queued is not delivered')
  const env = { ...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: current.id }
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/ezenciel-agents-message.mjs', 'history'], { env })
  const result = JSON.parse(stdout)
  assert.equal(result.scope, 'book')
  assert.deepEqual(result.messages.map((message: { id: string; text: string }) => ({ id: message.id, text: message.text })),
    [{ id: firstItem.id, text: literal }])
  assert.equal(result.hasMore, false)
  await assert.rejects(promisify(execFile)(process.execPath,
    ['bin/ezenciel-agents-message.mjs', 'history', '--message-id', '1'], { env }), /Telegram history/)
  await bindings.register('first', null, owner)
  await assert.rejects(deliveredMessages(dir, current.id), /revoked/)
  await new ControlStore(dir, 1000).revokeOwner()
  await assert.rejects(deliveredMessages(dir, otherBinding.id), /owner-mismatch|revoked/)
})
