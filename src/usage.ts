import { execFile, spawn } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { authProfileStatus, installed, type AuthProfileStatus } from './ai.js'
import { claudeAuthEnvironment, cliHome, hostLoginScopes } from './auth-profile.js'
import { executorEnvironment, executorInvocation } from './executor.js'
import { escapeHtml } from './format.js'
import { quotaBlockedUntil, type SetupHealth } from './setup-fallback.js'

// Read-only owner view of each login's provider limits, asked of the native
// client on demand. Nothing is stored and Ez never copies or prints the
// credential: each client runs with its own bound home. Only percentages,
// clocks, scope names and short status words are projected, with an optional
// saved Claude or Codex email for a private owner chat.
export type UsageWindow = { label: string; usedPercent: number; resetsAt?: number; resetsText?: string }
export type UsageReaders = {
  codex: (home: string) => Promise<UsageWindow[]>
  codexEmail?: (home: string) => Promise<string | undefined>
  claude: (home: string, authProfile?: string) => Promise<UsageWindow[]>
}

class UsageError extends Error {}

const percent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined

const durationLabel = (minutes: unknown, fallback: string): string => {
  if (typeof minutes !== 'number' || !(minutes > 0)) return fallback
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

// Codex app-server `account/rateLimits/read`: primary and secondary windows,
// each with `usedPercent` and `resetsAt` (epoch seconds).
const codexWindows = (limits: any): UsageWindow[] => (['primary', 'secondary'] as const).flatMap(name => {
  const usedPercent = percent(limits?.[name]?.usedPercent)
  if (usedPercent === undefined) return []
  const resetsAt = limits[name].resetsAt
  return [{ label: durationLabel(limits[name].windowDurationMins, name), usedPercent, ...(typeof resetsAt === 'number' ? { resetsAt } : {}) }]
})

// One request to the home's `codex app-server`; the native client answers for
// its own login, so Ez never opens the credential file.
const codexRequest = (home: string, method: string, params: object, rejected: string, timeoutMs: number): Promise<any> => new Promise((resolve, reject) => {
  const { command, args } = executorInvocation('codex', ['app-server', '--stdio'])
  const child = spawn(command, args, { cwd: home, env: { ...executorEnvironment(), CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = '', settled = false
  const finish = (error?: UsageError, result?: unknown) => {
    if (settled) return
    settled = true; clearTimeout(timer); child.kill()
    error ? reject(error) : resolve(result)
  }
  const timer = setTimeout(() => finish(new UsageError('timed out')), timeoutMs)
  const send = (message: object) => child.stdin!.write(JSON.stringify(message) + '\n')
  child.on('error', () => finish(new UsageError('Codex unavailable')))
  child.stdin!.on('error', () => finish(new UsageError('Codex unavailable')))
  child.once('close', () => finish(new UsageError('Codex exited')))
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      if (!message || typeof message !== 'object' || message.method) continue
      if (message.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 2, method, params })
      } else if (message.id === 2) {
        if (message.error) finish(new UsageError(rejected))
        else finish(undefined, message.result)
      }
    }
  })
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ezenciel-agents', version: '1' } } })
})

export const readCodexLimits = async (home: string, timeoutMs = 10_000): Promise<UsageWindow[]> =>
  codexWindows((await codexRequest(home, 'account/rateLimits/read', {}, 'limits unavailable (not logged in?)', timeoutMs))?.rateLimits)

// `account/read` returns the email of a ChatGPT login; an API-key login has none.
export const readCodexEmail = async (home: string, timeoutMs = 10_000): Promise<string | undefined> => {
  const account = (await codexRequest(home, 'account/read', { refreshToken: false }, 'account unavailable', timeoutMs).catch(() => undefined))?.account
  return account?.type === 'chatgpt' ? cleanEmail(account.email) : undefined
}

// `claude -p /usage` is a local client command: no model turn, no tokens. It
// prints lines like "Current session: 15% used · resets Oct 31 at 11:50am
// (Asia/Dubai)"; the session window is the 5h one. Only those lines are read,
// and the free text in them is reduced to plain name and date characters.
const plain = (text: string): string => text.replace(/[^\w ,.:/()+-]/g, '')
const claudeWindows = (text: string): UsageWindow[] => text.split('\n').flatMap(line => {
  const match = line.match(/^Current (session|week)(?: \(([^)]{1,40})\))?: (\d{1,3}(?:\.\d+)?)% used(?: \S resets (.{1,60}))?$/)
  if (!match) return []
  const [, kind, scope, used, resets] = match
  return [{ label: kind === 'session' ? '5h' : `7d${scope ? ` ${plain(scope).replace(/^all models$/i, 'all')}` : ''}`, usedPercent: percent(Number(used))!, ...(resets ? { resetsText: plain(resets) } : {}) }]
})

// A long-lived setup token can only run models, so `/usage` has no limits for
// it. When the home also keeps its own browser login, ask with that login:
// limits belong to the account, and `/usage` runs no model turn.
export const readClaudeLimits = async (home: string, authProfile?: string, timeoutMs = 20_000): Promise<UsageWindow[]> => {
  const auth = await claudeAuthEnvironment(home, authProfile).catch(() => { throw new UsageError('login unreadable') })
  if (await lstat(join(home, '.credentials.json')).then(() => true, () => false)) delete auth.CLAUDE_CODE_OAUTH_TOKEN
  const { command, args } = executorInvocation('claude', ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'])
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: home, env: { ...executorEnvironment(), ...auth }, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new UsageError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Claude unavailable' : 'usage unavailable'))
      let result: any
      try { result = JSON.parse(String(stdout)) } catch {}
      if (typeof result?.result !== 'string' || result.is_error) return reject(new UsageError('usage unavailable'))
      resolve(claudeWindows(result.result))
    })
    child.stdin?.end()
  })
}

const defaultReaders: UsageReaders = { codex: readCodexLimits, codexEmail: readCodexEmail, claude: readClaudeLimits }

const cleanEmail = (email: unknown): string | undefined =>
  typeof email === 'string' && email.length <= 254 && email === email.trim() &&
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email) ? email : undefined

// A setup token carries no identity of its own, so a token profile shows the
// email its home last signed in with; the owner provisions the token for that
// same account, and the limits are read from that same login.
const savedClaudeEmail = async (home: string): Promise<string | undefined> => {
  try {
    return cleanEmail(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress)
  } catch {}
}

const remaining = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
// Reset times are UTC unless the provider supplies another zone.
const shortReset = (text: string): string => text.replace(/ at /, ' ').replace(/\s*\(UTC\)$/, '')

const windowLine = (window: UsageWindow, now: number): string => {
  const left = Math.round(100 - window.usedPercent)
  const reset = window.resetsAt !== undefined
    ? window.resetsAt * 1000 > now ? `in ${remaining(window.resetsAt * 1000 - now)}` : 'reset due'
    : window.resetsText ? shortReset(window.resetsText) : ''
  const label = window.label === '7d all' ? '7d' : window.label
  return escapeHtml(`${label} · ${left}%${reset ? ` · ${reset}` : ''}`)
}

// Worst first: blocked or under 20%, logged out, unavailable, under 50%, ok.
const STATUS_ICONS = ['🔴', '🟠', '⚪', '🟡', '🟢']

export const usageReport = async (controlDir: string, health: SetupHealth = {},
  deps: { readers?: UsageReaders; available?: (cli: string) => Promise<boolean>; statuses?: () => Promise<AuthProfileStatus[]>
    now?: number; showAccountEmails?: boolean } = {}): Promise<string> => {
  const readers = deps.readers ?? defaultReaders, now = deps.now ?? Date.now()
  const hostLogins = await hostLoginScopes(controlDir)
  const available = deps.available ?? installed
  const statuses = await (deps.statuses ?? (() => authProfileStatus(controlDir, async cli => hostLogins.includes(cli) || await available(cli))))()
  const all = statuses.map(status => {
    const scope = status.authProfile ? `${status.cli}@${status.authProfile}` : status.cli
    return { ...status, scope, hostOnly: !status.credentialFiles.length && hostLogins.includes(scope) }
  })
  const visible = all.filter(status => status.authProfile || status.credentialFiles.length || status.hostOnly)
  if (!visible.length) return 'No Codex or Claude login is configured.'
  const sections = await Promise.all(visible.map(async ({ cli, authProfile: profile, credentialFiles, loggedIn, scope, hostOnly }) => {
    const authProfile = profile ?? undefined
    const home = cliHome(controlDir, cli, authProfile)
    const token = credentialFiles.includes('oauth-token')
    const email = !deps.showAccountEmails || hostOnly ? undefined : cli === 'claude' ? await savedClaudeEmail(home) : await readers.codexEmail?.(home)
    const blockedUntil = quotaBlockedUntil(health[scope]), blocked = blockedUntil > now
    let windows: UsageWindow[] = [], note: string | undefined
    if (hostOnly) note = 'Signed in on host · quota unavailable'
    else if (loggedIn === false) note = 'Logged out'
    else try {
      windows = await (cli === 'codex' ? readers.codex(home) : readers.claude(home, authProfile))
      if (!windows.length) note = 'Quota unavailable'
    } catch {
      note = 'Quota unavailable'
    }
    const left = Math.min(...windows.map(window => Math.round(100 - window.usedPercent)))
    const rank = blocked || left < 20 ? 0 : loggedIn === false && !hostOnly ? 1 : !windows.length ? 2 : left < 50 ? 3 : 4
    const icon = STATUS_ICONS[rank]
    const profileLabel = token ? authProfile ?? cli : scope
    const heading = `<b>${icon} ${escapeHtml(email ?? scope)}</b>`
    const profileName = email ? ` · <code>${escapeHtml(profileLabel)}</code>` : ''
    const source = token && (email || windows.length) ? ' · <i>browser</i>' : ''
    const lines = [heading + profileName + source]
    const block = !blocked ? undefined : Number.isFinite(blockedUntil)
      ? `Blocked for ${remaining(blockedUntil - now)}`
      : 'Blocked · awaiting /retry_quota'
    const status = [block, note].filter(Boolean).join(' · ')
    if (status) lines.push(escapeHtml(status))
    lines.push(...windows.map(window => windowLine(window, now)))
    return { rank, html: lines.join('\n') }
  }))
  sections.sort((first, second) => first.rank - second.rank)
  let report = '<b>Usage</b> · % left · resets UTC'
  for (const section of sections) {
    // Telegram rejects replies over 4096 characters. Drop whole account sections.
    if (report.length + section.html.length + 2 > 4000) { report += '\n\n…'; break }
    report += `\n\n${section.html}`
  }
  return report
}
