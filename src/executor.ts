import { executionDefaults } from './model-policy.js'
import { Tasks } from './tasks.js'
import { RunStore } from './runs.js'
import { startTaskExecutor } from './task-executor.js'
import { requireOwnerExecution } from './execution-authority.js'
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { processSnapshot, matchingProcessIds } from './process-tree.js'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DESKTOP_UNAVAILABLE } from './desktop-bridge.js'

export type ExecutorOptions = {
  repairEnabled?: boolean
  workspace: string
  timeoutMs: number
  runId: string
  controlDir: string
  binDir: string
  toolsHome?: string
  sharedWorkspace?: string
  cli?: string
  sessionId?: string
  isResume?: boolean
  eventSource?: string
  model?: string
  effort?: string
  codexAutoCompactTokens?: number
  onSession?: (id: string) => Promise<void>
}

const allowedEnvironmentKeys = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
] as const

export const executorEnvironment = (environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const entries = allowedEnvironmentKeys.flatMap<[string, string]>((key) => {
    const value = environment[key]
    return value === undefined ? [] : [[key, value]]
  })
  return Object.fromEntries(entries)
}

export const executorJobEnv = (
  options: Pick<ExecutorOptions, 'runId' | 'controlDir' | 'binDir' | 'toolsHome' | 'repairEnabled'>,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const base = executorEnvironment(environment)
  const pathValue = [options.binDir, base.PATH].filter(Boolean).join(path.delimiter)
  return {
    ...base,
    PATH: pathValue,
    EZ_RUN_ID: options.runId,
    EZ_CONTROL_DIR: options.controlDir,
    EZ_REPAIR_ENABLED: String(options.repairEnabled !== false),
    ...(options.toolsHome ? {BUILDX_CONFIG:path.join(options.toolsHome,'buildx')} : {}),
  }
}

export const grokJobEnv = executorJobEnv

export type CliAdapter = {
  name: string
  command: string
  description: string
  buildArgs: (
    options: Pick<ExecutorOptions, 'workspace' | 'sessionId' | 'isResume' | 'model' | 'effort' | 'toolsHome' | 'sharedWorkspace' | 'codexAutoCompactTokens'> & { controlDir?: string },
    promptFile: string,
    promptText: string,
  ) => string[]
}

export const EXECUTOR_REGISTRY: Record<string, CliAdapter> = {
  codex: {
    name: 'codex', command: 'codex', description: 'Codex CLI',
    buildArgs: (opts, _file, prompt) => {
      const args = ['exec', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', '--disable', 'memories', '--enable', 'skip_host_skill_discovery', '-c', 'approval_policy="never"']
      const limit = opts.codexAutoCompactTokens
      if (limit !== undefined) {
        if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid Codex compaction token limit')
        args.push('-c', `model_auto_compact_token_limit=${limit}`)
      }
      if (opts.controlDir) args.push('--add-dir', opts.controlDir)
      if (opts.sharedWorkspace) args.push('--add-dir', opts.sharedWorkspace)
      if (opts.toolsHome) args.push('--add-dir', opts.toolsHome, '-c', 'sandbox_workspace_write.network_access=true')
      if (opts.model) args.push('--model', opts.model)
      if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`)
      if (opts.isResume && opts.sessionId) args.push('resume', opts.sessionId)
      args.push('-') // Native stdin keeps text out of option/subcommand parsing.
      return args
    },
  },
  agy: {
    name: 'antigravity',
    command: 'agy',
    description: 'Google Antigravity CLI (default)',
    buildArgs: (opts, _promptFile, promptText) => {
      const args: string[] = []
      if (opts.isResume) args.push('-c')
      args.push('--dangerously-skip-permissions', `--print=${promptText}`)
      return args
    },
  },
  claude: {
    name: 'claude',
    command: 'claude',
    description: 'Claude Code CLI',
    buildArgs: (opts, _promptFile, promptText) => {
      const args: string[] = []
      if (opts.isResume && opts.sessionId) {
        args.push('--resume', opts.sessionId)
      } else if (opts.sessionId) {
        args.push('--session-id', opts.sessionId)
      }
      args.push('--print', '--dangerously-skip-permissions', '--append-system-prompt-file', path.join(opts.workspace, 'AGENTS.md'))
      if (opts.model) args.push('--model', opts.model)
      if (opts.effort) args.push('--effort', opts.effort)
      return args
    },
  },
  grok: {
    name: 'grok',
    command: 'grok',
    description: 'Grok CLI',
    buildArgs: (opts, promptFile) => {
      const args: string[] = []
      if (opts.sessionId) args.push(opts.isResume ? '--resume' : '--session-id', opts.sessionId)
      else if (opts.isResume) args.push('-c')
      if (opts.model) args.push('--model', opts.model)
      if (opts.effort) args.push('--reasoning-effort', opts.effort)
      args.push(
        '--prompt-file',
        promptFile,
        '--cwd',
        opts.workspace,
        '--output-format',
        'plain',
        '--always-approve',
        '--verbatim',
        '--max-turns',
        '8',
      )
      return args
    },
  },
  opencode: {
    name: 'opencode',
    command: 'opencode',
    description: 'OpenCode CLI (Nemotron 3.5 Lightning)',
    buildArgs: (opts, _promptFile, promptText) => {
      const args: string[] = ['run', '--auto', '--format', 'json']
      if (opts.isResume && opts.sessionId) {
        args.push('-s', opts.sessionId)
      }
      if (opts.model) args.push('-m', opts.model)
      if (opts.effort) args.push('--variant', opts.effort)
      args.push('--', promptText)
      return args
    },
  },
  'codex-gui': {
    name: 'codex-gui',
    command: 'codex',
    description: 'Codex desktop',
    buildArgs: () => { throw new Error(DESKTOP_UNAVAILABLE) },
  },
}

export const EXECUTOR_ALIASES: Record<string, string> = {
  antigravity: 'agy',
  'claude-code': 'claude',
  oc: 'opencode',
}

export const executorKey = (name?: string): string => {
  const normalized = (name ?? 'agy').trim().toLowerCase()
  const resolvedKey = EXECUTOR_ALIASES[normalized] ?? normalized
  if (!EXECUTOR_REGISTRY[resolvedKey]) {
    const supported = [...Object.keys(EXECUTOR_REGISTRY), ...Object.keys(EXECUTOR_ALIASES)].join(', ')
    throw new Error(`Unsupported executor CLI "${name}". Supported executors: ${supported}`)
  }
  return resolvedKey
}

export const resolveExecutor = (name?: string): CliAdapter => EXECUTOR_REGISTRY[executorKey(name)]

export const grokInvocation = (
  options: Pick<ExecutorOptions, 'workspace' | 'isResume'>,
  promptFile: string,
): { command: string; args: string[] } => ({
  command: EXECUTOR_REGISTRY.grok.command,
  args: EXECUTOR_REGISTRY.grok.buildArgs(options, promptFile, ''),
})

export const antigravityInvocation = (
  prompt: string,
  options: Pick<ExecutorOptions, 'isResume'> = {},
): { command: string; args: string[] } => ({
  command: EXECUTOR_REGISTRY.agy.command,
  args: EXECUTOR_REGISTRY.agy.buildArgs({ workspace: '', ...options }, '', prompt),
})

export const opencodeInvocation = (
  prompt: string,
  options: Pick<ExecutorOptions, 'workspace' | 'sessionId' | 'isResume'> = { workspace: '' },
): { command: string; args: string[] } => ({
  command: EXECUTOR_REGISTRY.opencode.command,
  args: EXECUTOR_REGISTRY.opencode.buildArgs(options, '', prompt),
})

// The Docker relay retains a distinct real UID, so Linux marks its process
// non-dumpable. Normalize executor IDs before exec; no privilege is gained.
export const executorInvocation = (command: string, args: string[]) => {
  const uid = process.geteuid?.()
  return process.platform === 'linux' && uid !== undefined && process.getuid?.() !== uid
    ? { command: 'setpriv', args: [`--ruid=${uid}`, `--euid=${uid}`, '--', command, ...args] }
    : { command, args }
}

export const startExecutorJob = async (
  texts: string[],
  options: ExecutorOptions,
): Promise<{ child: ChildProcess; cleanup: () => Promise<void>; stdout: string }> => {
  options = executionDefaults(executorKey(options.cli), options)
  if(options.runId.startsWith('r_schedule_') && !/^[a-zA-Z0-9_-]+$/.test(options.runId))throw new Error('Invalid native task run ID')
  const run = await new RunStore(options.controlDir).get(options.runId)
  if (run?.taskId) {
    if (run.status !== 'running') throw new Error('No active task run')
    await new Tasks(options.controlDir).authorize(run, process.env.EZ_EXECUTOR_TRANSPORT === 'host')
    if (process.env.EZ_EXECUTOR_TRANSPORT !== 'host') return startTaskExecutor(options)
  } else await requireOwnerExecution(options.controlDir, options.runId)
  if (!run?.taskId && options.eventSource !== undefined) throw new Error('Execution blocked: external-execution-unavailable')
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'ezenciel-agents-'))
  const key = executorKey(options.cli)
  const host = process.env.EZ_EXECUTOR_TRANSPORT === 'host'
  const gui = !host && key === 'codex-gui'
  const nativeSession = !host && key === 'codex' && options.runId.startsWith('r_schedule_')
  const promptText = texts.join('\n\n')
  const promptFile = path.join(outputDirectory, 'prompt.txt')
  await writeFile(promptFile, promptText, { encoding: 'utf8', mode: 0o600 })

  const adapter = resolveExecutor(options.cli)
  const command = adapter.command
  const args = host || nativeSession || key === 'codex-gui' ? [] : adapter.buildArgs(options, promptFile, promptText)
  const invocation = host
    ? executorInvocation(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('./host-executor-client.ts', import.meta.url)), options.controlDir, options.runId])
    : nativeSession
      ? executorInvocation(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('./codex-session.ts', import.meta.url))])
    : gui
      ? executorInvocation(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('./desktop-bridge.ts', import.meta.url))])
      : executorInvocation(command, args)
  const environment = executorJobEnv(options)
  if (!host && !gui && command === 'codex') {
    // Share the existing authentication, never the user's memory/config/sessions.
    const base = path.join(options.controlDir, 'cli', 'codex')
    const home = nativeSession ? path.join(base,'tasks',options.runId) : base
    await mkdir(home, {recursive:true,mode:0o700})
    if(nativeSession){
      // Snapshot this agent's configuration, never personal global configuration.
      // Native state databases stay per task, avoiding concurrent initialization
      // and migration of the foreground session's database.
      try{await writeFile(path.join(home,'config.toml'),await readFile(path.join(base,'config.toml')),{flag:'wx',mode:0o600})}
      catch(error){if(!['ENOENT','EEXIST'].includes((error as NodeJS.ErrnoException).code || ''))throw error}
    }
    // Tasks inherit this agent's auth binding, including an operator-provisioned
    // private credential after host migration. Never replace an existing binding.
    const authLinks = [[path.join(base, 'auth.json'), path.join(homedir(), '.codex', 'auth.json')]]
    if (nativeSession) authLinks.push([path.join(home, 'auth.json'), path.join(base, 'auth.json')])
    for (const [link, target] of authLinks) {
      try { await symlink(target, link) }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    environment.CODEX_HOME = home
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  }).catch(async (error) => {
    await rm(outputDirectory, { recursive: true, force: true })
    throw error
  })
  child.stdin?.end(host
    ? JSON.stringify({texts,options:{...options,onSession:undefined}})
    : nativeSession ? JSON.stringify({...options,onSession:undefined,prompt:promptText})
    : gui ? JSON.stringify({prompt:promptText,options:{...options,onSession:undefined}})
    : ['codex', 'claude'].includes(key) ? promptText : undefined)
  const timeout = options.timeoutMs > 0 ? setTimeout(() => terminateJob(child), options.timeoutMs) : undefined
  let stdout = ''
  let stderr = ''
  let metadataWork = Promise.resolve()
  if (child.stdout && options.onSession && ['codex', 'codex-gui', 'opencode'].includes(key)) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const id = nativeSessionId(key, line)
      if (id) metadataWork = metadataWork.then(() => options.onSession!(id))
      // Surface metadata persistence failure during cleanup, without unhandled rejection.
      void metadataWork.catch(() => {})
    })
  } else child.stdout?.resume()
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  child.once('close', () => clearTimeout(timeout))
  return {
    child,
    cleanup: async () => {
      clearTimeout(timeout)
      await rm(outputDirectory, { recursive: true, force: true })
      await metadataWork
    },
    stdout,
  }
}

export const startGrokJob = startExecutorJob

// Structured client events only. Model text is never interpreted or sent to chat.
export const nativeSessionId = (cli: string, line: string): string | undefined => {
  try {
    const event = JSON.parse(line)
    const id = (cli === 'codex' || cli === 'codex-gui') && event.type === 'thread.started' ? event.thread_id
      : cli === 'opencode' && ['step_start', 'step_finish', 'text', 'tool_use'].includes(event.type) ? event.sessionID : undefined
    if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)) return id
  } catch {}
}

const terminating = new WeakSet<ChildProcess>()
export const terminateJob = (child: ChildProcess, inspect = processSnapshot): void => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null || terminating.has(child)) return
  terminating.add(child)
  void (async () => {
    const targets = new Set([child.pid!])
    // Native tool terminals can start separate process groups. Capture ancestry
    // before stopping the CLI, while those children still have their parent.
    let snapshot: Awaited<ReturnType<typeof processSnapshot>>
    try { snapshot = await inspect() }
    catch (error) { console.error('Cannot inspect executor descendants for cancellation', error); snapshot = new Map() }
    let count = 0
    while (count !== targets.size) {
      count = targets.size
      for (const [pid, info] of snapshot) if (targets.has(info.parent)) targets.add(pid)
    }
    if (child.exitCode !== null || child.signalCode !== null) targets.delete(child.pid!)
    const identities = new Map([...snapshot].filter(([pid]) => targets.has(pid)))
    const signal = (pids: number[], name: NodeJS.Signals) => {
      for (const pid of pids.reverse()) {
        if (process.platform !== 'win32') { try { process.kill(-pid, name) } catch {} }
        try { process.kill(pid, name) } catch {}
      }
    }
    signal([...targets], 'SIGTERM')
    // Recheck birth identities before escalation: exited PIDs may be reused.
    // Root closure must not cancel cleanup of its detached tools.
    setTimeout(() => {
      if (!identities.size && child.exitCode === null && child.signalCode === null) signal([child.pid!], 'SIGKILL')
      void processSnapshot().then(current => signal(matchingProcessIds(identities, current), 'SIGKILL'))
        .catch(error => console.error('Cannot inspect executor descendants for escalation', error))
    }, 3000)
  })()
}
