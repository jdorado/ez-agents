import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { desktopJobPrompt } from '../src/desktop-bridge.js'
import { chatGuidance } from '../src/agent-guidance.js'
import { executorJobPrompt } from '../src/executor.js'
import { taskArguments } from '../src/task-executor.js'
import { initializeWorkspace } from '../src/workspace.js'

const sharedGuidancePath = fileURLToPath(new URL('../templates/agent-guidance.md', import.meta.url))
const sharedLoaderPath = fileURLToPath(new URL('../src/agent-guidance.ts', import.meta.url))
const tsxLoaderPath = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
const execFileAsync = promisify(execFile)
const runNode = (code: string, cwd: string) => execFileAsync(process.execPath, [
  '--import', tsxLoaderPath, '--input-type=module', '-e', code,
], { cwd, encoding: 'utf8' })

test('CLI and desktop prompt builders use current package guidance', async () => {
  const shared = (await readFile(sharedGuidancePath, 'utf8')).trim()
  const prompts = [
    ['CLI', executorJobPrompt('tg_owner', ['owner request'])],
    ['desktop', desktopJobPrompt('tg_owner_gui', ['owner request'], undefined, '/tmp/bin', '/tmp/control')],
  ] as const
  for (const [kind, prompt] of prompts)
    {
    assert.ok(prompt.includes(shared), `${kind} prompt is missing the current package guidance`)
    assert.ok(prompt.includes(chatGuidance()), `${kind} prompt is missing channel guidance`)
  }
  assert.ok(!executorJobPrompt('r_schedule_job', ['work']).includes(chatGuidance()))
})

test('shared guidance teaches source-chat delivery and real Telegram line breaks', async () => {
  const shared = await readFile(sharedGuidancePath, 'utf8')
  assert.ok(shared.includes("current run's source chat"))
  assert.match(shared, /actual newline\s+characters/)
  assert.ok(shared.includes('`\\n`'))
  assert.ok(shared.includes('`\\\\n`'))
  assert.ok(shared.includes('`/n`'))
  assert.ok(shared.includes('ezenciel-agents-message --text-file ./work/reply.md'))
})

test('shared guidance makes owner AI selection a relay control, not host configuration', async () => {
  const shared = await readFile(sharedGuidancePath, 'utf8')
  for (const prompt of [
    executorJobPrompt('tg_owner', ['change to Terra medium']),
    desktopJobPrompt('tg_owner_gui', ['change to Terra medium'], undefined, '/tmp/bin', '/tmp/control'),
  ]) {
    assert.ok(prompt.includes('`ezenciel-agents-ai list`'))
    assert.ok(prompt.includes('`ezenciel-agents-ai select --cli <cli> --model <model> --effort <effort>`'))
    assert.ok(prompt.includes('not a request to edit the host Codex configuration'))
    assert.match(prompt, /a running or queued job retains\s+its captured choice/)
  }
})

test('package guidance resolution ignores a workspace shadow file', async () => {
  const root = path.join(tmpdir(), `ez-guidance-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const workspace = path.join(root, 'agent')
  const workspaceMarker = 'WORKSPACE_GUIDANCE_MUST_NOT_BE_IMPORTED'
  try {
    await mkdir(path.join(workspace, 'templates'), { recursive: true })
    await writeFile(path.join(workspace, 'templates', 'agent-guidance.md'), workspaceMarker)
    const result = await runNode(
      `import { agentGuidance } from ${JSON.stringify(pathToFileURL(sharedLoaderPath).href)}; process.stdout.write(agentGuidance())`,
      workspace,
    )
    assert.ok(result.stdout.includes((await readFile(sharedGuidancePath, 'utf8')).trim()))
    assert.ok(!result.stdout.includes(workspaceMarker))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace initialization preserves a customized AGENTS.md', async () => {
  const root = path.join(tmpdir(), `ez-guidance-workspace-${randomUUID()}`)
  const workspace = path.join(root, 'agent')
  try {
    await initializeWorkspace(workspace)
    const custom = '# Workspace-specific purpose\nKeep this local guidance unchanged.\n'
    await writeFile(path.join(workspace, 'AGENTS.md'), custom)
    await initializeWorkspace(workspace)
    assert.equal(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8'), custom)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restricted task arguments retain bounded permissions and do not receive owner guidance', () => {
  const directory = '/tmp/ez-restricted-task/workspace'
  const args = taskArguments(directory, ['node', 'broker'], 'approved task')
  assert.ok(args.includes('default_permissions="ez-task"'))
  assert.ok(args.includes(`permissions.ez-task.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(directory)}="write"}`))
  assert.ok(args.includes('permissions.ez-task.network.enabled=false'))
  assert.ok(args.includes('--disable') && args.includes('shell_tool'))
  assert.ok(!args.some((arg) => arg.includes('# Shared Ez guidance')))
})

test('copied package guidance refreshes on each call and missing guidance fails visibly', async () => {
  const root = path.join(tmpdir(), `ez-guidance-loader-${randomUUID()}`)
  const source = path.join(root, 'src')
  const templates = path.join(root, 'templates')
  const loaderPath = path.join(source, 'agent-guidance.ts')
  const guidancePath = path.join(templates, 'agent-guidance.md')
  await mkdir(source, { recursive: true })
  await mkdir(templates, { recursive: true })
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(loaderPath, await readFile(sharedLoaderPath, 'utf8'))
    await writeFile(guidancePath, 'fixture guidance one')
    const code = `
      import { renameSync, writeFileSync } from 'node:fs'
      import { agentGuidance } from ${JSON.stringify(pathToFileURL(loaderPath).href)}
      const guidancePath = ${JSON.stringify(guidancePath)}
      if (agentGuidance() !== 'fixture guidance one') throw new Error('initial fixture was not loaded')
      writeFileSync(guidancePath, 'fixture guidance two')
      if (agentGuidance() !== 'fixture guidance two') throw new Error('guidance was cached')
      renameSync(guidancePath, guidancePath + '.missing')
      agentGuidance()
    `
    await assert.rejects(
      () => runNode(code, root),
      (error: any) => {
        assert.notEqual(error.code, 0)
        assert.match(error.stderr, /ENOENT/)
        assert.match(error.stderr, /agent-guidance\.md/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
