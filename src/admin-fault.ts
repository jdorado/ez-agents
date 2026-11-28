import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { assertId } from './identity.js'
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

// A fault is never caller text: it is rendered from the relay's own plugin-invocation receipt
// (control/plugin-receipts/<run>/<receipt>.json, written by the broker after every invocation).
// The run names the receipt; tool, exit code and status class come from the record. A receipt that
// does not exist for this run, or records a completed invocation, is refused.
export type AdminFault = { receipt: string; tool: string; code: string; class: string }

export const adminFaultFromReceipt = async (controlDir: string, runId: string, receipt: unknown): Promise<AdminFault> => {
  if (typeof receipt !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt)) throw new Error('Fault receipt must be the relay receipt ID of a failed plugin invocation')
  let record: { kind?: unknown; receiptId?: unknown; runId?: unknown; alias?: unknown; status?: unknown; exitCode?: unknown }
  try { record = JSON.parse(await readFile(path.join(controlDir, 'plugin-receipts', assertId(runId), `${receipt}.json`), 'utf8')) }
  catch { throw new Error('No relay receipt for this run and ID') }
  const { alias, status, exitCode } = record
  if (record.kind !== 'plugin-invocation' || record.receiptId !== receipt || record.runId !== runId || typeof alias !== 'string' || typeof status !== 'string' || !Number.isSafeInteger(exitCode))
    throw new Error('No relay receipt for this run and ID')
  if (status === 'completed') throw new Error('That invocation did not fail; there is no fault to report')
  return { receipt, tool: alias.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64), code: String(exitCode), class: status.replace(/[^a-z-]/g, '').slice(0, 32) }
}

// The relay's own message: every field comes from the recorded receipt, none from the caller.
export const renderAdminFault = (channel: AdminChannel, fault: AdminFault, runId: string) =>
  `[ez ${channel.name}] fault: tool=${fault.tool} code=${fault.code} class=${fault.class} receipt=${fault.receipt} run=${runId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)}`

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
  const line = (delivered: boolean) => log('admin fault', { run_id: runId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64), tool: fault.tool, code: fault.code, class: fault.class, receipt: fault.receipt, delivered })
  try {
    const result = await send(channel, fault, runId)
    line(true)
    return result
  } catch (error) {
    line(false)
    throw error
  }
}
