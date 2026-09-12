import { executionDefaults } from './model-policy.js'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RunStore } from './runs.js'
import { Tasks } from './tasks.js'
import { executorEnvironment, terminateJob, type ExecutorOptions } from './executor.js'

// This adapter is deliberately version-pinned: a new native tool default needs
// a fresh tool-inventory audit before external correspondence can use it.
export const TASK_CODEX_VERSION = '0.153.4'
export const taskDisabledFeatures = ['apps', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation',
  'memories', 'multi_agent', 'multi_agent_v2', 'hooks', 'shell_tool', 'unified_exec', 'code_mode', 'code_mode_host',
  'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'workspace_dependencies', 'view_image']
// Model catalog defaults can override disabled feature flags (for example,
// code-only tools and v2 collaboration). Use the audited direct-tool surface.
export function taskModelCatalog(catalog: { models: Record<string, unknown>[] }) {
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('No audited model catalog');
  return { models: catalog.models.map(model => ({ ...model, tool_mode: null,
    apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null,
    supports_search_tool: false, use_responses_lite: false })) };
}
export function taskArguments(directory: string, broker: string[], prompt: string, toolNames = ['context', 'send', 'note', 'report', 'complete'], selection: {model?:string;effort?:string} = {}) {
  const preset = executionDefaults('codex', selection)
  return ['exec', ...(preset.model ? ['--model',preset.model] : []), ...(preset.effort ? ['-c',`model_reasoning_effort=${JSON.stringify(preset.effort)}`] : []), '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--json', '-C', directory,
    ...taskDisabledFeatures.flatMap(feature => ['--disable', feature]), '--enable', 'skip_host_skill_discovery',
    '-c', `model_catalog_json=${JSON.stringify(join(directory, '..', 'models.json'))}`,
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'approval_policy="never"',
    '-c', 'default_permissions="ez-task"',
    '-c', `permissions.ez-task.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(directory)}="write"}`,
    '-c', 'permissions.ez-task.network.enabled=false',
    '-c', `mcp_servers.ez={command=${JSON.stringify(broker[0])},args=${JSON.stringify(broker.slice(1))},required=true,enabled_tools=${JSON.stringify(toolNames)}}`,
    ...toolNames.flatMap(name => ['-c', `mcp_servers.ez.tools.${name}.approval_mode="approve"`]),
    '-'] // Literal input travels on stdin, including slash commands and leading options.
}
export async function startTaskExecutor(options: ExecutorOptions) {
  const run = await new RunStore(options.controlDir).get(options.runId)
  if (!run || run.status !== 'running') throw new Error('No active task run')
  await new Tasks(options.controlDir).authorize(run, false)
  const environment = executorEnvironment()
  const version = await promisify(execFile)('codex', ['--version'], { env: environment })
  if (version.stdout.trim() !== `codex-cli ${TASK_CODEX_VERSION}`) throw new Error(`Restricted tasks require audited Codex ${TASK_CODEX_VERSION}`)
  const temporary = await mkdtemp(join(tmpdir(), 'ez-task-'))
  try {
    const directory = join(temporary, 'workspace'), home = join(temporary, 'home')
    await mkdir(directory, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
    const catalog = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], { env: environment, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(temporary, 'models.json'), JSON.stringify(taskModelCatalog(JSON.parse(catalog.stdout))), { mode: 0o600 })
    await symlink(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'))
    const broker = [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./task-mcp.ts', import.meta.url)), options.controlDir, options.runId]
    const prompt = JSON.stringify({event: run.external ? 'correspondence_received' : 'task_activated', taskId: run.taskId})
    const child = spawn('codex', taskArguments(directory, broker, prompt, undefined, options), {
      cwd: directory, env: { ...environment, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.stdin.end(prompt); child.stdout.resume()
    const timeout = setTimeout(() => terminateJob(child), options.timeoutMs > 0 ? options.timeoutMs : 300000)
    child.once('close', () => clearTimeout(timeout))
    return { child, stdout: '', cleanup: async () => { clearTimeout(timeout); await rm(temporary, { recursive: true, force: true }) } }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}
