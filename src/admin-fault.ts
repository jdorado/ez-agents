// Operator-set admin destination for fault reports. The bot token, chat ID and
// agent name come from the relay's private env file, never from the agent
// workspace or the executor environment; the agent chooses text, never the
// recipient.
export type AdminChannel = { botToken: string; chatId: number; name: string }

export const adminChannel = (env: NodeJS.ProcessEnv = process.env): AdminChannel | undefined => {
  const botToken = env.EZ_ADMIN_TELEGRAM_BOT_TOKEN?.trim() || ''
  const chat = env.EZ_ADMIN_TELEGRAM_CHAT_ID?.trim() || ''
  const name = env.EZ_ADMIN_AGENT_NAME?.trim() || ''
  if (!botToken && !chat && !name) return undefined
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('EZ_ADMIN_TELEGRAM_BOT_TOKEN is missing or malformed')
  if (!/^-?\d{1,18}$/.test(chat) || Number(chat) === 0) throw new Error('EZ_ADMIN_TELEGRAM_CHAT_ID must be a Telegram chat ID')
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('EZ_ADMIN_AGENT_NAME must be 1-64 letters, digits, dot, dash or underscore')
  return { botToken, chatId: Number(chat), name }
}

const MAX_TEXT = 4000
const PROVIDER_TIMEOUT_MS = 15_000

// Plain text (no parse mode, so nothing to escape), one Telegram message. A send
// that fails or times out is reported as unconfirmed and never retried here.
export const sendAdminFault = async (channel: AdminChannel, text: string, fetchImpl: typeof fetch = fetch): Promise<{ delivered: true }> => {
  const prefix = `[ez ${channel.name}] fault: `
  const body = (prefix + text.trim()).slice(0, MAX_TEXT)
  let response: Response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel.chatId, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Admin delivery unconfirmed: request failed or timed out')
  }
  if (!response.ok) throw new Error(`Admin delivery failed: Telegram HTTP ${response.status}`)
  return { delivered: true }
}
