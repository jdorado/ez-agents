import { loadControlConfig } from './config.js'
import { normalizeReactionEmoji, TELEGRAM_REACTIONS } from './reaction.js'
import { callDeliverySocket, socketPathFor } from './delivery-socket.js'

const runId = process.env.EZ_RUN_ID?.trim()
const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: ezenciel-agents-react --emoji <emoji> (e.g. 👍, 👀, 🔥, ❤️, 🫡, 🎉)')
  process.exit(0)
}

const emojiFlag = args.findIndex((arg) => arg === '--emoji' || arg === '-e')
const candidate = emojiFlag >= 0 ? args[emojiFlag + 1]?.trim() : args[0]?.trim()
const rawEmoji = (candidate && !candidate.startsWith('-')) ? candidate : undefined

if (!runId) {
  console.error('EZ_RUN_ID is required')
  process.exit(1)
}
if (!rawEmoji) {
  console.error('Usage: ezenciel-agents-react --emoji <emoji> (e.g. 👍, 👀, 🔥, ❤️, 🫡, 🎉)')
  process.exit(1)
}

const emoji = normalizeReactionEmoji(rawEmoji)
if (!emoji) {
  console.error(`Invalid Telegram reaction emoji "${rawEmoji}". Telegram only supports standard reactions (e.g. ${TELEGRAM_REACTIONS.slice(0, 10).join(', ')}, etc.)`)
  process.exit(1)
}

const controlDir = loadControlConfig().controlDir
const item = await callDeliverySocket(socketPathFor(controlDir), {
  op: 'enqueue', payload: { kind: 'reaction', runId, emoji },
}) as { outbox_id: string; id: string; emoji?: string }
console.log(JSON.stringify({ ok: true, run: runId, outbox_id: item.id, emoji: item.emoji ?? emoji }))
