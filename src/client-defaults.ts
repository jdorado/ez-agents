import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { installed, type AiPreset } from './ai.js'
import { executorEnvironment } from './executor.js'

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const value = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(v) ? v : undefined
const command = async (cli: string, args: string[], cwd: string): Promise<string> =>
  (await promisify(execFile)(cli, args, { cwd, env: executorEnvironment(), timeout: 8000, maxBuffer: 2 * 1024 * 1024 })).stdout

// Native config/read resolves Codex's layers; do not reimplement TOML or start a turn.
export const codexDefaults = (cwd: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
  const child = spawn('codex', ['app-server'], { cwd, env: executorEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout })
  let done = false
  const finish = (config: Record<string, unknown> = {}) => {
    if (done) return
    done = true
    clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); resolve(config)
  }
  const timer = setTimeout(() => finish(), 8000)
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  child.on('error', () => finish())
  child.stdin.on('error', () => finish())
  child.on('close', () => finish())
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.id === 0 && message.result) {
        send({ method: 'initialized', params: {} })
        send({ id: 1, method: 'config/read', params: { includeLayers: false, cwd } })
      } else if (message.id === 1) {
        const config = record(message.result?.config)
        const managed = record(record(config.models).new_thread)
        finish({ model: managed.model ?? config.model,
          effort: managed.model_reasoning_effort ?? config.model_reasoning_effort })
      }
    } catch { finish() }
  })
  send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'ez_defaults', version: '1' } } })
})

// Only the two simple, documented Grok [models] strings are read. Unsupported
// syntax stays unspecified so the native client resolves it, rather than guessing.
export const grokSettings = (text: string): { model?: string; effort?: string } => {
  const section = (text.split(/^\[models\][ \t]*\r?$/m)[1] || '').split(/^\[/m)[0]
  const get = (key: string) => value(section.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\r\\n]+)["']\\s*(?:#.*)?$`, 'm'))?.[1])
  return { model: get('default'), effort: get('default_reasoning_effort') }
}

export const discoverDefaults = async (cwd: string, options: {
  home?: string; available?: typeof installed; run?: typeof command; codex?: typeof codexDefaults
} = {}): Promise<AiPreset[]> => {
  const home = options.home ?? homedir()
  const available = options.available ?? installed
  const run = options.run ?? command
  const text = async (file: string) => { try { return await readFile(file, 'utf8') } catch { return '' } }
  const json = async (file: string) => { try { return record(JSON.parse(await text(file))) } catch { return {} } }
  const clients = ['grok', 'codex', 'claude', 'opencode']
  const results = await Promise.all(clients.map(async (cli): Promise<AiPreset | undefined> => {
    if (!(await available(cli))) return
    let model: string | undefined, effort: string | undefined
    try {
      if (cli === 'grok') {
        const settings = grokSettings(await text(join(home, '.grok/config.toml')))
        model = settings.model ?? value((await run(cli, ['models'], cwd)).match(/^Default model:\s*(\S+)/m)?.[1])
        effort = settings.effort
      } else if (cli === 'codex') {
        const config = await (options.codex ?? codexDefaults)(cwd)
        model = value(config.model); effort = value(config.effort)
      } else if (cli === 'claude') {
        // Match Claude's documented user -> project -> local settings precedence.
        const settings = Object.assign({}, await json(join(home, '.claude/settings.json')),
          await json(join(cwd, '.claude/settings.json')), await json(join(cwd, '.claude/settings.local.json')))
        model = value(settings.model); effort = value(settings.effortLevel)
      } else if (cli === 'opencode') {
        const config = record(JSON.parse(await run(cli, ['debug', 'config'], cwd)))
        model = value(config.model)
      }
    } catch { /* Unavailable metadata: expose client default, never invent values. */ }
    const id = 'detected_' + createHash('sha256').update(JSON.stringify([cli, model, effort])).digest('hex').slice(0, 12)
    return { id, cli, model, effort,
      name: `${cli} · ${model || 'client default'}${effort ? ` · ${effort}` : ''}`.slice(0, 80) }
  }))
  const discovered = results.filter((p): p is AiPreset => Boolean(p))
  if (await available('codex-gui')) {
    const source = discovered.find((preset) => preset.cli === 'codex')
    const model = source?.model, effort = source?.effort
    const id = 'detected_' + createHash('sha256').update(JSON.stringify(['codex-gui', model, effort])).digest('hex').slice(0, 12)
    discovered.push({ id, cli: 'codex-gui', model, effort,
      name: `codex-gui · ${model || 'desktop'}${effort ? ` · ${effort}` : ''}`.slice(0, 80) })
  }
  return discovered
}
