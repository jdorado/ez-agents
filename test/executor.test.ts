import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXECUTOR_REGISTRY, antigravityInvocation, executorEnvironment, grokInvocation, grokJobEnv, opencodeInvocation, resolveExecutor, startExecutorJob, terminateJob } from '../src/executor.js'
import { splitTelegramText } from '../src/reply.js'
import { matchingProcessIds, processSnapshot } from '../src/process-tree.js'

test('cancellation escalation excludes exited, reused and unreadable process identities', () => {
  const original = new Map([[11,{parent:1,birth:'100'}],[12,{parent:11,birth:'101'}],[13,{parent:11,birth:'102'}],[14,{parent:11,birth:''}]])
  const current = new Map([[12,{parent:1,birth:'101'}],[13,{parent:1,birth:'999'}],[14,{parent:1,birth:''}]])
  assert.deepEqual(matchingProcessIds(original,current),[12])
})

test('cancellation stops detached tool descendants even after their parent exits', {skip:process.platform==='win32'}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-cancel-tree-'))
  const heartbeat = path.join(root,'heartbeat')
  const tool = `const fs=require('fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30)`
  const parent = spawn(process.execPath,['-e', `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(tool)}],{detached:true,stdio:'ignore'}); setInterval(()=>{},1000)`],{detached:true,stdio:'ignore'})
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
  try {
    const deadline = Date.now()+5000
    while (!await readFile(heartbeat,'utf8').catch(()=>'')) {
      assert.ok(Date.now()<deadline,'detached tool must start')
      await new Promise(resolve=>setTimeout(resolve,30))
    }
    const closed = new Promise(resolve=>parent.once('close',resolve))
    terminateJob(parent, async () => {
      const snapshot = await processSnapshot()
      parent.kill('SIGTERM')
      await closed // Root exit during inspection must not abandon captured tools.
      return snapshot
    }); terminateJob(parent)
    await closed
    await new Promise(resolve=>setTimeout(resolve,3300))
    const last = await readFile(heartbeat,'utf8')
    await new Promise(resolve=>setTimeout(resolve,150))
    assert.equal(await readFile(heartbeat,'utf8'),last,'detached tool must stop updating')
    assert.doesNotThrow(()=>process.kill(unrelated.pid!,0),'unrelated executor stays alive')
  } finally {
    terminateJob(parent); terminateJob(unrelated)
    await rm(root,{recursive:true,force:true})
  }
})

test('Telegram replies are split within the configured message limit', () => {
  const text = `${'a'.repeat(9)} ${'b'.repeat(9)} ${'c'.repeat(9)}`
  const chunks = splitTelegramText(text, 10)
  assert.deepEqual(chunks, ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc'])
  assert.ok(chunks.every((chunk) => chunk.length <= 10))
})

test('the executor receives a deliberately small environment', () => {
  const environment = executorEnvironment({ PATH: '/bin', HOME: '/tmp/home', TELEGRAM_BOT_TOKEN: 'secret', PAGERDUTY_ROUTING_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' })
  assert.deepEqual(environment, { PATH: '/bin', HOME: '/tmp/home' })
  assert.ok(!('TELEGRAM_BOT_TOKEN' in environment))
  assert.ok(!('PAGERDUTY_ROUTING_KEY' in environment))
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
    '--dangerously-skip-permissions', '--print=test prompt',
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
    '--',
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
    await ownerRun(controlDir, 'r_hostgui')
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

test('Codex compaction preserves native resume and validates transported options',()=>{
 const args=EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent',sessionId:'native-id',isResume:true,codexAutoCompactTokens:32000},'', 'hello')
 assert.ok(args.includes('model_auto_compact_token_limit=32000'))
 assert.deepEqual(args.slice(-3),['resume','native-id','-'])
 assert.ok(!EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent'},'','hello').some(a=>a.includes('model_auto_compact_token_limit')))
 for(const value of [0,-1,NaN,1.5]) assert.throws(()=>EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent',codexAutoCompactTokens:value},'','hello'),/compaction/)
 assert.ok(!EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/agent',codexAutoCompactTokens:32000},'','hello').some(arg=>arg.includes('compact')))
})


test('adapters do not append instruction files or impose a workflow turn budget', () => {
 const opts={workspace:'/agent/work/tasks/example'}
 assert.ok(!EXECUTOR_REGISTRY.claude.buildArgs(opts,'','literal').includes('--append-system-prompt-file'))
 assert.ok(!EXECUTOR_REGISTRY.grok.buildArgs(opts,'/tmp/prompt','literal').includes('--max-turns'))
})
