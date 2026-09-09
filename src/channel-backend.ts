import { readFile } from 'node:fs/promises'
import type { Config } from './config.js'
import type { RunRecord } from './runs.js'
import { workspaceFile } from './files.js'

// Application-owned jobs; no CLI state, provider credentials or business routing here.
export async function dispatchChannel(config: Config, run: RunRecord): Promise<string | null> {
  const url = new URL(config.channelBackendUrl!)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw new Error('Channel backend requires HTTPS (or loopback HTTP)')
  if (!config.channelBackendToken || url.username || url.password || url.search || url.hash)
    throw new Error('Channel backend requires a private token and plain endpoint URL')
  const items = []
  for (const item of run.items ?? []) {
    let attachment
    if (item.attachment) {
      const bytes = await readFile(await workspaceFile(config.workspace, item.attachment.path))
      if (bytes.length > 12 * 1024 * 1024) throw new Error('Channel attachment exceeds 12 MB')
      attachment = { type: item.attachment.type, data: bytes.toString('base64') }
    }
    items.push({ text: item.attachment ? (item.caption ?? '') : item.text,
      message_id: item.messageId, sent_at: item.sentAt, album_id: item.albumId, attachment })
  }
  if (!items.length) throw new Error('Channel run is missing normalized items')
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${config.channelBackendToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, event_id: run.id, channel: 'telegram',
      sender_id: String(run.telegramUserId), chat_id: String(run.chatId), items }),
  })
  if (!response.ok) {
    const error = new Error(`Channel backend HTTP ${response.status}`)
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))
      Object.assign(error, { permanent: true })
    throw error
  }
  const result = await response.json() as { status?: string; reply?: string }
  if (result.status === 'queued' || result.status === 'running') {
    // Yield to the durable relay queue; backend requests with the same ID only resume/poll.
    await new Promise(resolve => setTimeout(resolve, 4000))
    return null
  }
  if (!['complete', 'failed'].includes(result.status ?? '') || typeof result.reply !== 'string')
    throw new Error('Invalid channel backend response')
  return result.reply
}
