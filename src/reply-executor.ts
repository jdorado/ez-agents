import { assertId } from './identity.js'
import { mkdtemp, mkdir, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { executorEnvironment, terminateJob, type ExecutorOptions } from './executor.js'
import { taskArguments, taskModelCatalog } from './task-executor.js'
import { requireOwnerExecution } from './execution-authority.js'

export function replyDeadline(child: ChildProcess, milliseconds = 60000) {
  const timer = setTimeout(() => terminateJob(child), milliseconds)
  child.once('close', () => clearTimeout(timer))
  return () => clearTimeout(timer)
}

export async function requireReplyReceipt(controlDir: string, runId: string) {
  const receipt = join(controlDir, 'outbox', `${assertId(runId)}_busy_reply`)
  const sent = await Promise.all(['.json','.sending.json','.sent.json','.failed.json'].map(suffix => lstat(receipt+suffix).then(() => true, () => false)))
  if (!sent.some(Boolean)) throw new Error('Reply session ended without an answer')
}

export async function startReplyExecutor(options: ExecutorOptions) {
  const run = await requireOwnerExecution(options.controlDir, options.runId)
  if (!run.replyOnly || !/^tg_[0-9]+$/.test(run.id) || run.execution?.preset.cli !== 'codex') throw new Error('Invalid reply run')
  const environment = executorEnvironment()
  const version = await promisify(execFile)('codex', ['--version'], { env: environment })
  if (!['codex-cli 0.153.4', 'codex-cli 0.154.0'].includes(version.stdout.trim())) throw new Error('Reply session requires audited Codex 0.153.4 or 0.154.0')
  const temporary = await mkdtemp(join(tmpdir(), 'ez-reply-'))
  try {
    const directory = join(temporary, 'workspace'), home = join(temporary, 'home')
    await mkdir(directory, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
    const catalog = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], { env: environment, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(temporary, 'models.json'), JSON.stringify(taskModelCatalog(JSON.parse(catalog.stdout))), { mode: 0o600 })
    const boundAuth = join(options.controlDir, 'cli', 'codex', 'auth.json')
    const auth = await lstat(boundAuth).then(() => boundAuth, error => { if (error.code === 'ENOENT') return join(homedir(), '.codex', 'auth.json'); throw error })
    await symlink(auth, join(home, 'auth.json'))
    const broker = [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./reply-mcp.ts', import.meta.url)), options.controlDir, options.runId, options.workspace]
    const prompt = run.texts.join('\n\n')
    const args = taskArguments(directory, broker, prompt, ['context', 'send', 'defer'], run.execution.preset)
    const child = spawn('codex', args, { cwd: directory, env: { ...environment, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.stdin.end(prompt); child.stdout.resume()
    // This session only reads snapshots and queues a reply; writers have no deadline.
    const clearDeadline = replyDeadline(child)
    return { child, stdout: '', cleanup: async () => {
      clearDeadline()
      await rm(temporary, { recursive: true, force: true })
      if (child.exitCode === 0) await requireReplyReceipt(options.controlDir, options.runId)
    } }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}
