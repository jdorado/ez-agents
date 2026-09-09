import { readFileSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { executorEnvironment, executorInvocation } from '../src/executor.js'
import { parseEnv } from 'node:util'
import { writeFile, rm } from 'node:fs/promises'
import { loadConfig } from '../src/config.js'
import { recoverInterruptedRuns } from './recovery.js'
import { createRelay } from '../src/index.js'
import { packageVersion } from '../src/version.js'

// Provider errors can contain credential-bearing URLs; never dump error causes.
process.on('uncaughtException', (error) => {
  console.error(error.name + ': ' + error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]'))
  process.exit(1)
})

// Read and close the root-opened descriptor before any executor can start.
// Secrets never enter the initial process environment or a readable mount.
let privateEnv: NodeJS.ProcessEnv = {}
try { privateEnv = parseEnv(readFileSync(3, 'utf8')) } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EINVAL' && (error as NodeJS.ErrnoException).code !== 'EBADF') throw error
} finally { try { closeSync(3) } catch {} }
for (const [key, value] of Object.entries(privateEnv)) {
  if (value !== undefined && ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'EZ_CHANNEL_BACKEND_TOKEN'].includes(key)) process.env[key] = value
}
privateEnv = {}
const [command = 'start', ...args] = process.argv.slice(2)
process.argv = [process.argv[0], '', ...args]
if (['start', 'smoke'].includes(command)) await recoverInterruptedRuns(loadConfig().controlDir, Boolean(loadConfig().channelBackendUrl))
if (command === 'start') {
  const relay = createRelay(loadConfig())
  const heartbeat = '/state/control/heartbeat.json'
  await rm(heartbeat, { force: true })
  const timer = setInterval(() => {
    if (relay.bot.isRunning()) void writeFile(heartbeat, JSON.stringify({ at: Date.now(), polling: true, version: packageVersion }), { mode: 0o600 })
  }, 5000)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { clearInterval(timer); void relay.stop() })
  try { await relay.start() } finally { clearInterval(timer); await rm(heartbeat, { force: true }) }
} else if (command === 'smoke') {
  await import('../scripts/smoke.js')
} else if (command === 'exec') {
  if (!args.length) throw new Error('exec requires a command')
  const invocation = executorInvocation(args[0], args.slice(1))
  const child = spawn(invocation.command, invocation.args, { stdio: 'inherit', env: executorEnvironment() })
  child.on('error', () => { console.error('Command could not start'); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal))
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} else if (command === 'setup') {
  await (await import('../src/setup.js')).runCli()
} else if (['owner', 'source', 'message', 'react'].includes(command)) {
  await import(`../src/${command === 'source' ? 'source-cli' : command}.js`)
} else throw new Error('Use start, smoke, exec, setup, owner, source, message or react')
