import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { initializeWorkspace } from './workspace.js'
import { resolveExecutor } from './executor.js'

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

// Configuration only: no provider calls, owner approval, service start, or AI turn.
export const configureInstallation = async (directory: string, cli: string, token?: string) => {
  let executor: string
  try { executor = resolveExecutor(cli).name }
  catch { throw new Error('Unsupported executor. See ezenciel-agents-setup status.') }
  if (token !== undefined && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token))
    throw new Error('Invalid Telegram bot token. Supply the BotFather token through stdin.')
  const root = path.resolve(directory)
  const envFile = path.join(root, '.env')
  let original = ''
  try {
    if (!(await lstat(envFile)).isFile()) throw new Error('.env must be a regular file')
    original = await readFile(envFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const values = parseEnv(original)
  const workspace = path.resolve(root, values.EZ_AGENT_WORKSPACE?.trim() || 'agent')
  const controlDir = path.resolve(root, values.EZ_CONTROL_DIR?.trim() || 'control')
  if (inside(workspace, envFile) || inside(workspace, controlDir) || inside(controlDir, workspace))
    throw new Error('Keep the mind, control directory, and .env separate.')
  const configured = {
    ...values,
    EZ_AGENT_WORKSPACE: workspace,
    EZ_CONTROL_DIR: controlDir,
    EZ_EXECUTOR_CLI: executor,
    TELEGRAM_BOT_TOKEN: token ?? values.TELEGRAM_BOT_TOKEN ?? '',
  }
  // Literal dotenv values; do not shell-source this file. Preserve unknown keys.
  const content = Object.entries(configured).map(([key, value]) => {
    const quote = ['"', "'"].find(q => !value.includes(q))
    if (!quote) throw new Error('Existing .env has a value requiring manual quoting; it was not changed.')
    return `${key}=${quote}${value}${quote}\n`
  }).join('')
  const created = await initializeWorkspace(workspace)
  const temporary = `${envFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, envFile)
  } finally { await rm(temporary, { force: true }) }
  return { workspace, controlDir, envFile, executor, created,
    tokenConfigured: Boolean(configured.TELEGRAM_BOT_TOKEN),
    next: configured.TELEGRAM_BOT_TOKEN ? 'verify executor tools, start relay, and pair owner' : 'connect Telegram with the owner\u2019s BotFather token' }
}
