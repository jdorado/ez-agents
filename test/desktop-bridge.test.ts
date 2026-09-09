import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DESKTOP_UNAVAILABLE, desktopJobPrompt, runDesktopTurn, type DesktopClient } from '../src/desktop-bridge.js'
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
    close: () => events.removeAllListeners(),
  }
  return client
}

test('desktop prompt carries run identity and tool paths, never a bot token', () => {
  const prompt = desktopJobPrompt('r_gui', ['hello'], undefined, '/tmp/bin', '/tmp/control')
  assert.match(prompt, /EZ_RUN_ID=r_gui/)
  assert.match(prompt, /EZ_CONTROL_DIR=\/tmp\/control/)
  assert.match(prompt, /PATH=\/tmp\/bin:\$PATH/)
  assert.match(prompt, /ezenciel-agents-message/)
  assert.ok(!prompt.includes('TELEGRAM_BOT_TOKEN'))
  assert.ok(!prompt.includes('token'))
})

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
