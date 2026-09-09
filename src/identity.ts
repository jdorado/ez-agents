import type { Context } from 'grammy'
import type { Owner } from './control-state.js'

export const isOwner = (ctx: Pick<Context, 'from' | 'chat'>, owner: Owner | null): boolean =>
  Boolean(
    owner &&
      ctx.from &&
      !ctx.from.is_bot &&
      ctx.chat?.type === 'private' &&
      ctx.from.id === owner.telegramUserId &&
      ctx.chat.id === owner.telegramChatId,
  )

export const assertId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid record identifier')
  return id
}
