import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { packageVersion } from './version.js'

export const installedPluginVersions = async (toolsHome?: string) => {
  if (!toolsHome) return null
  try {
    const registry = JSON.parse(await readFile(path.join(toolsHome, 'registry.json'), 'utf8')) as {plugins: Record<string, {manifest: {id: string; version: string}}>}
    return Object.values(registry.plugins).map(record => ({ id: record.manifest.id, version: record.manifest.version }))
  } catch { return null }
}

export const softwareStatus = async (controlDir: string): Promise<string[]> => {
  const lines = [`Ez relay: ${packageVersion} (running)`]
  try {
    const h = JSON.parse(await readFile(path.join(controlDir, 'host-executor/heartbeat.json'), 'utf8'))
    if (!Number.isFinite(h.at) || h.at > Date.now() + 5000 || Date.now() - h.at >= 15000) throw Error('Stale host')
    lines.push(`Host transport: ${typeof h.version === 'string' ? h.version : 'version unknown'} (running)`)
    if (!Array.isArray(h.plugins)) lines.push('Plugins (installed): unknown')
    else lines.push(`Plugins (installed): ${h.plugins.length ? h.plugins.map((p: {id: string; version: string}) => `${p.id} ${p.version}`).join(', ') : 'none'}`)
  } catch { lines.push('Host transport: unavailable', 'Plugins (installed): unknown') }
  return lines
}
