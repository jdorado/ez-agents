import { readFile } from 'node:fs/promises'
import { arch as relayArch, platform as relayPlatform } from 'node:os'
import path from 'node:path'
import { isolationTransport } from './isolation.js'
import { relayVersionLabel } from './version.js'

export const installedPluginVersions = async (toolsHome?: string) => {
  if (!toolsHome) return null
  try {
    const registry = JSON.parse(await readFile(path.join(toolsHome, 'registry.json'), 'utf8')) as {plugins: Record<string, {manifest: {id: string; version: string}}>}
    return Object.values(registry.plugins).map(record => ({ id: record.manifest.id, version: record.manifest.version }))
  } catch { return null }
}

export const softwareStatus = async (controlDir: string, isolation?: string): Promise<string[]> => {
  const lines = [`Relay: running · ${relayVersionLabel()}`]
  let host: { version?: unknown; plugins?: unknown; platform?: unknown; arch?: unknown } | null = null
  try {
    const h = JSON.parse(await readFile(path.join(controlDir, 'host-executor/heartbeat.json'), 'utf8'))
    if (!Number.isFinite(h.at) || h.at > Date.now() + 5000 || Date.now() - h.at >= 15000) throw Error('Stale host')
    host = h
    lines.push(`Env: ${envLabel(host, isolation)}`)
    lines.push(`Host transport: running · ${typeof h.version === 'string' ? `v${h.version}` : 'version unknown'}`)
    if (!Array.isArray(h.plugins)) lines.push('Plugins: unknown')
    else lines.push(`Plugins: ${h.plugins.length ? h.plugins.map((p: {id: string; version: string}) => `${p.id} ${p.version}`).join(', ') : 'none installed'}`)
  } catch {
    lines.push(`Env: ${envLabel(host, isolation)}`)
    if (isolation === 'isolated') {
      lines.push('Host transport: n/a · isolated execution')
      lines.push((await brokerPlugins(controlDir)) ?? 'Plugins: isolated broker · versions via `ez tools list`')
    } else lines.push('Host transport: unavailable', 'Plugins: unknown')
  }
  return lines
}

const envLabel = (host: { platform?: unknown; arch?: unknown } | null, isolation?: string): string => {
  const rawPlatform = typeof host?.platform === 'string' && host.platform ? host.platform : relayPlatform()
  const rawArch = typeof host?.arch === 'string' && host.arch ? host.arch : relayArch()
  const where = rawPlatform === 'darwin' ? `mac (${rawPlatform}/${rawArch})` : `${rawPlatform}/${rawArch}`
  const mode = isolation ?? 'unknown'
  const transport = isolation === 'isolated' || isolation === 'host-capable' ? isolationTransport(isolation) : 'unknown'
  return `${where} · ${mode} · ${transport}`
}

const brokerPlugins = async (controlDir: string): Promise<string | null> => {
  try {
    const status = JSON.parse(await readFile(path.join(controlDir, 'plugin-broker-plugins.json'), 'utf8')) as {
      plugins?: { id: unknown; version: unknown }[]
    }
    if (!Array.isArray(status.plugins)) return null
    const entries = status.plugins.filter(p => typeof p?.id === 'string' && typeof p?.version === 'string')
    if (entries.length !== status.plugins.length) return null
    return `Plugins: ${entries.length ? entries.map(p => `${p.id} ${p.version}`).join(', ') : 'none installed'}`
  } catch { return null }
}
