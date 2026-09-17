import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { connectManagedDesktop, desktopServerRequestResult, DESKTOP_UNAVAILABLE, runDesktopTurn, type DesktopClient } from '../src/desktop-bridge.js'
import { executorKey, nativeSessionId, startExecutorJob } from '../src/executor.js'
import { initialPreset, isPreset, readModels } from '../src/ai.js'

const fakeClient = (script: Array<Record<string, unknown>>): DesktopClient & { calls: string[] } => {
  const calls: string[] = []
  const events = new EventEmitter()
  const client: DesktopClient & { calls: string[] } = {
    calls,
    request: async (method) => {
      calls.push(method)
      const next = script.shift()
      if (!next) throw new Error(`unexpected ${method}`)
      if (next.error) throw new Error(String(next.error))
      setTimeout(() => {
        for (const note of (next.notify as Record<string, unknown>[] | undefined) || []) events.emit('message', note)
      }, 0)
      return (next.result || {}) as Record<string, unknown>
    },
    notify: (method) => { calls.push(method) },
    wait: (match) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(DESKTOP_UNAVAILABLE)), 1000)
      const onMessage = (message: Record<string, unknown>) => {
        if (!match(message)) return
        clearTimeout(timer)
        events.off('message', onMessage)
        resolve(message)
      }
      events.on('message', onMessage)
    }),
    setServerRequestContext: () => {},
    close: () => events.removeAllListeners(),
  }
  return client
}

test('codex-gui is a distinct preset and catalog entry', async () => {
  assert.equal(executorKey('codex-gui'), 'codex-gui')
  assert.equal(initialPreset('codex-gui').cli, 'codex-gui')
  assert.notEqual(initialPreset('codex-gui').cli, initialPreset('codex').cli)
  assert.equal(isPreset({ id: 'x', name: 'Desktop', cli: 'codex-gui' }), true)
  const home = await mkdtemp(path.join(tmpdir(), 'ez-gui-catalog-'))
  try {
    await mkdir(path.join(home, '.codex'))
    await writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: [
      { slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] },
    ] }))
    const models = await readModels(home, async (cli) => cli === 'codex' || cli === 'codex-gui')
    assert.ok(models.some((model) => model.cli === 'codex' && model.model === 'fixture-model'))
    assert.ok(models.some((model) => model.cli === 'codex-gui' && model.model === 'fixture-model'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a dedicated desktop turn emits the thread id and waits for completion', async () => {
  const client = fakeClient([
    { result: {} },
    { result: { thread: { id: 'thr_hello' } } },
    { result: {} },
    { result: { turn: { id: 'turn_1' } }, notify: [{ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } }] },
  ])
  const lines: string[] = []
  const code = await runDesktopTurn({
    workspace: '/tmp/mind', controlDir: '/tmp/control', binDir: '/tmp/bin', runId: 'r_1', prompt: 'hello',
  }, { connect: async () => client, emit: (line) => lines.push(line) })
  assert.equal(code, 0)
  assert.deepEqual(client.calls, ['initialize', 'initialized', 'thread/start', 'thread/name/set', 'turn/start'])
  assert.equal(nativeSessionId('codex-gui', lines[0]), 'thr_hello')
})

test('desktop connection starts the native daemon once when its socket is absent', async () => {
  const client = fakeClient([])
  let attempts = 0, starts = 0
  const connected = await connectManagedDesktop(async () => {
    attempts++
    if (attempts === 1) throw new Error(DESKTOP_UNAVAILABLE)
    return client
  }, async () => { starts++ })
  assert.equal(connected, client)
  assert.equal(attempts, 2)
  assert.equal(starts, 1)
})

test('desktop connection fails closed when the native daemon cannot start', async () => {
  let attempts = 0
  await assert.rejects(connectManagedDesktop(async () => {
    attempts++
    throw new Error(DESKTOP_UNAVAILABLE)
  }, async () => { throw new Error(DESKTOP_UNAVAILABLE) }), /unavailable/i)
  assert.equal(attempts, 1)
})

test('desktop server requests use native response shapes and only accept computer-use elicitations', () => {
  const context = { threadId: 'thread_1', turnId: 'turn_1' }
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, _meta: {
      connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', codex_request_type: 'approval_request',
      tool_name: 'access_browser_origin', origin: 'https://ae.iherb.com',
      tool_params: { origin: 'https://ae.iherb.com' },
    } },
  }, context), { action: 'accept', content: null, _meta: { persist: 'session' } })
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, _meta: {
      connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'js',
      tool_params: { app: 'com.google.Chrome' },
    } },
  }, context), { action: 'accept', content: null, _meta: { persist: 'session' } })
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, _meta: {
      connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'js',
      tool_params: { app: 'com.google.Chrome' },
    } },
  }, { threadId: context.threadId }), { action: 'accept', content: null, _meta: { persist: 'session' } })
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, _meta: {
      connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
      codex_request_type: 'approval_request', tool_name: 'start_audio_recording',
      tool_params: {}, riskLevel: 'high',
    } },
  }, context), { action: 'decline', content: null, _meta: null })
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, _meta: {
      connector_id: 'browser-use', codex_approval_kind: 'mcp_tool_call', codex_request_type: 'approval_request',
      tool_name: 'access_browser_origin', origin: 'file:///tmp/private', tool_params: { origin: 'file:///tmp/private' },
    } },
  }, context), { action: 'decline', content: null, _meta: null })
  assert.deepEqual(desktopServerRequestResult({
    method: 'mcpServer/elicitation/request',
    params: { ...context, turnId: 'other', _meta: {
      connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call', tool_name: 'js',
      tool_params: { app: 'com.google.Chrome' },
    } },
  }, context), { action: 'decline', content: null, _meta: null })
  assert.deepEqual(desktopServerRequestResult({ method: 'item/commandExecution/requestApproval' }), { decision: 'decline' })
  assert.deepEqual(desktopServerRequestResult({ method: 'unknown/request' }), { decision: 'decline' })
})

test('desktop browser authority is scheduled-only and is installed before turn start', async () => {
  for (const runId of ['owner_run', 'r_schedule_browser']) {
    const client = fakeClient([
      { result: {} }, { result: { thread: { id: 'thread_browser' } } }, { result: {} },
      { result: { turn: { id: 'turn_browser' } }, notify: [{ method: 'turn/completed', params: { turn: { id: 'turn_browser', status: 'completed' } } }] },
    ])
    const calls: Array<[string | undefined, string | undefined]> = []
    const policies: unknown[] = []
    const request = client.request
    client.request = async (method, params) => {
      if (method === 'thread/start' || method === 'turn/start') policies.push((params as { approvalPolicy?: unknown }).approvalPolicy)
      return request(method, params)
    }
    client.setServerRequestContext = (threadId, turnId) => { calls.push([threadId, turnId]) }
    assert.equal(await runDesktopTurn({
      workspace: '/tmp/mind', controlDir: '/tmp/control', binDir: '/tmp/bin', runId, prompt: 'browser test',
    }, { connect: async () => client, emit: () => {} }), 0)
    assert.deepEqual(calls, runId.startsWith('r_schedule_')
      ? [['thread_browser', undefined], ['thread_browser', 'turn_browser']]
      : [[undefined, undefined]])
    assert.deepEqual(policies, runId.startsWith('r_schedule_') ? ['on-request', 'on-request'] : ['never', 'never'])
  }
})

test('a UUID-shaped desktop thread is resumed instead of starting another task', async () => {
  const threadId = '01a07b96-2681-72f2-ae6c-6f77fe823a8c'
  const client = fakeClient([
    { result: {} },
    { result: { thread: { id: threadId } } },
    { result: { turn: { id: 'turn_3' } }, notify: [{ method: 'turn/completed', params: { turn: { id: 'turn_3', status: 'completed' } } }] },
  ])
  const code = await runDesktopTurn({
    workspace: '/tmp/mind', controlDir: '/tmp/control', binDir: '/tmp/bin', runId: 'r_3', prompt: 'hello again',
    sessionId: threadId, isResume: true,
  }, { connect: async () => client, emit: () => {} })
  assert.equal(code, 0)
  assert.ok(client.calls.includes('thread/resume'))
  assert.ok(!client.calls.includes('thread/start'))
  assert.equal(nativeSessionId('codex-gui', JSON.stringify({ type: 'thread.started', thread_id: threadId })), threadId)
})

test('desktop plugin access matches CLI on new and resumed turns without granting other roots',async()=>{
 for(const isResume of [false,true])for(const toolsHome of [undefined,'/tmp/agent-tools']) {
  const client=fakeClient([{result:{}},{result:{thread:{id:'thr_plugins'}}},...(!isResume?[{result:{}}]:[]),{result:{turn:{id:'turn_plugins'}},notify:[{method:'turn/completed',params:{turn:{id:'turn_plugins',status:'completed'}}}]}]);
  const original=client.request;let policy:unknown;
  client.request=async(method,params)=>{if(method==='turn/start')policy=(params as any).sandboxPolicy;return original(method,params)};
  assert.equal(await runDesktopTurn({workspace:'/tmp/mind',controlDir:'/tmp/control',binDir:'/tmp/bin',toolsHome,runId:'r_plugins',prompt:'check',isResume,sessionId:isResume?'thr_plugins':undefined},{connect:async()=>client,emit:()=>{}}),0);
  assert.deepEqual(policy,{type:'workspaceWrite',writableRoots:['/tmp/control',...(toolsHome?[toolsHome]:[])],networkAccess:Boolean(toolsHome)});
 }
});

test('stop interrupts the in-flight desktop turn before releasing', async () => {
  const abort = new AbortController()
  const client = fakeClient([
    { result: {} },
    { result: { thread: { id: 'thr_stop' } } },
    { result: { turn: { id: 'turn_2' } } },
    { result: {}, notify: [{ method: 'turn/completed', params: { turn: { id: 'turn_2', status: 'interrupted' } } }] },
  ])
  const original = client.request
  client.request = async (method, params) => {
    const result = await original(method, params)
    if (method === 'turn/start') queueMicrotask(() => abort.abort())
    return result
  }
  const code = await runDesktopTurn({
    workspace: '/tmp/mind', controlDir: '/tmp/control', binDir: '/tmp/bin', runId: 'r_2', prompt: 'hello',
    sessionId: 'thr_stop', isResume: true,
  }, { connect: async () => client, emit: () => {}, signal: abort.signal })
  assert.equal(code, 130)
  assert.ok(client.calls.includes('thread/resume'))
  assert.ok(client.calls.includes('turn/interrupt'))
})

test('an unavailable desktop fails closed without spawning Codex CLI', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ez-gui-off-'))
  const priorHome = process.env.HOME
  const priorPath = process.env.PATH
  try {
    await mkdir(path.join(home, 'bin'))
    await writeFile(path.join(home, 'bin/codex'), `#!${process.execPath}\nconsole.error('CLI fallback');\nprocess.exit(0)\n`, { mode: 0o700 })
    process.env.HOME = home
    process.env.PATH = path.join(home, 'bin')
    await ownerRun(home, 'r_off')
    const job = await startExecutorJob(['hello'], {
      workspace: home, controlDir: home, binDir: path.join(home, 'bin'), cli: 'codex-gui', runId: 'r_off', timeoutMs: 4000,
    })
    let stderr = ''
    job.child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((resolve) => job.child.once('close', resolve))
    await job.cleanup()
    assert.notEqual(code, 0)
    assert.match(stderr, /unavailable/i)
    assert.ok(!stderr.includes('CLI fallback'))
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath
    await rm(home, { recursive: true, force: true })
  }
})

test('unlimited desktop waits reject on disconnect and do not miss an early completion',async()=>{
 const {PassThrough}=await import('node:stream')
 const {attachClient}=await import('../src/desktop-bridge.js')
 const socket=new PassThrough()
 const client=attachClient(socket as unknown as import('node:net').Socket)
 const waiting=client.wait(()=>false,0)
 const rejected=assert.rejects(waiting,/desktop|Codex|unavailable/i)
 socket.destroy();await rejected
 await assert.rejects(client.wait(()=>true,0),/desktop|Codex|unavailable/i)
 await assert.rejects(client.request('test',{}),/desktop|Codex|unavailable/i)
 const other=new PassThrough(),early=attachClient(other as unknown as import('node:net').Socket)
 const payload=Buffer.from(JSON.stringify({method:'turn/completed'}))
 other.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]))
 assert.equal((await early.wait(m=>m.method==='turn/completed',0)).method,'turn/completed')
 early.close()
})

test('desktop fresh and resumed turns bind current run environment without prompt prose',async()=>{
 for(const isResume of [false,true]) {
  const text=' /goal audit list of files and give me a simple list with filenames\n'
  const client=fakeClient([{result:{}},{result:{thread:{id:'native-env'}}},...(!isResume?[{result:{}}]:[]),{result:{turn:{id:'env-turn'}},notify:[{method:'turn/completed',params:{turn:{id:'env-turn',status:'completed'}}}]}])
  const original=client.request;let nativeConfig:any,submitted:any
  client.request=async(method,params)=>{if(method===`thread/${isResume?'resume':'start'}`)nativeConfig=(params as any).config;if(method==='turn/start')submitted=params;return original(method,params)}
  assert.equal(await runDesktopTurn({workspace:'/mind',controlDir:'/control',binDir:'/bin',runId:'r_current',repairEnabled:false,prompt:text,isResume,sessionId:'native-env'},{connect:async()=>client,emit:()=>{}}),0)
  assert.deepEqual(submitted.input,[{type:'text',text}])
  assert.equal(nativeConfig['shell_environment_policy.inherit'],'none')
  assert.equal(nativeConfig['shell_environment_policy.set'].EZ_RUN_ID,'r_current')
  assert.equal(nativeConfig['shell_environment_policy.set'].EZ_CONTROL_DIR,'/control')
  assert.equal(nativeConfig['shell_environment_policy.set'].EZ_REPAIR_ENABLED,'false')
  assert.equal(nativeConfig['shell_environment_policy.set'].TELEGRAM_BOT_TOKEN,undefined)
 }
})
