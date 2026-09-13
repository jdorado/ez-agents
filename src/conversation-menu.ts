import { InlineKeyboard, type Context } from 'grammy'
import { ControlStore, sessionTitle } from './control-state.js'

// IDs identify existing relay bindings only; the engine still owns all context.
export const createConversationMenu = (control: ControlStore) => {
  const list = async (ctx: Context, archived = false, page = 0) => {
    const all = await control.listSessions()
    const sessions = all.filter(s => Boolean(s.archived) === archived)
    page = Math.min(page, Math.max(0, Math.ceil(sessions.length / 8) - 1))
    const active = await control.getActiveSession()
    const keyboard = new InlineKeyboard()
    for (const session of sessions.slice(page * 8, page * 8 + 8))
      keyboard.text(`${session.sessionId === active?.sessionId ? '✓ ' : ''}${sessionTitle(session)}`.slice(0, 64), `chat:open:${session.sessionId}`)
        .text(archived ? 'Restore' : 'Archive', `chat:${archived ? 'restore' : 'archive'}:${session.sessionId}`).row()
    if (page > 0) keyboard.text('Previous', `chat:list:${Number(archived)}:${page - 1}`)
    if ((page + 1) * 8 < sessions.length) keyboard.text('Next', `chat:list:${Number(archived)}:${page + 1}`)
    keyboard.row().text(archived ? 'Conversations' : 'Archived', `chat:list:${Number(!archived)}:0`)
      .text('New conversation', 'menu:new')
    await ctx.reply(archived ? 'Archived conversations' : 'Conversations\nSelect one to continue. Use /rename followed by a name to rename the current conversation.', { reply_markup: keyboard })
  }
  return {
    list,
    async handle(ctx: Context): Promise<boolean> {
      const data = ctx.callbackQuery?.data
      if (!data?.startsWith('chat:')) return false
      await ctx.answerCallbackQuery().catch(() => {})
      try {
        const page = /^chat:list:([01]):(\d{1,6})$/.exec(data)
        if (page) { await list(ctx, page[1] === '1', Number(page[2])); return true }
        const action = /^chat:(open|archive|restore):([0-9a-f-]{36})$/i.exec(data)
        if (!action) throw new Error('Conversation unavailable. Open /chats again.')
        const [, verb, id] = action
        const session = (await control.listSessions()).find(s => s.sessionId === id)
        if (!session) throw new Error('Conversation unavailable. Open /chats again.')
        if (verb === 'archive' || verb === 'restore') {
          await control.archiveSession(id, verb === 'archive')
          await ctx.reply(`${verb === 'archive' ? 'Archived' : 'Restored'}: ${sessionTitle(session)}${verb === 'archive' ? '\nExisting work keeps its conversation. Archiving does not stop it.' : ''}`)
          await list(ctx, verb === 'restore' ? false : true)
        } else if (session.archived) {
          await ctx.reply(sessionTitle(session), { reply_markup: new InlineKeyboard().text('Restore', `chat:restore:${id}`) })
        } else {
          await control.switchSession(id)
          await ctx.reply(`Current conversation: ${sessionTitle(session)}\nNew messages continue here. Queued work keeps its original conversation.`, {
            reply_markup: new InlineKeyboard().text('Archive', `chat:archive:${id}`).text('Conversations', 'chat:list:0:0'),
          })
        }
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : 'Conversation selection failed.')
      }
      return true
    },
  }
}
