import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Update } from 'grammy/types'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { InboxStore } from '../src/inbox.js'
import { ApprovalStore } from '../src/approval.js'
import { Tasks } from '../src/tasks.js'
import { ownerRun } from './helpers/owner-run.js'
import { packageVersion } from '../src/version.js'
import type { Config } from '../src/config.js'

const message = (id: number, text = 'hello'): Update => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    text,
    from: { id: 101, is_bot: false, first_name: 'Fixture' },
    chat: { id: 101, type: 'private', first_name: 'Fixture' },
  },
})
const fixture = async (overrides: Partial<Config> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-intake-relay-'))
  const launched: string[][] = []
  const replies: string[] = []
  const members = new Map<number, string>()
  const keyboards: { text: string; callback_data: string }[][][] = []
  const children: ReturnType<typeof spawn>[] = []
  const config = {
    controlDir: dir,
    workspace: dir,
    pairingTtlMs: 1000,
    executorTimeoutMs: 1000,
    executorCli: 'grok' as const,
    telegramBotToken: 'fixture',
    geminiApiKey: 'fixture',
    ...overrides,
  }
  const make = () => {
    const relay = createRelay(config, async (texts) => {
      launched.push(texts)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'])
      children.push(child)
      await once(child, 'spawn')
      return { child, cleanup: async () => {}, stdout: '' }
    })
    relay.bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: 'Fixture',
      username: 'fixture_bot',
    } as typeof relay.bot.botInfo
    relay.bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getChatMember' && members.get((payload as {user_id: number}).user_id) === 'error') throw new Error('Fixture membership unavailable')
      if (method === 'sendMessage') replies.push((payload as { text: string }).text)
      const keyboard = (payload as { reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] } }).reply_markup?.inline_keyboard
      if (keyboard) keyboards.push(keyboard)
      return {
        ok: true,
        result: method === 'getFile' ? { file_path: 'fixture.ogg' } : method === 'getChatMember' ? {status: members.get((payload as {user_id: number}).user_id) ?? 'member'} : { message_id: 42 },
      } as never
    })
    return relay
  }
  const control = new ControlStore(dir, 1000)
  await control.requestPairing(101, 101)
  await control.approveOwner(101)
  let relay = make()
  return {
    dir,
    launched,
    replies,
    members,
    keyboards,
    get relay() {
      return relay
    },
    async restart() {
      await relay.stop()
      relay = make()
    },
    async close() {
      await relay.stop()
      await relay.drainInbox()
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
      }
      // Completion bookkeeping runs asynchronously after the process close event.
      const runs = new RunStore(dir)
      for (let i = 0; i < 100 && (await runs.list()).some((r) => r.status === 'running'); i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('approved owner group accepts different members, controls and group delivery; rejects other chats and anonymous posts', async () => {
  const f = await fixture()
  const control = new ControlStore(f.dir, 900000)
  const group = (id: number, sender = 202, chatId = -101): Update => ({update_id: id, message: {
    message_id: id, date: 0, text: 'Hello', from: {id: sender, is_bot: false, first_name: 'Member'},
    chat: {id: chatId, type: 'supergroup', title: 'Team'},
  }})
  try {
    await control.revokeOwner()
    await f.relay.bot.handleUpdate(group(1))
    assert.equal(f.launched.length, 0)
    assert.equal((await control.status()).pending[0].title, 'Team')
    await control.approveOwner(-101, true)
    await f.relay.bot.handleUpdate(group(2, 303))
    await f.relay.bot.handleUpdate(group(3, 404))
    await f.relay.drainInbox(true)
    const run = (await new RunStore(f.dir).list())[0]
    assert.equal(run.chatId, -101)
    assert.equal(run.telegramUserId, 303)
    assert.equal(run.texts.length, 2)
    assert.match(run.texts[0], /303/)
    assert.match(run.texts[1], /404/)
    assert.equal(f.launched.length, 1)
    await new RunStore(f.dir).enqueueMessage(run.id, 'Group reply')
    await f.relay.drainOutbox()
    assert.ok(f.replies.includes('Group reply'))
    const approval = new ApprovalStore(f.dir)
    await approval.requestApproval('group_action', 'Approve this?', run.id)
    f.members.set(707, 'left')
    await f.relay.bot.handleUpdate({update_id: 12, callback_query: {
      id: 'outsider', chat_instance: 'test', from: {id: 707, is_bot: false, first_name: 'Outsider'},
      message: group(12).message!, data: 'approval:group_action:approve',
    }})
    assert.equal((await approval.getDecision('group_action'))?.decision, 'pending')
    f.members.set(707, 'error')
    await assert.rejects(f.relay.bot.handleUpdate({update_id: 13, callback_query: {
      id: 'unavailable', chat_instance: 'test', from: {id: 707, is_bot: false, first_name: 'Member'},
      message: group(13).message!, data: 'approval:group_action:approve',
    }}), /membership verification unavailable/)
    await f.relay.bot.handleUpdate({update_id: 4, callback_query: {
      id: 'callback', chat_instance: 'test', from: {id: 404, is_bot: false, first_name: 'Second'},
      message: group(4).message!, data: 'approval:group_action:approve',
    }})
    await f.relay.drainInbox(true)
    assert.equal((await approval.getDecision('group_action'))?.decidedBy, 404)
    await f.relay.bot.handleUpdate(group(5, 202, -102))
    await f.relay.bot.handleUpdate(message(6))
    const anonymous = group(7); anonymous.message!.sender_chat = anonymous.message!.chat
    await f.relay.bot.handleUpdate(anonymous)
    const bot = group(8); bot.message!.from!.is_bot = true
    await f.relay.bot.handleUpdate(bot)
    assert.equal((await new InboxStore(f.dir).status()).pending, 0)
    const status = group(9); status.message!.text = '/status'
    await f.relay.bot.handleUpdate(status)
    assert.ok(f.replies.some(text => text.includes('🟢 Ez is online')))
    assert.ok(f.replies.some(text => text.includes('Queue:')))
    // Seed the retry fixture only after the relay writer and its timer are idle.
    await f.relay.stop()
    await f.relay.drainInbox()
    const inbox = new InboxStore(f.dir)
    await inbox.accept(group(10, 505))
    const failed = await inbox.next(true)
    await inbox.finish(failed!.id, true)
    await f.relay.bot.handleUpdate({update_id: 11, callback_query: {
      id: 'retry', chat_instance: 'test', from: {id: 606, is_bot: false, first_name: 'Third'},
      message: group(11).message!, data: 'menu:retry',
    }})
    assert.equal(await inbox.pending(failed!.id), true)
    await inbox.cancel()
    await control.revokeOwner()
    await assert.rejects(new RunStore(f.dir).enqueueMessage('not_a_run', 'no'))
  } finally { await f.close() }
})

test('owner group discovery routes only to the private chat and rechecks identity', async () => {
  const f = await fixture()
  const group = (id: number, sender = 101): Update => ({update_id: id, message: {
    message_id: id, date: 0, text: 'Hi from the group',
    from: {id: sender, is_bot: false, first_name: 'Fixture'},
    chat: {id: -101, type: 'supergroup', title: 'Family'},
  }})
  try {
    await f.relay.bot.handleUpdate(group(1, 202))
    const anonymous = group(2)
    anonymous.message!.sender_chat = anonymous.message!.chat
    await f.relay.bot.handleUpdate(anonymous)
    assert.equal((await new InboxStore(f.dir).status()).pending, 0)
    await f.relay.bot.handleUpdate(group(3))
    await f.relay.drainInbox(true)
    const run = (await new RunStore(f.dir).list())[0]
    assert.equal(run.chatId, 101)
    assert.equal(run.messageId, undefined)
    assert.match(run.texts[0], /Reply privately/)
    assert.match(run.texts[0], /"chatId":-101/)
    assert.equal(f.launched.length, 1)
    await f.relay.bot.handleUpdate(group(4))
    await new ControlStore(f.dir, 1000).revokeOwner()
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 1)
  } finally { await f.close() }
})

test('three-item menu is owner-only and removes the retired settings control', async () => {
  const f = await fixture()
  const callback = (id: number, data: string, user = 101): Update => ({
    update_id: id,
    callback_query: { id: String(id), chat_instance: 'fixture', data,
      from: { id: user, first_name: 'Fixture', is_bot: false }, message: message(id).message! },
  })
  try {
    await f.relay.bot.handleUpdate(message(1, '/menu'))
    assert.deepEqual(f.keyboards.at(-1)!.flat().map((b) => b.text),
      ['New conversation', 'Choose AI', 'Work status'])
    await f.relay.bot.handleUpdate(message(2, '/settings'))
    assert.match(f.replies.at(-1)!, /Settings was removed.*Use \/ai/)
    await f.relay.bot.handleUpdate(message(3, '/ai'))
    const pick = f.keyboards.at(-1)!.flat().find((button) => button.text === 'Refresh available AIs')!.callback_data
    const store = new ControlStore(f.dir, 1000)
    const before = await store.status()
    const keyboardCount = f.keyboards.length
    await f.relay.bot.handleUpdate(callback(4, pick, 202))
    assert.equal(f.keyboards.length, keyboardCount)
    assert.deepEqual(await store.status(), before)
    await f.relay.bot.handleUpdate(callback(5, 'ai:forged'))
    assert.match(f.replies.at(-1)!, /Menu expired/)
    assert.deepEqual(await store.status(), before)
    await f.relay.bot.handleUpdate(callback(6, pick))
    assert.equal(f.keyboards.length, keyboardCount + 1)
    const refreshed = await store.status()
    await f.relay.bot.handleUpdate(callback(7, pick))
    assert.match(f.replies.at(-1)!, /Menu expired/)
    assert.deepEqual(await store.status(), refreshed)
    await f.relay.bot.handleUpdate(message(8, '/status'))
    assert.ok(f.keyboards.at(-1)!.flat().some((button) => button.text === 'Scheduled tasks'))
    await f.relay.bot.handleUpdate(callback(9, 'menu:scheduled-tasks'))
    assert.match(f.replies.at(-1)!, /No scheduled tasks for this owner/)
    assert.equal(f.launched.length, 0)
  } finally { await f.close() }
})

test('application-backed channels keep AI and retired settings controls in the application', async () => {
  const f = await fixture({ channelBackendUrl: 'http://127.0.0.1:1', channelBackendToken: 'fixture' })
  try {
    const store = new ControlStore(f.dir, 1000)
    const before = await store.status()
    let id = 1
    for (const text of ['/ai', '/settings', '/new']) {
      await f.relay.bot.handleUpdate(message(id++, text))
      assert.match(f.replies.at(-1)!, /managed in the connected application/)
    }
    for (const data of ['menu:ai', 'menu:settings', 'menu:new', 'ai:old-button']) {
      await f.relay.bot.handleUpdate({ update_id: id, callback_query: {
        id: String(id), chat_instance: 'fixture', data,
        from: { id: 101, first_name: 'Fixture', is_bot: false }, message: message(id++).message!,
      } })
      assert.match(f.replies.at(-1)!, /managed in the connected application/)
    }
    assert.deepEqual(await store.status(), before)
    assert.equal(f.keyboards.length, 0)
    assert.equal(f.launched.length, 0)
  } finally { await f.close() }
})

test('new conversation leaves already accepted messages pinned to the old conversation', async () => {
  const f = await fixture()
  try {
    await f.relay.bot.handleUpdate(message(1, 'before'))
    const store = new ControlStore(f.dir, 1000)
    const first = (await store.getActiveSession())!.sessionId
    await f.relay.bot.handleUpdate(message(2, '/new'))
    await f.relay.bot.handleUpdate(message(3, 'after'))
    await f.relay.drainInbox(true)
    const runs = new RunStore(f.dir)
    assert.equal((await runs.get('tg_1'))!.execution!.sessionId, first)
    await f.relay.drainInbox(true)
    assert.notEqual((await runs.get('tg_3'))!.execution!.sessionId, first)
  } finally { await f.close() }
})

test('accepted DM survives relay restart and duplicate delivery creates exactly one run', async () => {
  const f = await fixture()
  try {
    await f.relay.bot.handleUpdate(message(1))
    assert.equal(f.launched.length, 0)
    await f.restart()
    await f.relay.bot.handleUpdate(message(1))
    await f.relay.drainInbox(true)
    assert.deepEqual(f.launched, [['hello']])
    await f.relay.bot.handleUpdate(message(1))
    await f.relay.drainInbox(true)
    assert.equal((await new RunStore(f.dir).list()).length, 1)
  } finally {
    await f.close()
  }
})

test('slow voice normalization preserves instruction order and leaves controls responsive', async () => {
  const f = await fixture()
  const originalFetch = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const downloading = new Promise<void>((resolve) => {
    entered = resolve
  })
  globalThis.fetch = async (input) => {
    if (String(input).includes('api.telegram.org/file/')) {
      entered()
      await gate
      return new Response('fixture audio')
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: 'Fixture voice transcript' }] } }] })
  }
  try {
    await f.relay.bot.handleUpdate(message(1, 'Use the following voice note'))
    const voice = message(2)
    delete voice.message!.text
    voice.message!.voice = { file_id: 'fixture', file_unique_id: 'fixture', duration: 2 }
    voice.message!.reply_to_message = {
      ...message(91, 'Quoted context').message!,
      reply_to_message: undefined,
    }
    await f.relay.bot.handleUpdate(voice)
    const processing = f.relay.drainInbox(true)
    await downloading
    await f.relay.bot.handleUpdate(message(3, '/status'))
    assert.ok(f.replies.some((text) => text.includes('2 incoming messages')))
    assert.ok(f.replies.some((text) => text.includes(`Relay: running · v${packageVersion}`)))
    await f.relay.bot.handleUpdate(message(4, 'Next instruction'))
    assert.equal(f.launched.length, 0)
    release()
    await processing
    assert.equal(f.launched[0][0], 'Use the following voice note')
    assert.match(f.launched[0][1], /Quoted context/)
    assert.match(f.launched[0][1], /Fixture voice transcript/)
    assert.equal(f.launched[0].length, 2)
    assert.equal((await new InboxStore(f.dir).status()).pending, 1)
  } finally {
    release()
    globalThis.fetch = originalFetch
    await f.close()
  }
})

test('cancel clears accepted and queued work, never spawns a cancelled run, and status exposes delivery uncertainty', async () => {
  const f = await fixture()
  try {
    const runs = new RunStore(f.dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['queued'] })
    const out = await runs.enqueueMessage(run.id, 'fixture delivery')
    await runs.claimOutbox(out.id)
    await f.relay.bot.handleUpdate(message(1))
    await f.relay.bot.handleUpdate(message(2, '/cancel'))
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 0)
    assert.equal((await runs.get(run.id))?.status, 'cancelled')
    await f.relay.bot.handleUpdate(message(3, '/status'))
    assert.match(f.replies.at(-1)!, /Queue: empty/)
    assert.match(f.replies.at(-1)!, /1 delivery is awaiting confirmation/)
  } finally {
    await f.close()
  }
})

test('replayed approval decision can recover its wake but a new callback cannot replay consent', async () => {
  const f = await fixture()
  try {
    const runs = new RunStore(f.dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['approval'] })
    await runs.patch(run.id, { status: 'completed' })
    const approvals = new ApprovalStore(f.dir)
    await approvals.requestApproval('fixture_action', 'Fixture?', run.id)
    const update: Update = {
      update_id: 11,
      callback_query: {
        id: 'fixture',
        chat_instance: 'fixture',
        from: message(1).message!.from!,
        message: message(1).message!,
        data: 'approval:fixture_action:approve',
      },
    }
    await f.relay.bot.handleUpdate(update)
    // Simulate crash after consent persisted, before its agent wake was created.
    await approvals.recordDecision('fixture_action', 'approved', 101, 11)
    await f.restart()
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 1)
    assert.match(f.launched[0][0], /approval_decision/)
    await assert.rejects(approvals.recordDecision('fixture_action', 'approved', 101, 12), /already decided/)
  } finally {
    await f.close()
  }
})

test('revoked owner intake never executes or recreates a pairing request on replay', async () => {
  const f = await fixture()
  try {
    await f.relay.bot.handleUpdate(message(1))
    const control = new ControlStore(f.dir, 1000)
    await control.revokeOwner()
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 0)
    assert.equal((await control.status()).owner, null)
    assert.deepEqual((await control.status()).pending, [])
    assert.deepEqual(f.replies, [])
  } finally {
    await f.close()
  }
})

test('cancelling during a download prevents dispatch even when normalization finishes', async () => {
  const f = await fixture()
  const originalFetch = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const downloading = new Promise<void>((resolve) => {
    entered = resolve
  })
  globalThis.fetch = async () => {
    entered()
    await gate
    return new Response('Fixture document')
  }
  try {
    const doc = message(1)
    delete doc.message!.text
    doc.message!.document = { file_id: 'fixture', file_unique_id: 'fixture', file_name: 'fixture.txt' }
    await f.relay.bot.handleUpdate(doc)
    const processing = f.relay.drainInbox(true)
    await downloading
    await f.relay.bot.handleUpdate(message(2, '/cancel'))
    release()
    await processing
    assert.equal(f.launched.length, 0)
    assert.equal((await new RunStore(f.dir).list()).length, 0)
    assert.equal((await new InboxStore(f.dir).status()).pending, 0)
  } finally {
    release()
    globalThis.fetch = originalFetch
    await f.close()
  }
})

test('media failure quarantines its instruction batch instead of executing incomplete context', async () => {
  const f = await fixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  try {
    await f.relay.bot.handleUpdate(message(1, 'Use the following attachment'))
    const doc = message(2)
    delete doc.message!.text
    doc.message!.document = { file_id: 'fixture', file_unique_id: 'fixture', file_name: 'fixture.txt' }
    await f.relay.bot.handleUpdate(doc)
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 0)
    assert.deepEqual(await new InboxStore(f.dir).status(), { pending: 0, failed: 1 })
    globalThis.fetch = async () => new Response('Recovered fixture document')
    await f.relay.bot.handleUpdate(message(3, '/retry'))
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 1)
    assert.equal(f.launched[0][0], 'Use the following attachment')
    assert.match(f.launched[0][1], /Attached document/)
    await f.relay.bot.handleUpdate(message(4, '/retry'))
    await f.relay.drainInbox(true)
    assert.equal(f.launched.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    await f.close()
  }
})


test('approved family messages enter restricted task runs, never the owner session', async()=>{
  const f=await fixture()
  const group=(id:number,sender=202):Update=>({update_id:id,message:{message_id:id,date:Math.ceil(Date.now()/1000),text:'hello Annie',from:{id:sender,is_bot:false,first_name:'Member'},chat:{id:-101,type:'group',title:'Family'}}})
  try {
    await f.relay.bot.handleUpdate(group(100)) // Registers transport, grants nothing.
    assert.equal(f.launched.length,0)
    await ownerRun(f.dir,'setup')
    const tasks=new Tasks(f.dir),runs=new RunStore(f.dir)
    const proposal=await tasks.ownerCall('setup','propose',{sourceId:'telegram',conversationId:'-101',purpose:'Family conversation',context:'Only group context',hours:24,waitForIncoming:true,untilRevoked:true}) as {id:string}
    await new ApprovalStore(f.dir).recordDecision(proposal.id,'approved',101)
    await tasks.decide(proposal.id)
    await runs.patch('setup',{status:'completed'})
    await f.relay.bot.handleUpdate(group(101))
    const anonymous=group(102);anonymous.message!.sender_chat=anonymous.message!.chat
    await f.relay.bot.handleUpdate(anonymous)
    const bot=group(103);bot.message!.from!.is_bot=true;await f.relay.bot.handleUpdate(bot)
    await new Promise(r=>setTimeout(r,3100))
    await f.relay.drainSources()
    const launched=(await runs.list()).filter(r=>r.taskId)
    assert.equal(launched.length,1)
    assert.equal(launched[0].taskId,proposal.id)
    assert.equal(launched[0].external!.eventIds.length,1)
    assert.equal(launched[0].external!.eventIds[0],'tg_n101_101')
    assert.equal(f.launched.length,1)
    assert.match(f.launched[0][0],/Member/)
    await tasks.ownerCall('setup','list',{}).then(()=>assert.fail('completed run cannot change grants'),()=>{})
  } finally {await f.close()}
})
