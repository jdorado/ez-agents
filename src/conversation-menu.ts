import { InlineKeyboard, type Context } from 'grammy'
import { ControlStore, sessionTitle } from './control-state.js'
import type { RunStore } from './runs.js'

// IDs identify existing relay bindings only; the engine still owns all context.
export const createConversationMenu = (control: ControlStore, runs: Pick<RunStore, 'list'>) => {
  const sessionsWithNames = async () => {
    const sessions = await control.listSessions()
    if (sessions.every(s => s.title)) return sessions
    // Display existing owner input only. Do not create another history store or
    // ask an engine to generate titles just to render a menu. Commands and JSON
    // event records (including approval callbacks) are not readable chat names.
    const history = await runs.list()
    return sessions.map((session, index) => {
      if (session.title) return session
      const first = history.find(run => run.execution?.sessionId === session.sessionId &&
        run.messageId && !run.taskId && !run.scheduled && !run.external && !run.replyOnly &&
        run.texts[0]?.trim() && !/^[/{]/.test(run.texts[0].trim()))
      const title = first
        ? `${first.texts[0].replace(/\s+/g, ' ').trim().slice(0, 40)} · ${first.createdAt.slice(0, 16).replace('T', ' ')} UTC`
        : session.hasStarted ? `Untitled conversation ${index + 1}` : 'New conversation'
      return { ...session, title }
    })
  }
  const list = async (ctx: Context, archived = false, page = 0) => {
    const all = await sessionsWithNames()
    const sessions = all.filter(s => Boolean(s.archived) === archived)
    page = Math.min(page, Math.max(0, Math.ceil(sessions.length / 8) - 1))
    const active = await control.getActiveSession()
    const keyboard = new InlineKeyboard()
    for (const session of sessions.slice(page * 8, page * 8 + 8))
      keyboard.text(`${session.sessionId === active?.sessionId ? '✓ ' : ''}${sessionTitle(session)}`.slice(0, 64), `chat:open:${session.sessionId}`).row()
    if (page > 0) keyboard.text('Previous', `chat:list:${Number(archived)}:${page - 1}`)
    if ((page + 1) * 8 < sessions.length) keyboard.text('Next', `chat:list:${Number(archived)}:${page + 1}`)
    keyboard.row().text(archived ? 'Conversations' : 'Archived conversations', `chat:list:${Number(!archived)}:0`)
      .text('New conversation', 'menu:new')
    await ctx.reply(archived ? 'Archived conversations' : 'Conversations\nSelect a name to continue.', { reply_markup: keyboard })
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
        const session = (await sessionsWithNames()).find(s => s.sessionId === id)
        if (!session) throw new Error('Conversation unavailable. Open /chats again.')
        if (verb === 'archive' || verb === 'restore') {
          await control.archiveSession(id, verb === 'archive')
          await ctx.reply(`${verb === 'archive' ? 'Archived' : 'Restored'}: ${sessionTitle(session)}${verb === 'archive' ? '\nExisting work keeps its conversation. Archiving does not stop it.' : ''}`)
          await list(ctx, verb === 'restore' ? false : true)
        } else if (session.archived) {
          await ctx.reply(sessionTitle(session), { reply_markup: new InlineKeyboard().text('Restore conversation', `chat:restore:${id}`).row().text('Back', 'chat:list:1:0') })
        } else {
          const keyboard = new InlineKeyboard().text('Archive this conversation', `chat:archive:${id}`).row()
            .text('Back to conversations', 'chat:list:0:0')
          try { await control.switchSession(id) }
          catch (error) {
            // Even an older session that cannot resume can still be archived.
            await ctx.reply(`${sessionTitle(session)}\n${error instanceof Error ? error.message : 'Unable to continue.'}`, { reply_markup: keyboard })
            return true
          }
          await ctx.reply(`Current conversation: ${sessionTitle(session)}\nSend a message to continue. To rename it, use /rename followed by a name.`, { reply_markup: keyboard })
        }
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : 'Conversation selection failed.')
      }
      return true
    },
  }
}
