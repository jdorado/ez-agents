import { ownerRun } from './helpers/owner-run.js'
import { RunStore } from '../src/runs.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXECUTOR_REGISTRY, antigravityInvocation, executorEnvironment, grokInvocation, grokJobEnv, opencodeDataHome, opencodeInvocation, piAgentDir, resolveExecutor, resolveHostCommand, startExecutorJob, terminateJob, validateCodexProvider } from '../src/executor.js'
import { requireOwnerExecution } from '../src/execution-authority.js'
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

test('native CLIs resolve from the host PATH, not a relative package name', () => {
  assert.equal(resolveHostCommand('/usr/bin/codex'), '/usr/bin/codex')
  assert.throws(() => resolveHostCommand('missing-cli-xyz', '/usr/bin'), /not executable on the host PATH/)
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
  assert.equal(environment.EZ_DELIVERY_SOCKET, '/tmp/control/delivery.sock')
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
  assert.throws(() => resolveExecutor('unreal-agent'), /Unsupported executor CLI/)
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

test('Codex custom providers use declared runtime state and an environment key reference', () => {
  const provider=validateCodexProvider({id:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1/',envKey:'OPENROUTER_API_KEY',models:['google/gemini-3.8-flash']})
  const args=EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent',model:'google/gemini-3.8-flash',codexProvider:provider},'','hello')
  assert.ok(args.includes('model_provider="openrouter"'))
  assert.ok(args.some(value=>value.includes('env_key="OPENROUTER_API_KEY"')))
  assert.ok(args.includes('google/gemini-3.8-flash'))
  assert.equal(JSON.stringify(args).includes('provider-secret'),false)
  assert.throws(()=>validateCodexProvider({...provider,envKey:'TELEGRAM-BOT'}),/environment key/)
  for (const envKey of ['PATH','HOME','CODEX_HOME','NODE_OPTIONS','EZ_CONTROL_DIR','TELEGRAM_BOT_TOKEN'])
    assert.throws(()=>validateCodexProvider({...provider,envKey}),/Reserved/)
  assert.throws(()=>validateCodexProvider({...provider,models:[]}),/provider models/)
})

test('opencode jobs use the agent-bound data home only when its auth binding exists', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-opencode-auth-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=path.join(root,'bin');await mkdir(bin)
  await writeFile(path.join(bin,'opencode'),`#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(root,'observed.json'))},JSON.stringify({args:process.argv.slice(2),xdg:process.env.XDG_DATA_HOME,telegram:process.env.TELEGRAM_BOT_TOKEN}));`,{mode:0o755})
  assert.equal(opencodeDataHome(root),undefined)
  await mkdir(path.join(root,'cli','opencode'),{recursive:true})
  assert.equal(opencodeDataHome(root),undefined)
  await writeFile(path.join(root,'cli','opencode','auth.json'),'{}',{mode:0o600})
  assert.equal(opencodeDataHome(root),path.join(root,'cli'))
  const prior={path:process.env.PATH,telegram:process.env.TELEGRAM_BOT_TOKEN,transport:process.env.EZ_EXECUTOR_TRANSPORT}
  const launch=async(runId:string)=>{
    await ownerRun(root,runId)
    process.env.PATH=bin+path.delimiter+prior.path;process.env.TELEGRAM_BOT_TOKEN='relay-secret';delete process.env.EZ_EXECUTOR_TRANSPORT
    const job=await startExecutorJob(['hello'],{workspace:root,controlDir:root,binDir:bin,runId,timeoutMs:0,cli:'opencode',model:'opencode-go/muse-spark-1.3-contributor',effort:'xhigh'})
    assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0);await job.cleanup()
    return JSON.parse(await readFile(path.join(root,'observed.json'),'utf8'))
  }
  try {
    const bound=await launch('r_ocbound')
    assert.equal(bound.xdg,path.join(root,'cli'))
    assert.equal(bound.telegram,undefined)
    assert.equal(bound.args[bound.args.indexOf('-m')+1],'opencode-go/muse-spark-1.3-contributor')
    assert.equal(bound.args[bound.args.indexOf('--variant')+1],'xhigh')
    await rm(path.join(root,'cli','opencode','auth.json'))
    const free=await launch('r_ocfree')
    assert.equal(free.xdg,undefined)
    assert.equal(free.telegram,undefined)
  } finally {
    if(prior.path===undefined)delete process.env.PATH;else process.env.PATH=prior.path
    if(prior.telegram===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=prior.telegram
    if(prior.transport===undefined)delete process.env.EZ_EXECUTOR_TRANSPORT;else process.env.EZ_EXECUTOR_TRANSPORT=prior.transport
  }
})

test('pi jobs use the agent-bound config dir only when its auth binding exists', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-pi-auth-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=path.join(root,'bin');await mkdir(bin)
  await writeFile(path.join(bin,'pi'),`#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(root,'observed.json'))},JSON.stringify({args:process.argv.slice(2),agentDir:process.env.PI_CODING_AGENT_DIR,telegram:process.env.TELEGRAM_BOT_TOKEN}));`,{mode:0o755})
  assert.equal(piAgentDir(root),undefined)
  await mkdir(path.join(root,'cli','pi','agent'),{recursive:true})
  assert.equal(piAgentDir(root),undefined)
  await writeFile(path.join(root,'cli','pi','agent','auth.json'),'{}',{mode:0o600})
  assert.equal(piAgentDir(root),path.join(root,'cli','pi','agent'))
  const prior={path:process.env.PATH,telegram:process.env.TELEGRAM_BOT_TOKEN,transport:process.env.EZ_EXECUTOR_TRANSPORT,agentDir:process.env.PI_CODING_AGENT_DIR}
  const launch=async(runId:string)=>{
    await ownerRun(root,runId)
    process.env.PATH=bin+path.delimiter+prior.path;process.env.TELEGRAM_BOT_TOKEN='relay-secret';delete process.env.EZ_EXECUTOR_TRANSPORT;delete process.env.PI_CODING_AGENT_DIR
    const job=await startExecutorJob(['hello'],{workspace:root,controlDir:root,binDir:bin,runId,timeoutMs:0,cli:'pi',model:'opencode-go/muse-spark-1.3-contributor',effort:'xhigh'})
    assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0);await job.cleanup()
    return JSON.parse(await readFile(path.join(root,'observed.json'),'utf8'))
  }
  try {
    const bound=await launch('r_pibound')
    assert.equal(bound.agentDir,path.join(root,'cli','pi','agent'))
    assert.equal(bound.telegram,undefined)
    assert.equal(bound.args[bound.args.indexOf('--model')+1],'opencode-go/muse-spark-1.3-contributor')
    assert.equal(bound.args[bound.args.indexOf('--thinking')+1],'xhigh')
    await rm(path.join(root,'cli','pi','agent','auth.json'))
    const free=await launch('r_pifree')
    assert.equal(free.agentDir,undefined)
    assert.equal(free.telegram,undefined)
    // Owner-provisioned delivery skill loads by path; absence keeps prior args.
    assert.ok(!bound.args.includes('--skill'))
    await mkdir(path.join(root,'cli','pi','skills','ez-delivery'),{recursive:true})
    await writeFile(path.join(root,'cli','pi','skills','ez-delivery','SKILL.md'),'# delivery',{mode:0o644})
    const skilled=await launch('r_piskilled')
    assert.equal(skilled.args[skilled.args.indexOf('--skill')+1],path.join(root,'cli','pi','skills','ez-delivery'))
  } finally {
    if(prior.path===undefined)delete process.env.PATH;else process.env.PATH=prior.path
    if(prior.telegram===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=prior.telegram
    if(prior.transport===undefined)delete process.env.EZ_EXECUTOR_TRANSPORT;else process.env.EZ_EXECUTOR_TRANSPORT=prior.transport
    if(prior.agentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior.agentDir
  }
})

test('the pi invocation pins control sessions, model, and thinking level', () => {
  assert.equal(resolveExecutor('pi').command, 'pi')
  const args = EXECUTOR_REGISTRY.pi.buildArgs(
    { workspace: '/agent/mind', controlDir: '/agent/control', sessionId: 'ez-session', isResume: true, model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh' },
    '/prompt', 'review CAMT')
  assert.deepEqual(args, ['-p', '--mode', 'json', '--session-dir', '/agent/control/cli/pi/sessions', '--session-id', 'ez-session',
    '--model', 'opencode-go/muse-spark-1.3-contributor', '--thinking', 'xhigh', '--', 'review CAMT'])
  const other = EXECUTOR_REGISTRY.pi.buildArgs({ workspace: '/agent/mind', controlDir: '/agent/control', sessionId: 'other-session', isResume: true }, '/prompt', 'other')
  assert.equal(other[other.indexOf('--session-id') + 1], 'other-session')
  assert.ok(!other.includes('--continue'))
  assert.throws(() => EXECUTOR_REGISTRY.pi.buildArgs({ workspace: '/agent' }, '/prompt', 'hi'), /bound control directory/)
})

test('pi jobs run with control-bound sessions and no secret leakage', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-pi-auth-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'); await mkdir(bin)
  await writeFile(path.join(bin, 'pi'), `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(root, 'observed.json'))},JSON.stringify({args:process.argv.slice(2),telegram:process.env.TELEGRAM_BOT_TOKEN}));`, { mode: 0o755 })
  const prior = { path: process.env.PATH, telegram: process.env.TELEGRAM_BOT_TOKEN, transport: process.env.EZ_EXECUTOR_TRANSPORT }
  try {
    await ownerRun(root, 'r_pibound')
    process.env.PATH = bin + path.delimiter + prior.path; process.env.TELEGRAM_BOT_TOKEN = 'relay-secret'; delete process.env.EZ_EXECUTOR_TRANSPORT
    const job = await startExecutorJob(['review CAMT'], { workspace: root, controlDir: root, binDir: bin, runId: 'r_pibound', timeoutMs: 0, cli: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', effort: 'xhigh' })
    assert.equal(await new Promise(resolve => job.child.once('close', resolve)), 0); await job.cleanup()
    const observed = JSON.parse(await readFile(path.join(root, 'observed.json'), 'utf8'))
    assert.deepEqual(observed.args, ['-p', '--mode', 'json', '--session-dir', path.join(root, 'cli', 'pi', 'sessions'),
      '--model', 'opencode-go/muse-spark-1.3-contributor', '--thinking', 'xhigh', '--', 'review CAMT'])
    assert.equal(observed.telegram, undefined)
  } finally {
    if (prior.path === undefined) delete process.env.PATH; else process.env.PATH = prior.path
    if (prior.telegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prior.telegram
    if (prior.transport === undefined) delete process.env.EZ_EXECUTOR_TRANSPORT; else process.env.EZ_EXECUTOR_TRANSPORT = prior.transport
  }
})
test('a configured Codex provider receives only its declared key and runtime selection', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-codex-provider-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const bin=path.join(root,'bin');await mkdir(bin)
  await writeFile(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('fs');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(path.join(root,'observed.json'))},JSON.stringify({args:process.argv.slice(2),key:process.env.OPENROUTER_API_KEY,telegram:process.env.TELEGRAM_BOT_TOKEN,text})));`,{mode:0o755})
  const prior={path:process.env.PATH,key:process.env.OPENROUTER_API_KEY,telegram:process.env.TELEGRAM_BOT_TOKEN}
  const provider=validateCodexProvider({id:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',envKey:'OPENROUTER_API_KEY',models:['google/gemini-3.8-flash']})
  await ownerRun(root,'r_provider')
  try {
    process.env.PATH=bin+path.delimiter+prior.path;process.env.OPENROUTER_API_KEY='provider-secret';process.env.TELEGRAM_BOT_TOKEN='relay-secret'
    const job=await startExecutorJob(['hello'],{workspace:root,controlDir:root,binDir:bin,runId:'r_provider',timeoutMs:0,cli:'codex',provider:'openrouter',model:'google/gemini-3.8-flash',codexProvider:provider})
    assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0);await job.cleanup()
    const observed=JSON.parse(await readFile(path.join(root,'observed.json'),'utf8'))
    assert.equal(observed.key,'provider-secret');assert.equal(observed.telegram,undefined);assert.equal(observed.text,'hello')
    assert.ok(observed.args.includes('model_provider="openrouter"'));assert.ok(observed.args.includes('google/gemini-3.8-flash'))
  } finally {
    for(const [key,value] of [['PATH',prior.path],['OPENROUTER_API_KEY',prior.key],['TELEGRAM_BOT_TOKEN',prior.telegram]]) if(value===undefined)delete process.env[key!];else process.env[key!]=value
  }
})

test('Codex plugin access stays scoped to the explicitly bound registry', () => {
  const args=EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent/mind',controlDir:'/agent/control',toolsHome:'/agent/tools',sharedWorkspace:'/app',additionalWorkspaces:['/agent/mind/work']},'', 'install a plugin')
  assert.deepEqual(args.flatMap((arg,i)=>arg==='--add-dir'?[args[i+1]]:[]),['/agent/control','/app','/agent/mind/work','/agent/tools'])
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

test('Codex external isolation changes only explicit sandbox argv and never enters child environment', () => {
  const args = EXECUTOR_REGISTRY.codex.buildArgs({workspace:'/agent',codexSandbox:'external',sessionId:'native-id',isResume:true},'', 'hello')
  assert.equal(args[args.indexOf('--sandbox')+1], 'danger-full-access')
  assert.ok(args.includes('native-id'))
  assert.equal(executorEnvironment({EZ_CODEX_SANDBOX:'external'}).EZ_CODEX_SANDBOX, undefined)
})

test('external Codex isolation cannot launch host runs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-external-sandbox-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  await ownerRun(root,'r_sandbox')
  const previous = process.env.EZ_EXECUTOR_TRANSPORT
  try {
    for (const transport of ['host','']) {
      process.env.EZ_EXECUTOR_TRANSPORT=transport
      await assert.rejects(startExecutorJob(['Hello'],{workspace:root,controlDir:root,binDir:root,runId:'r_sandbox',timeoutMs:0,cli:'codex',codexSandbox:'external'}), /owner-authorized native local/)
    }
  } finally {
    if (previous === undefined) delete process.env.EZ_EXECUTOR_TRANSPORT
    else process.env.EZ_EXECUTOR_TRANSPORT=previous
  }
})

test('external local owner chat preserves literal input and admission rejects foreign or restricted runs', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-external-owner-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const prior={path:process.env.PATH,transport:process.env.EZ_EXECUTOR_TRANSPORT}
  const bin=path.join(root,'bin');await mkdir(bin)
  await writeFile(path.join(bin,'codex'),`#!/usr/bin/env node\nconst fs=require('fs');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(path.join(root,'observed.json'))},JSON.stringify({args:process.argv.slice(2),text,secret:process.env.TELEGRAM_BOT_TOKEN})));`,{mode:0o755})
  await ownerRun(root,'r_owner_external')
  const opts={workspace:root,controlDir:root,binDir:bin,runId:'r_owner_external',timeoutMs:0,cli:'codex',codexSandbox:'external' as const}
  try {
    process.env.PATH=bin+path.delimiter+prior.path;process.env.EZ_EXECUTOR_TRANSPORT='local'
    const job=await startExecutorJob(['  literal /goal request\n'],opts)
    const code=await new Promise(resolve=>job.child.once('close',resolve));await job.cleanup()
    assert.equal(code,0)
    const observed=JSON.parse(await readFile(path.join(root,'observed.json'),'utf8'))
    assert.equal(observed.text,'  literal /goal request\n')
    assert.equal(observed.args[observed.args.indexOf('--sandbox')+1],'danger-full-access')
    assert.equal(observed.secret,undefined)
    const runs=new RunStore(root)
    await runs.create({id:'r_foreign',chatId:999,telegramUserId:999,texts:['no']})
    await runs.patch('r_foreign',{status:'running'})
    await assert.rejects(requireOwnerExecution(root,'r_foreign'),/blocked: owner-mismatch/i)
    await runs.create({id:'r_restricted',chatId:101,telegramUserId:101,texts:['no'],taskId:'task_'+'a'.repeat(32)})
    await runs.patch('r_restricted',{status:'running'})
    await assert.rejects(requireOwnerExecution(root,'r_restricted'),/external-execution-unavailable/)
  } finally {
    if(prior.path===undefined)delete process.env.PATH;else process.env.PATH=prior.path
    if(prior.transport===undefined)delete process.env.EZ_EXECUTOR_TRANSPORT;else process.env.EZ_EXECUTOR_TRANSPORT=prior.transport
  }
})
