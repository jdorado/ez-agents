import { access, constants, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { initializeWorkspace } from './workspace.js'
import { configureInstallation } from './install-config.js'
import { installService } from './service.js'
import { discoverDefaults } from './client-defaults.js'
import { initialPreset } from './ai.js'
import { ControlStore } from './control-state.js'
import { loadControlConfig } from './config.js'
import { EXECUTOR_REGISTRY, resolveExecutor, executorKey } from './executor.js'
import { desktopCodexPath } from './desktop-bridge.js'

export const findExecutableInPath = async (
  command: string,
  envPath: string = process.env.PATH ?? '',
): Promise<string | null> => {
  const dirs = envPath.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const fullPath = path.join(dir, command)
    try {
      await access(fullPath, constants.X_OK)
      return fullPath
    } catch {
      // continue searching
    }
  }
  return null
}

export const readActiveExecutor = async (envFilePath: string): Promise<string> => {
  try {
    const content = await readFile(envFilePath, 'utf8')
    const active = parseEnv(content).EZ_EXECUTOR_CLI?.trim()
    if (active) return active
  } catch {
    // env file doesn't exist yet
  }
  return process.env.EZ_EXECUTOR_CLI?.trim() || 'agy'
}

export const setExecutorInEnv = async (envFilePath: string, cliName: string): Promise<void> => {
  const adapter = resolveExecutor(cliName)
  let content = ''
  try {
    content = await readFile(envFilePath, 'utf8')
  } catch {
    content = ''
  }

  const newLine = `EZ_EXECUTOR_CLI=${adapter.name}`
  if (/^EZ_EXECUTOR_CLI=.*$/m.test(content)) {
    content = content.replace(/^EZ_EXECUTOR_CLI=.*$/m, newLine)
  } else {
    content = content ? `${content.trimEnd()}\n${newLine}\n` : `${newLine}\n`
  }
  await writeFile(envFilePath, content, 'utf8')
}

export type ExecutorStatus = {
  id: string
  name: string
  command: string
  description: string
  installedPath: string | null
  isActive: boolean
}

export const getExecutorsStatus = async (
  envFilePath: string = path.resolve(process.cwd(), '.env'),
): Promise<{ active: string; items: ExecutorStatus[] }> => {
  const active = await readActiveExecutor(envFilePath)
  const resolvedActive = executorKey(active)

  const items: ExecutorStatus[] = []
  for (const [id, adapter] of Object.entries(EXECUTOR_REGISTRY)) {
    const installedPath = id === 'codex-gui' ? await desktopCodexPath() : await findExecutableInPath(adapter.command)
    items.push({
      id,
      name: adapter.name,
      command: adapter.command,
      description: adapter.description,
      installedPath,
      isActive: id === resolvedActive,
    })
  }
  return { active, items }
}

const printStatus = (status: { active: string; items: ExecutorStatus[] }): void => {
  console.log('\nSupported CLI Executors:\n')
  for (const item of status.items) {
    const activeBadge = item.isActive ? ' [ACTIVE]' : ''
    const statusText = item.installedPath ? `✓ installed (${item.installedPath})` : '✗ not found in PATH'
    console.log(`  * ${item.id.padEnd(14)} (${item.command})${activeBadge}`)
    console.log(`    ${item.description}`)
    console.log(`    Status: ${statusText}\n`)
  }
  console.log(`Active executor: ${status.active}`)
  console.log('Initialize the persistent mind: ezenciel-agents-setup init')
  console.log('\nTo switch executor:')
  console.log('  pnpm run setup <executor-name>')
  console.log('  Examples: pnpm run setup claude')
  console.log('            pnpm run setup agy')
  console.log('            pnpm run setup grok')
  console.log('            pnpm run setup opencode')
  console.log('            pnpm run setup codex-gui\n')
}

export const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const envFilePath = path.resolve(process.cwd(), '.env')

  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: ezenciel-agents-setup configure <executor> [--token-stdin] | service | init | status | <executor>\nconfigure writes private .env paths and seeds missing mind files; it does not start or pair the bot.\n--token-stdin accepts the BotFather token without putting it in command arguments or output.\nservice starts the Docker Compose deployment bound by docker.env; it does not pair the owner.\nFollow docs/setup.md through a real Telegram reply; package installation alone is incomplete.')
    return
  }

  if (args[0] === 'service') {
    if (args.length !== 1) throw new Error('Usage: ezenciel-agents-setup service')
    console.log(JSON.stringify(await installService(process.cwd())))
    return
  }

  if (args[0] === 'configure') {
    if (!args[1] || args.length > 3 || (args[2] && args[2] !== '--token-stdin'))
      throw new Error('Usage: ezenciel-agents-setup configure <executor> [--token-stdin]')
    let token: string | undefined
    if (args[2]) {
      if (process.stdin.isTTY) throw new Error('Supply the token through stdin, not a command argument.')
      let input = ''
      for await (const chunk of process.stdin) {
        input += chunk.toString()
        if (input.length > 512) throw new Error('Token input is too long.')
      }
      token = input.trim()
    }
    console.log(JSON.stringify(await configureInstallation(process.cwd(), args[1], token)))
    return
  }

  if (args[0] === 'init') {
    if (args.length !== 1) throw new Error('Usage: ezenciel-agents-setup init (uses EZ_AGENT_WORKSPACE or ./agent)')
    const workspace = path.resolve(process.env.EZ_AGENT_WORKSPACE?.trim() || './agent')
    const created = await initializeWorkspace(workspace)
    const config = loadControlConfig()
    await new ControlStore(config.controlDir, config.pairingTtlMs).syncClientPresets(
      initialPreset(await readActiveExecutor(envFilePath)), await discoverDefaults(workspace))
    console.log(JSON.stringify({ workspace, created }))
    return
  }

  if (args.length === 0 || args[0] === 'status') {
    const status = await getExecutorsStatus(envFilePath)
    printStatus(status)
    return
  }

  const target = args[0]
  try {
    const adapter = resolveExecutor(target)
    await setExecutorInEnv(envFilePath, adapter.name)
    const installed = await findExecutableInPath(adapter.command)
    console.log(`\n✓ Active CLI executor switched to: ${adapter.name} (${adapter.command})`)
    if (installed) {
      console.log(`  Binary verified at: ${installed}`)
    } else {
      console.warn(`  Warning: Binary "${adapter.command}" not found in PATH. Install it before starting the relay.`)
    }
    console.log(`  Updated: ${envFilePath}\n`)
  } catch (error) {
    console.error(`\nError: ${(error as Error).message}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli().catch(error => { console.error((error as Error).message); process.exitCode = 1 })
}
