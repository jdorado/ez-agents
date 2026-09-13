import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, InlineKeyboard } from 'grammy'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { createConversationMenu } from '../src/conversation-menu.js'
import { initialPreset } from '../src/ai.js'

test('empty placeholders stay out of history and Back edits one panel without creating sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-empty-chats-'))
  try {
    const control = new ControlStore(dir, 1000)
    const runs = new RunStore(dir)
    const choice = await control.captureChoice(initialPreset('grok'), 'Client launch')
    await control.markSessionStarted(choice.sessionId)
    for (let n = 0; n < 3; n++) await control.resetSession()
    const menu = createConversationMenu(control, runs)
    let sent = 0, edited = 0, text = '', keyboard: InlineKeyboard
    const ctx = {
      callbackQuery: undefined,
      reply: async (value: string, options: {reply_markup: InlineKeyboard}) => { sent++; text = value; keyboard = options.reply_markup },
      editMessageText: async (value: string, options: {reply_markup: InlineKeyboard}) => { edited++; text = value; keyboard = options.reply_markup },
      answerCallbackQuery: async () => {},
    }
    await menu.list(ctx as unknown as Context)
    assert.equal(sent, 1)
    assert.deepEqual(keyboard!.inline_keyboard.flat().filter(b => 'callback_data' in b && b.callback_data.startsWith('chat:open:')).map(b => b.text), ['Client launch'])
    assert.equal(keyboard!.inline_keyboard.flat().filter(b => b.text.includes('New conversation')).length, 1)
    assert.ok(keyboard!.inline_keyboard.every(row => row.length))
    const click = async (data: string) => {
      await menu.handle({...ctx, callbackQuery:{data, message:{message_id:1}}} as unknown as Context)
    }
    await click(`chat:open:${choice.sessionId}`)
    const before = await control.status()
    for (let n = 0; n < 5; n++) { await click('chat:list:0:0'); await click(`chat:open:${choice.sessionId}`) }
    assert.deepEqual(await control.status(), before)
    assert.equal(sent, 1)
    assert.equal(edited, 11)
    await control.archiveSession(choice.sessionId, true)
    await click('chat:list:0:0')
    assert.match(text, /No active conversations/)
    assert.equal(keyboard!.inline_keyboard.flat().filter(b => 'callback_data' in b && b.callback_data.startsWith('chat:open:')).length, 0)
    // No underlying bindings were deleted: previously accepted work can still resolve them.
    assert.equal((await control.listSessions()).length, 4)
    assert.equal((await control.executionSession(choice)).sessionId, choice.sessionId)
    await click('chat:list:1:0')
    assert.ok(keyboard!.inline_keyboard.flat().some(b => b.text === 'Client launch'))
  } finally { await rm(dir, {recursive:true, force:true}) }
})

test('an identical Back edit does not send another message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-same-menu-'))
  try {
    let sent = 0
    const menu = createConversationMenu(new ControlStore(dir,1000),new RunStore(dir))
    await menu.handle({
      callbackQuery:{data:'chat:list:0:0',message:{message_id:1}},
      answerCallbackQuery:async()=>{},
      editMessageText:async()=>{throw {description:'Bad Request: message is not modified'}},
      reply:async()=>{sent++},
    } as unknown as Context)
    assert.equal(sent,0)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
