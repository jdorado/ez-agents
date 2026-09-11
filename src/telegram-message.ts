// Shared Telegram formatting, pacing and definite parse-error fallback.
import { Api, GrammyError } from 'grammy'
import { markdownToTelegramHtml } from './format.js'

export function telegramMessages(api: Pick<Api, 'sendMessage' | 'editMessageText'>, pace: () => Promise<void>) {
  return {
    async send(chatId: number, text: string, options: Parameters<Api['sendMessage']>[2] = {}) {
      await pace()
      try {
        return await api.sendMessage(chatId, markdownToTelegramHtml(text), { ...options, parse_mode: 'HTML' })
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 400 || !error.description.includes('parse entities')) throw error
        // Telegram explicitly rejected the first request. Unknown delivery is never retried here.
        await pace()
        const { parse_mode: _, ...plain } = options
        return api.sendMessage(chatId, text, plain)
      }
    },
    async edit(chatId: number, messageId: number, text: string, options: Parameters<Api['editMessageText']>[3] = {}) {
      await pace()
      return api.editMessageText(chatId, messageId, markdownToTelegramHtml(text), { ...options, parse_mode: 'HTML' })
    },
  }
}

export function telegramPacer() {
  let queue = Promise.resolve()
  let next = 0
  return () => {
    const current = queue.then(async () => {
      const delay = next - Date.now()
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      next = Date.now() + 1000
    })
    queue = current.catch(() => {})
    return current
  }
}
