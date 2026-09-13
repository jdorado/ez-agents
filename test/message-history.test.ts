import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { ownerRun } from './helpers/owner-run.js'
import { deliveredMessages } from '../src/message-history.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ez-history-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await ownerRun(dir, 'tg_1')
  const runs = new RunStore(dir)
  const patchFixture = async (id: string, patch: Record<string, unknown>) => {
    const file = join(dir, 'runs', id + '.json')
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...patch }))
  }
  const send = async (runId: string, text: string, ids: number[]) => {
    const item = await runs.enqueueMessage(runId, text)
    await runs.claimOutbox(item.id)
    await runs.markOutboxSent(item.id, ids)
    return join(dir, 'outbox', item.id + '.sent.json')
  }
  return { dir, runs, send, patchFixture }
}

test('CLI retrieves Synopsys delivery from another session without changing sessions or sending', async t => {
  const { dir, runs, send, patchFixture } = await fixture(t)
  await ownerRun(dir, 'r_schedule_report')
  const owner = (await new ControlStore(dir, 1000).status()).owner!
  await patchFixture('r_schedule_report', { nativeSessionId: 'report_session', scheduled: {
    id: 's_earnings', revision: 1, dueAt: new Date().toISOString(), pairedAt: owner.pairedAt,
  } })
  await send('r_schedule_report', 'Synopsys (SNPS): quarterly results', [10, 11])
  await runs.patch('r_schedule_report', { status: 'completed' })
  await patchFixture('tg_1', { texts: ['Why now?'] })
  await send('tg_1', 'Other report', [12])
  const before = await readdir(join(dir, 'outbox'))
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
  assert.deepEqual(await readdir(join(dir, 'outbox')), before)
  const latest = await deliveredMessages(dir, 'tg_1', { limit: 1 })
  assert.equal(latest.messages[0].text, 'Other report')
  assert.equal(latest.hasMore, true)
})

test('only confirmed deliveries in current owner binding are exposed', async t => {
  const { dir, runs, send, patchFixture } = await fixture(t)
  await send('tg_1', 'included', [1])
  await runs.enqueueMessage('tg_1', 'pending')
  const failed = await runs.enqueueMessage('tg_1', 'uncertain')
  await runs.claimOutbox(failed.id)
  await runs.failOutbox(failed.id, 'unknown', true)
  await writeFile(join(dir, 'outbox', 'corrupt.sent.json'), '{')
  await writeFile(join(dir, 'outbox', 'null.sent.json'), 'null')
  const invalid = await send('tg_1', 'invalid receipt', [2])
  const record = JSON.parse(await readFile(invalid, 'utf8'))
  record.receipt.messageIds = []
  await writeFile(invalid, JSON.stringify(record))
  for (const [id, patch] of [
    ['r_other_chat', { chatId: 202 }],
    ['r_other_owner', { telegramUserId: 202 }],
    ['r_old', { createdAt: '2000-01-01T00:00:00.000Z' }],
    ['r_external', { external: { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] } }],
  ] as const) {
    await ownerRun(dir, id)
    await patchFixture(id, patch)
    await send(id, 'excluded', [3])
  }
  assert.deepEqual((await deliveredMessages(dir, 'tg_1')).messages.map(m => m.text), ['included'])
  await writeFile(join(dir, 'runs', 'broken.json'), '{')
  assert.equal((await deliveredMessages(dir, 'tg_1')).messages.length, 1)
})

test('unauthorized callers and invalid arguments fail closed', async t => {
  const { dir, runs, patchFixture } = await fixture(t)
  for (const limit of [0, 51, NaN, 1.5]) await assert.rejects(deliveredMessages(dir, 'tg_1', { limit }), /Limit/)
  await assert.rejects(deliveredMessages(dir, 'tg_1', { messageId: -1 }), /Message ID/)
  await assert.rejects(deliveredMessages(dir, '../tg_1'), /identifier/)
  await assert.rejects(deliveredMessages(dir, 'missing'), /No active/)
  await ownerRun(dir, 'r_external', { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] })
  await assert.rejects(deliveredMessages(dir, 'r_external'), /blocked/)
  await patchFixture('tg_1', { telegramUserId: 202 })
  await assert.rejects(deliveredMessages(dir, 'tg_1'), /owner-mismatch/)
  await patchFixture('tg_1', { telegramUserId: 101, status: 'completed' })
  await assert.rejects(deliveredMessages(dir, 'tg_1'), /No active/)
  await runs.patch('tg_1', { status: 'running' })
  await new ControlStore(dir, 1000).revokeOwner()
  await assert.rejects(deliveredMessages(dir, 'tg_1'), /owner-mismatch/)
})

test('approval messages retain the content delivered to Telegram', async t => {
  const { dir, send } = await fixture(t)
  const file = await send('tg_1', 'placeholder', [20])
  const item = JSON.parse(await readFile(file, 'utf8'))
  delete item.text
  item.type = 'approval'
  item.approvalPrompt = 'Approve this messaging task?'
  await writeFile(file, JSON.stringify(item))
  assert.equal((await deliveredMessages(dir, 'tg_1')).messages[0].text, item.approvalPrompt)
})

test('CLI flushes complete long reports and rejects send options in history mode', async t => {
  const { dir, send } = await fixture(t)
  const text = 'Report evidence. '.repeat(8000)
  await send('tg_1', text, [30])
  const env = { ...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: 'tg_1' }
  const cli = [ 'bin/ezenciel-agents-message.mjs', 'history' ]
  const { stdout } = await promisify(execFile)(process.execPath, cli, { env })
  assert.equal(JSON.parse(stdout).messages[0].text, text)
  const before = await readdir(join(dir, 'outbox'))
  await assert.rejects(promisify(execFile)(process.execPath, [...cli, '--text', 'do not send'], { env }), /Unknown option/)
  assert.deepEqual(await readdir(join(dir, 'outbox')), before)
})
