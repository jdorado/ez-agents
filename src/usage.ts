import { execFile, spawn } from 'node:child_process'
import { authHomes, installed } from './ai.js'
import { claudeAuthEnvironment, cliHome } from './auth-profile.js'
import { executorEnvironment, executorInvocation } from './executor.js'
import { quotaBlockedUntil, quotaScope, type SetupHealth } from './setup-fallback.js'

// Read-only owner view of each login's provider limits, asked of the native
// client on demand. Nothing is stored and Ez never touches the credential: each
// client runs with its own bound home. Only percentages, clocks and short status
// words are projected, never tokens, account identifiers or raw native output.
export type UsageWindow = { label: string; usedPercent: number; resetsAt?: number; resetsText?: string }
export type UsageReaders = {
  codex: (home: string) => Promise<UsageWindow[]>
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

export const readCodexLimits = (home: string, timeoutMs = 10_000): Promise<UsageWindow[]> => new Promise((resolve, reject) => {
  const { command, args } = executorInvocation('codex', ['app-server', '--stdio'])
  const child = spawn(command, args, { cwd: home, env: { ...executorEnvironment(), CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = '', settled = false
  const finish = (error?: UsageError, windows?: UsageWindow[]) => {
    if (settled) return
    settled = true; clearTimeout(timer); child.kill()
    error ? reject(error) : resolve(windows!)
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
      if (message.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 2, method: 'account/rateLimits/read', params: {} })
      } else if (message.id === 2) {
        if (message.error) finish(new UsageError('limits unavailable (not logged in?)'))
        else finish(undefined, codexWindows(message.result?.rateLimits))
      }
    }
  })
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ezenciel-agents', version: '1' }, capabilities: { experimentalApi: true } } })
})

// `claude -p /usage` is a local client command: no model turn, no tokens. It
// prints lines like "Current session: 15% used · resets Oct 31 at 11:50am
// (Asia/Dubai)"; the session window is the 5h one. Only those lines are read.
const claudeWindows = (text: string): UsageWindow[] => text.split('\n').flatMap(line => {
  const match = line.match(/^Current (session|week)(?: \(([^)]{1,40})\))?: (\d{1,3}(?:\.\d+)?)% used(?: \S resets (.{1,60}))?$/)
  if (!match) return []
  const [, kind, scope, used, resets] = match
  return [{ label: kind === 'session' ? '5h' : `7d${scope ? ` ${scope}` : ''}`, usedPercent: percent(Number(used))!, ...(resets ? { resetsText: resets } : {}) }]
})

export const readClaudeLimits = async (home: string, authProfile?: string, timeoutMs = 20_000): Promise<UsageWindow[]> => {
  const auth = await claudeAuthEnvironment(home, authProfile).catch(() => { throw new UsageError('login unreadable') })
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

const defaultReaders: UsageReaders = { codex: readCodexLimits, claude: readClaudeLimits }

const remaining = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}
const clock = (ms: number): string => { const iso = new Date(ms).toISOString(); return `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC` }
const resetNote = (ms: number, now: number): string => ms > now ? `resets in ${remaining(ms - now)} (${clock(ms)})` : 'reset due'

const windowLine = (window: UsageWindow, width: number, now: number): string => {
  const left = Math.round(100 - window.usedPercent), filled = Math.round(left / 10)
  return `  ${window.label.padEnd(width)} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${left}% left` +
    (window.resetsAt !== undefined ? ` · ${resetNote(window.resetsAt * 1000, now)}` : window.resetsText ? ` · resets ${window.resetsText}` : '')
}

export const usageReport = async (controlDir: string, health: SetupHealth = {},
  deps: { readers?: UsageReaders; available?: (cli: string) => Promise<boolean>; now?: number } = {}): Promise<string> => {
  const readers = deps.readers ?? defaultReaders, now = deps.now ?? Date.now()
  const homes = await authHomes(controlDir, deps.available ?? installed)
  if (!homes.length) return 'No Codex or Claude login is installed.'
  const sections = await Promise.all(homes.map(async ({ cli, authProfile }) => {
    const scope = quotaScope({ id: 'usage', name: 'usage', cli, ...(authProfile ? { authProfile } : {}) })
    const home = cliHome(controlDir, cli, authProfile)
    const lines = [scope]
    const blockedUntil = quotaBlockedUntil(health[scope])
    if (blockedUntil > now) lines.push(Number.isFinite(blockedUntil) ? `  ⛔ quota-blocked · ${resetNote(blockedUntil, now)}` : '  ⛔ quota-blocked · awaiting /retry_quota')
    try {
      const windows = await (cli === 'codex' ? readers.codex(home) : readers.claude(home, authProfile))
      const width = Math.max(0, ...windows.map(window => window.label.length))
      lines.push(...(windows.length ? windows.map(window => windowLine(window, width, now)) : ['  no limit data returned']))
    } catch (error) {
      lines.push(`  ${error instanceof UsageError ? error.message : 'unavailable'}`)
    }
    return lines.join('\n')
  }))
  return ['Account usage', '', ...sections.flatMap((section, index) => index ? ['', section] : [section])].join('\n')
}
