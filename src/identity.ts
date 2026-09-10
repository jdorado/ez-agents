import type { Context } from 'grammy'
import type { Owner } from './control-state.js'

export const isOwner = (ctx: Pick<Context, 'from' | 'chat'>, owner: Owner | null): boolean =>
  Boolean(
    owner &&
      ctx.from &&
      !ctx.from.is_bot &&
      (owner.kind === 'group'
        ? ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
        : ctx.chat?.type === 'private' && ctx.from.id === owner.telegramUserId) &&
      ctx.chat?.id === owner.telegramChatId,
  )

export const ownsRun = (owner: Owner | null, run: {telegramUserId: number; chatId: number}): boolean =>
  Boolean(owner && Number.isSafeInteger(run.telegramUserId) && run.telegramUserId > 0 &&
    run.chatId === owner.telegramChatId && (owner.kind === 'group' || run.telegramUserId === owner.telegramUserId))

export const assertId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid record identifier')
  return id
}
