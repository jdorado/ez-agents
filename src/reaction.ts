export const TELEGRAM_REACTIONS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂',
  '🤷', '🤷‍♀', '😡',
] as const

export type TelegramReactionEmoji = (typeof TELEGRAM_REACTIONS)[number]

const VALID_SET = new Set<string>(TELEGRAM_REACTIONS)

/**
 * Normalizes an emoji for Telegram setMessageReaction.
 * Removes variation selector 16 (\uFE0F) and trims whitespace.
 * Returns the valid Telegram reaction emoji, or undefined if not supported.
 */
export const normalizeReactionEmoji = (input?: string | null): TelegramReactionEmoji | undefined => {
  if (!input) return undefined
  const cleaned = input.trim().replace(/\uFE0F/g, '')
  if (VALID_SET.has(cleaned)) {
    return cleaned as TelegramReactionEmoji
  }
  return undefined
}

export const isSupportedReactionEmoji = (input: string): boolean => {
  return normalizeReactionEmoji(input) !== undefined
}
