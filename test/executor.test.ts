import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXECUTOR_REGISTRY, antigravityInvocation, executorEnvironment, executorJobPrompt, grokInvocation, grokJobEnv, opencodeInvocation, resolveExecutor, startExecutorJob, terminateJob } from '../src/executor.js'
import { splitTelegramText } from '../src/reply.js'

test('the job prompt labels channel text as untrusted and requires ez message', () => {
  const prompt = executorJobPrompt('r_test', ['hello'])
  assert.match(prompt, /untrusted incoming channel content/)
  assert.match(prompt, /ezenciel-agents-message/)
  assert.match(prompt, /--text-file/)
  assert.match(prompt, /r_test/)
  assert.match(prompt, /hello/)
  assert.match(prompt, /Stdout is not sent to Telegram/)
})

test('Telegram replies are split within the configured message limit', () => {
  const text = `${'a'.repeat(9)} ${'b'.repeat(9)} ${'c'.repeat(9)}`
  const chunks = splitTelegramText(text, 10)
  assert.deepEqual(chunks, ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc'])
  assert.ok(chunks.every((chunk) => chunk.length <= 10))
})

test('the executor receives a deliberately small environment', () => {
  const environment = executorEnvironment({ PATH: '/bin', HOME: '/tmp/home', TELEGRAM_BOT_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' })
  assert.deepEqual(environment, { PATH: '/bin', HOME: '/tmp/home' })
  assert.ok(!('TELEGRAM_BOT_TOKEN' in environment))
})

test('the Grok job env binds the run and still strips the bot token', () => {
  const environment = grokJobEnv(
    { runId: 'r_1', controlDir: '/tmp/control', binDir: '/tmp/bin' },
    { PATH: '/usr/bin', HOME: '/tmp/home', TELEGRAM_BOT_TOKEN: 'secret' },
  )
  assert.equal(environment.EZ_RUN_ID, 'r_1')
  assert.equal(environment.EZ_CONTROL_DIR, '/tmp/control')
  assert.match(environment.PATH ?? '', /^\/tmp\/bin/)
  assert.ok(!('TELEGRAM_BOT_TOKEN' in environment))
})

test('Docker build metadata uses the bound registry, never an inherited path', () => {
  const environment=grokJobEnv({runId:'r_test',controlDir:'/agent/control',binDir:'/agent/bin',toolsHome:'/agent/tools'},{BUILDX_CONFIG:'/another-agent',TELEGRAM_BOT_TOKEN:'secret'})
  assert.equal(environment.BUILDX_CONFIG,'/agent/tools/buildx')
  assert.equal(environment.TELEGRAM_BOT_TOKEN,undefined)
})

test('the Grok invocation is headless, workspace-scoped, and token-free', () => {
  const invocation = grokInvocation({ workspace: '/tmp/agent-workspace' }, '/tmp/prompt.txt')
  assert.equal(invocation.command, 'grok')
  assert.deepEqual(invocation.args, [
    '--prompt-file', '/tmp/prompt.txt',
    '--cwd', '/tmp/agent-workspace',
    '--output-format', 'plain',
    '--always-approve',
    '--verbatim',
    '--max-turns', '8',
  ])
  assert.equal(invocation.args.includes('TELEGRAM_BOT_TOKEN'), false)
})

test('the antigravity invocation is headless, skips permissions, and uses print mode', () => {
  const invocation = antigravityInvocation('test prompt')
  assert.equal(invocation.command, 'agy')
  assert.deepEqual(invocation.args, [
    '--print', 'test prompt',
    '--dangerously-skip-permissions',
  ])
})

test('the opencode invocation is headless, auto-approves, and sets model and workspace', () => {
  const invocation = opencodeInvocation('test prompt', { workspace: '/tmp/test-ws' })
  assert.equal(invocation.command, 'opencode')
  assert.deepEqual(invocation.args, [
    'run',
    '--auto',
    '--format',
    'json',
    'test prompt',
  ])
})

test('resolveExecutor correctly maps keys and aliases', () => {
  assert.equal(resolveExecutor('agy').command, 'agy')
  assert.equal(resolveExecutor('antigravity').command, 'agy')
  assert.equal(resolveExecutor('claude').command, 'claude')
  assert.equal(resolveExecutor('grok').command, 'grok')
  assert.equal(resolveExecutor('opencode').command, 'opencode')
  assert.equal(resolveExecutor('oc').command, 'opencode')
  assert.equal(resolveExecutor('codex-gui').name, 'codex-gui')
  assert.notEqual(resolveExecutor('codex-gui').name, resolveExecutor('codex').name)
  assert.equal(resolveExecutor(undefined).command, 'agy')
  assert.throws(() => resolveExecutor('claude-spark'), /Unsupported executor CLI "claude-spark"/)
  assert.throws(() => resolveExecutor('spark'), /Unsupported executor CLI "spark"/)
  assert.throws(() => resolveExecutor('nonexistent'), /Unsupported executor CLI "nonexistent"/)
  assert.throws(() => EXECUTOR_REGISTRY['codex-gui'].buildArgs({workspace:'/tmp'}, '/prompt', 'hello'), /unavailable/i)
})

test('host transport does not throw when selecting the desktop adapter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-gui-host-'))
  const prior = process.env.EZ_EXECUTOR_TRANSPORT
  try {
    const controlDir = path.join(root, 'control')
    await mkdir(path.join(controlDir, 'host-executor'), { recursive: true })
    await writeFile(path.join(controlDir, 'host-executor/heartbeat.json'), JSON.stringify({ at: Date.now() }))
    process.env.EZ_EXECUTOR_TRANSPORT = 'host'
    const job = await startExecutorJob(['hello'], {
      workspace: root, controlDir, binDir: path.join(root, 'bin'), cli: 'codex-gui', runId: 'r_hostgui', timeoutMs: 1500,
    })
    assert.ok(job.child.pid)
    terminateJob(job.child)
    await new Promise((resolve) => job.child.once('close', resolve))
    await job.cleanup()
  } finally {
    if (prior === undefined) delete process.env.EZ_EXECUTOR_TRANSPORT
    else process.env.EZ_EXECUTOR_TRANSPORT = prior
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex jobs disable global memory and host skill discovery', () => {
  const args = EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent'},'/prompt','hello')
  assert.ok(args.includes('memories'))
  assert.equal(args[args.indexOf('memories')-1],'--disable')
  assert.equal(args[args.indexOf('skip_host_skill_discovery')-1],'--enable')
})

test('Codex plugin access stays scoped to the explicitly bound registry', () => {
  const args=EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent/mind',controlDir:'/agent/control',toolsHome:'/agent/tools'},'', 'install a plugin')
  assert.deepEqual(args.flatMap((arg,i)=>arg==='--add-dir'?[args[i+1]]:[]),['/agent/control','/agent/tools'])
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'))
  assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write')
  assert.ok(!EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent/mind'},'','hello').includes('sandbox_workspace_write.network_access=true'))
})
