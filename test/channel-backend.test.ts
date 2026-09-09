import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchChannel } from '../src/channel-backend.js'
import { stageIncomingFile } from '../src/files.js'
import { RunStore } from '../src/runs.js'

const config = { telegramBotToken: 'never-forward-this', workspace: '', controlDir: '', pairingTtlMs: 10,
  executorTimeoutMs: 1000, executorCli: 'codex', channelBackendUrl: 'https://example.invalid/events', channelBackendToken: 'private' }

test('structured photo transport and deterministic reply recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-'))
  const originalFetch = globalThis.fetch
  try {
    const file = await stageIncomingFile(root, 'meal.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]))
    const store = new RunStore(root)
    const run = await store.create({ id: 'tg_1', chatId: 42, telegramUserId: 42, texts: [], items: [
      { text: 'internal path', caption: '', attachment: { path: file.relativePath, type: 'jpeg' },
        updateId: 1, chatId: 42, fromId: 42, messageId: 7, sentAt: 1234 }] })
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      assert.equal(body.items[0].text, '')
      assert.equal(body.items[0].attachment.data, '/9j/AQ==')
      assert.equal(body.sender_id, '42')
      assert.ok(!String(options?.body).includes('never-forward-this'))
      assert.ok(!String(options?.body).includes(file.relativePath))
      return new Response(JSON.stringify({ status: 'complete', reply: 'Meal saved' }))
    }
    assert.equal(await dispatchChannel({ ...config, workspace: root }, run), 'Meal saved')
    const a = await store.enqueueMessage(run.id, 'Meal saved', { id: 'tg_1_backend' })
    await store.claimOutbox(a.id)
    const b = await store.enqueueMessage(run.id, 'Meal saved', { id: 'tg_1_backend' })
    assert.equal(a.id, b.id)
    assert.equal((await store.pendingOutbox()).length, 0)
    await assert.rejects(dispatchChannel({ ...config, channelBackendUrl: 'http://example.invalid/events' }, run), /HTTPS/)
    run.items![0].attachment!.path = '../secret'
    await assert.rejects(dispatchChannel({ ...config, workspace: root }, run))
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})

test('backend dispatch keeps owner/private gate and never starts a CLI', async () => {
  const { createRelay } = await import('../src/index.js')
  const { ControlStore } = await import('../src/control-state.js')
  const { recoverInterruptedRuns } = await import('../docker/recovery.js')
  const root = await mkdtemp(join(tmpdir(), 'channel-gate-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  const relay = createRelay({ ...config, workspace: root, controlDir: root }, async () => { throw new Error('Must never launch CLI') })
  relay.bot.botInfo = { id: 999, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } as typeof relay.bot.botInfo
  relay.bot.api.config.use(async () => ({ ok: true, result: { message_id: 9 } }) as never)
  const control = new ControlStore(root, 1000)
  try {
    await control.requestPairing(42, 42); await control.approveOwner(42)
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ status: 'complete', reply: 'Done' })) }
    const update = (id: number, sender: number, group = false) => ({ update_id: id, message: {
      message_id: id, date: 1234, text: 'Hello', from: { id: sender, is_bot: false, first_name: 'Test' },
      chat: group ? { id: -42, type: 'group' as const, title: 'Group' } : { id: sender, type: 'private' as const, first_name: 'Test' } } })
    await relay.bot.handleUpdate(update(1, 43))
    await relay.bot.handleUpdate(update(2, 42, true))
    await relay.drainInbox(true)
    assert.equal(calls, 0)
    await relay.bot.handleUpdate(update(3, 42))
    await relay.drainInbox(true)
    for (let i = 0; i < 20 && !(await new RunStore(root).get('tg_3'))?.endedAt; i++)
      await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 1)
    const store = new RunStore(root)
    assert.equal((await store.get('tg_3'))?.status, 'completed')
    await store.patch('tg_3', { status: 'running' })
    await recoverInterruptedRuns(root, true)
    assert.equal((await store.get('tg_3'))?.status, 'queued')
    const cancel = update(4, 42); cancel.message.text = '/cancel'
    await relay.bot.handleUpdate(cancel)
    assert.equal((await store.get('tg_3'))?.status, 'queued', 'cancel must retain submitted operation polling')
  } finally { await relay.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})

test('backend mode cannot dispatch restricted, external, scheduled or update runs', async () => {
  const { createRelay } = await import('../src/index.js')
  const { ControlStore } = await import('../src/control-state.js')
  const root = await mkdtemp(join(tmpdir(), 'channel-authority-'))
  const originalFetch = globalThis.fetch
  let calls = 0, launches = 0
  const relay = createRelay({ ...config, workspace: root, controlDir: root }, async () => { launches++; throw new Error('No CLI fallback') })
  try {
    const control = new ControlStore(root, 1000)
    await control.requestPairing(42, 42); const owner = await control.approveOwner(42)
    globalThis.fetch = async () => { calls++; throw new Error('No application dispatch') }
    const runs = new RunStore(root), common = { chatId: 42, telegramUserId: 42, texts: ['Do not forward'] }
    await runs.create({ ...common, id: 'restricted', taskId: `task_${'a'.repeat(32)}` })
    await runs.create({ ...common, id: 'external', external: { sourceId: 'fixture', bindingId: 'binding', eventIds: ['1'] } })
    await runs.create({ ...common, id: 'scheduled', scheduled: { id: 's', revision: 'r', dueAt: new Date().toISOString(), pairedAt: owner.pairedAt } })
    await runs.create({ ...common, id: 'r_update_fixture' })
    await relay.drainSources()
    assert.equal(calls, 0); assert.equal(launches, 0)
    assert.ok((await runs.list()).every(run => run.status === 'failed'))
  } finally { await relay.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})
