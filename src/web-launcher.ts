import { mainCommands } from './menu.js'

export type WebLauncher = { command: string; label: string; url: string }

// Presentation only: the target authenticates its own requests.
export function parseWebLauncher(raw?: string): WebLauncher | undefined {
  if (!raw) return undefined
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['command', 'label', 'url'].includes(key)) ||
      typeof value.command !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value.command) ||
      [...mainCommands.map(c => c.command), 'help', 'menu', 'stop', 'cancel', 'retry', 'settings', 'start'].includes(value.command) ||
      typeof value.label !== 'string' || !value.label.trim() || value.label.length > 64 || /[\r\n\0]/.test(value.label) ||
      typeof value.url !== 'string') throw Error('Invalid Telegram web launcher')
  const url = new URL(value.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw Error('Telegram web launcher requires HTTPS without credentials, query or fragment')
  return { command: value.command, label: value.label, url: url.href }
}
