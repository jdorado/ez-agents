import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Update } from 'grammy/types'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { ApprovalStore } from '../src/approval.js'
import { initialPreset } from '../src/ai.js'

const message = (userId = 101, group = false): Update => ({
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    text: 'hello',
    from: { id: userId, is_bot: false, first_name: 'Fixture' },
    chat: group
      ? { id: -101, type: 'group', title: 'Fixture' }
      : { id: userId, type: 'private', first_name: 'Fixture' },
  },
})

const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for relay')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('owner stop terminates the writer and starts queued work without overlap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-stop-'))
  const children: ReturnType<typeof spawn>[] = []
  const relay = createRelay(
    {
      controlDir: dir,
      workspace: dir,
      pairingTtlMs: 1000,
      executorTimeoutMs: 1000,
      executorCli: 'grok',
      telegramBotToken: 'fixture',
    },
    async () => {
      assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null))
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32',
      })
      await once(child, 'spawn')
      children.push(child)
      return { child, cleanup: async () => {}, stdout: '' }
    },
  )
  relay.bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'Fixture',
    username: 'fixture_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  }
  relay.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  try {
    const control = new ControlStore(dir, 1000)
    await control.requestPairing(101, 101)
    await control.approveOwner(101)
    await relay.bot.handleUpdate(message())
    await until(async () => children.length === 1)
    const runs = new RunStore(dir)
    await runs.create({ chatId: 101, telegramUserId: 101, texts: ['queued follow-up'],
      execution: await control.captureChoice(initialPreset('grok')) })
    const stop = message()
    stop.message!.text = '/stop'
    await relay.bot.handleUpdate(stop)
    await until(async () => children.length === 2)
    assert.equal((await runs.list()).filter((run) => run.status === 'failed').length, 1)
    await relay.stop()
    await until(async () => children[1].signalCode !== null)
    await until(async () => (await runs.list()).every((run) => run.status !== 'running'))
  } finally {
    await relay.stop()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('real Telegram handlers never launch for first DM, another sender, group, or forged callback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-handler-'))
  let launched = 0
  const relay = createRelay(
    {
      controlDir: dir,
      workspace: dir,
      pairingTtlMs: 1000,
      executorTimeoutMs: 1000,
      executorCli: 'grok',
      telegramBotToken: 'fixture',
    },
    async () => {
      launched++
      throw new Error('Executor must not start')
    },
  )
  const calls: string[] = []
  relay.bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'Fixture',
    username: 'fixture_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  }
  relay.bot.api.config.use(async (_previous, method) => {
    calls.push(method)
    return { ok: true, result: true } as never
  })
  try {
    await relay.bot.handleUpdate(message())
    const control = new ControlStore(dir, 1000)
    assert.equal((await control.status()).owner, null)
    assert.equal(launched, 0)
    await control.approveOwner(101)
    calls.length = 0
    await relay.bot.handleUpdate(message(202))
    await relay.bot.handleUpdate(message(202, true))
    assert.deepEqual(calls, [])
    const original = message(101).message!
    await relay.bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'test',
        chat_instance: 'fixture',
        from: { id: 202, first_name: 'Intruder', is_bot: false },
        message: original,
        data: 'menu:new',
      },
    })
    assert.equal(await control.getActiveSession(), null)
    const runs = new RunStore(dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['test approval'] })
    const approvals = new ApprovalStore(dir)
    await approvals.requestApproval('test_action', 'Harmless smoke test?', run.id)
    await relay.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'forged',
        chat_instance: 'fixture',
        from: { id: 202, first_name: 'Intruder', is_bot: false },
        message: original,
        data: 'approval:test_action:approve',
      },
    })
    assert.equal((await approvals.getDecision('test_action'))?.decision, 'pending')
    await new Promise((resolve) => setTimeout(resolve, 2100))
    assert.equal(launched, 0)
  } finally {
    await relay.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed delivery is quarantined and never blindly retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-failure-'))
  const relay = createRelay({
    controlDir: dir,
    workspace: dir,
    pairingTtlMs: 1000,
    executorTimeoutMs: 1000,
    executorCli: 'grok',
    telegramBotToken: 'fixture',
  })
  let sends = 0
  relay.bot.api.config.use(async () => {
    sends++
    throw new Error('Ambiguous network failure')
  })
  try {
    const control = new ControlStore(dir, 1000)
    await control.requestPairing(101, 101)
    await control.approveOwner(101)
    const runs = new RunStore(dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['hello'] })
    const item = await runs.enqueueMessage(run.id, 'Hello')
    await relay.drainOutbox()
    await relay.drainOutbox()
    assert.equal(sends, 1)
    await assert.rejects(runs.waitForDelivery(item.id), /Ambiguous network failure/)
    assert.deepEqual(await runs.deliveryStatus(), { failed: 0, unknown: 1 })
    await assert.rejects(runs.waitForDelivery('missing', 1), /outcome unknown/)
    assert.equal(
      (await readdir(join(dir, 'outbox'))).filter((name) => name.endsWith('.failed.json')).length,
      1,
    )
  } finally {
    await relay.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('outbox stores provider receipts and does not redeliver sent messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-'))
  const relay = createRelay({
    controlDir: dir,
    workspace: dir,
    pairingTtlMs: 1000,
    executorTimeoutMs: 1000,
    executorCli: 'grok',
    telegramBotToken: 'fixture',
  })
  let sends = 0
  relay.bot.api.config.use(async (_previous, method) => {
    assert.equal(method, 'sendMessage')
    sends++
    return { ok: true, result: { message_id: 42 } } as never
  })
  try {
    const control = new ControlStore(dir, 1000)
    await control.requestPairing(101, 101)
    await control.approveOwner(101)
    const runs = new RunStore(dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['hello'] })
    const item = await runs.enqueueMessage(run.id, '**Hello** <world>')
    await relay.drainOutbox()
    await relay.drainOutbox()
    assert.equal(sends, 1)
    assert.deepEqual(((await runs.waitForDelivery(item.id)) as { messageIds: number[] }).messageIds, [42])
    assert.deepEqual(await runs.pendingOutbox(), [])
    const sent = (await readdir(join(dir, 'outbox'))).find((name) => name.endsWith('.sent.json'))!
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'outbox', sent), 'utf8')).receipt.messageIds, [42])
  } finally {
    await relay.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
