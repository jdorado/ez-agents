import { RunStore } from './runs.js'

export type MessageCliArgs = {
  textFile?: string
  text?: string
  replyTo?: number
  document?: string
  voice?: string
}

export const parseMessageArgs = (argv: string[]): MessageCliArgs => {
  const args = argv.filter((arg) => arg !== '--')
  let textFile: string | undefined
  let text: string | undefined
  let replyTo: number | undefined
  let document: string | undefined
  let voice: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--text-file' && args[i + 1]) {
      textFile = args[++i]
    } else if (args[i] === '--text' && args[i + 1]) {
      text = args[++i].replace(/\\(\\|n)/g, (_, escape: string) => escape === 'n' ? '\n' : '\\')
    } else if (args[i] === '--reply-to' && args[i + 1]) {
      const parsed = parseInt(args[++i], 10)
      if (!Number.isNaN(parsed)) replyTo = parsed
    } else if ((args[i] === '--document' || args[i] === '--file') && args[i + 1]) {
      document = args[++i]
    } else if (args[i] === '--voice' && args[i + 1]) {
      voice = args[++i]
    }
  }
  const result: MessageCliArgs = { textFile }
  if (text !== undefined) result.text = text
  if (replyTo !== undefined) result.replyTo = replyTo
  if (document !== undefined) result.document = document
  if (voice !== undefined) result.voice = voice
  return result
}

export const sendRunText = async (store: RunStore, runId: string, text: string, options?: { replyTo?: number }) => {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Message text is empty')
  return store.enqueueMessage(runId, trimmed, { replyToMessageId: options?.replyTo })
}

export const sendRunDocument = async (store: RunStore, runId: string, filePath: string, caption?: string, options?: { replyTo?: number }) => {
  const trimmed = filePath.trim()
  if (!trimmed) throw new Error('Document path is empty')
  return store.enqueueDocument(runId, trimmed, { caption: caption?.trim(), replyToMessageId: options?.replyTo })
}

export const sendRunVoice = async (store: RunStore, runId: string, voiceText: string, options?: { replyTo?: number }) => {
  const trimmed = voiceText.trim()
  if (!trimmed) throw new Error('Voice text is empty')
  return store.enqueueVoice(runId, trimmed, { replyToMessageId: options?.replyTo })
}
