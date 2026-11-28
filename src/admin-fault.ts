// Operator-set admin destination for fault reports. The bot token, chat ID and
// agent name come from the relay's private env file, never from the agent
// workspace or the executor environment. The agent reports a bounded structured
// fault and never the recipient or the message text: the relay renders it.
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

const PROVIDER_TIMEOUT_MS = 15_000
const ERROR_MAX = 200

// What a run may report: the failing tool or command, an exit code or error class, a short error string.
// tool and code are validated tokens; the error string is reduced to printable ASCII and cut at ERROR_MAX.
export type AdminFault = { tool: string; code?: string; error?: string }

export const adminFaultReport = (input: { tool?: unknown; code?: unknown; error?: unknown }): AdminFault => {
  const { tool, code, error } = input
  if (typeof tool !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(tool)) throw new Error('Fault tool must be 1-64 letters, digits, dot, colon, dash or underscore')
  if (code !== undefined && (typeof code !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(code))) throw new Error('Fault code must be an exit code or error class of 1-32 letters, digits, dot, dash or underscore')
  if (error !== undefined && typeof error !== 'string') throw new Error('Fault error must be text')
  const short = (error ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/ +/g, ' ').trim().slice(0, ERROR_MAX)
  return { tool, ...(code === undefined ? {} : { code }), ...(short ? { error: short } : {}) }
}

// The relay's own message: nothing the caller sent appears outside these fields.
export const renderAdminFault = (channel: AdminChannel, fault: AdminFault, runId: string) =>
  `[ez ${channel.name}] fault: tool=${fault.tool}${fault.code === undefined ? '' : ` code=${fault.code}`} run=${runId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)}` +
  (fault.error ? `\nerror: ${fault.error}` : '')

// Plain text (no parse mode, so nothing to escape), one Telegram message. A send
// that fails or times out is reported as unconfirmed and never retried here.
export const sendAdminFault = async (channel: AdminChannel, fault: AdminFault, runId: string, fetchImpl: typeof fetch = fetch): Promise<{ delivered: true }> => {
  let response: Response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel.chatId, text: renderAdminFault(channel, fault, runId), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Admin delivery unconfirmed: request failed or timed out')
  }
  if (!response.ok) throw new Error(`Admin delivery failed: Telegram HTTP ${response.status}`)
  return { delivered: true }
}

// The relay hook: sends the fault and writes one structured line to the relay's own log whatever the outcome, so the
// record does not depend on Telegram. delivered is true only when Telegram answered ok; a failed or timed-out send is
// false and the error is rethrown unchanged.
export const reportAdminFault = async (
  channel: AdminChannel, fault: AdminFault, runId: string,
  send: typeof sendAdminFault = sendAdminFault, log: (message: string, fields: object) => void = console.info,
) => {
  const line = (delivered: boolean) => log('admin fault', { run_id: runId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64), tool: fault.tool, ...(fault.code === undefined ? {} : { code: fault.code }), delivered })
  try {
    const result = await send(channel, fault, runId)
    line(true)
    return result
  } catch (error) {
    line(false)
    throw error
  }
}
