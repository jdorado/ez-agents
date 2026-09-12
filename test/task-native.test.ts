import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { taskArguments, taskModelCatalog, TASK_CODEX_VERSION } from '../src/task-executor.js'
import { Tasks } from '../src/tasks.js'
import { ownerRun } from './helpers/owner-run.js'
import { EventSources } from '../src/event-sources.js'
import { ControlStore } from '../src/control-state.js'
import { ApprovalStore } from '../src/approval.js'
import { RunStore } from '../src/runs.js'
import { taskRequests } from '../src/task-rpc.js'

// Real bundled model metadata plus native CLI, synthetic endpoint, no credentials or provider sends.
// Unknown fixture model names miss model-driven tool overrides.
// Run explicitly with EZ_TEST_NATIVE_TASKS=1 after installing the audited CLI.
test('native restricted task has only bounded MCP tools, ignores private guidance, and executes broker calls', { skip: !process.env.EZ_TEST_NATIVE_TASKS, timeout: 30000 }, async () => {
  const root = await mkdtemp('/tmp/ez-native-task-'), directory = `${root}/task`, home = `${root}/home`
  await mkdir(directory); await mkdir(home)
  await writeFile(`${root}/AGENTS.md`, 'PRIVATE_CANARY_DO_NOT_LOAD')
  await writeFile(`${home}/config.toml`, 'invalid = [ syntax')
  const requests: any[] = [], sends: any[] = []
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const { command, args } = JSON.parse(body)
    res.end(JSON.stringify({ ok: true, data: command === 'events-head' ? { cursor: 0, accountId: 'fixture-account', taskProtocol: 'message-v1' }
      : command === 'task-send' ? (sends.push(args), { ...args, state: 'accepted' }) : {} }))
  })
  await new Promise<void>(r => provider.listen(`${root}/p.sock`, r))
  await ownerRun(root, 'owner')
  await new EventSources(root).register('fixture', `${root}/p.sock`, (await new ControlStore(root, 900000).status()).owner!)
  const tasks = new Tasks(root), drain = taskRequests(tasks)
  const proposal: any = await tasks.ownerCall('owner', 'propose', { sourceId: 'fixture', conversationId: 'contact-a', purpose: 'Book dinner without payment', context: 'Two people at 7pm', hours: 1 })
  await new ApprovalStore(root).recordDecision(proposal.id, 'approved', 101)
  await tasks.decide(proposal.id)
  const runs = new RunStore(root), run = (await runs.list()).find(r => r.taskId)!
  await runs.patch(run.id, { status: 'running' })
  const sequence = [
    ['context', {}], ['send', { text: 'Is a table for two available at 7pm?', key: 'first' }],
    ['note', { text: 'Awaiting confirmation' }], ['complete', { text: 'Request sent; no booking confirmation received.' }],
    ['send', { text: 'A completed task cannot send', key: 'second' }],
  ]
  const timer = setInterval(() => { void drain() }, 10)
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end(JSON.stringify({ data: [] })); return; }
    let body = ''; for await (const c of req) body += c
    const input = JSON.parse(body); requests.push(input)
    res.setHeader('Content-Type', 'text/event-stream')
    const step = sequence[requests.length - 1]
    const output = step ? [{ type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: step[0], namespace: 'mcp__ez', arguments: JSON.stringify(step[1]) }] : []
    if (output.length) {
      res.write('event: response.output_item.added\ndata: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], arguments: '' } }) + '\n\n')
      res.write('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: output[0] }) + '\n\n')
    }
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: `resp_${requests.length}`, object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) + '\n\n')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const broker = [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../src/task-mcp.ts', import.meta.url)), root, run.id]
    const catalog = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], { maxBuffer: 4 * 1024 * 1024 });
    await writeFile(`${root}/models.json`, JSON.stringify(taskModelCatalog(JSON.parse(catalog.stdout))));
    const args = taskArguments(directory, broker, JSON.stringify({event:'task_activated',taskId:proposal.id}), undefined, {model:'gpt-6-astra'})
    args.splice(-1, 0, '--disable', 'enable_request_compression', '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${(server.address() as any).port}/v1",wire_api="responses",requires_openai_auth=false}`)
    child = spawn('codex', args, { cwd: directory, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin!.end(JSON.stringify({event:'task_activated',taskId:proposal.id}));
    let stderr = ''; child.stderr!.on('data', c => { stderr += c }); child.stdout!.resume()
    const code = await new Promise(r => child!.on('close', r))
    assert.equal(code, 0, `Requires audited Codex ${TASK_CODEX_VERSION}: ${stderr}`)
    assert.ok(requests.length === 6, 'Native tool call completed a second model turn')
    assert.ok(!JSON.stringify(requests).includes('PRIVATE_CANARY_DO_NOT_LOAD'))
    const messages=requests[0].input.filter((v:any)=>v.role==='user')
    assert.ok(messages.some((m:any)=>m.content.some((c:any)=>c.text===JSON.stringify({event:'task_activated',taskId:proposal.id}))))
    const tools = requests[0].tools ?? requests[0].input.find((v: any) => v.type === 'additional_tools')?.tools
    assert.deepEqual(tools.filter((t: any) => t.type === 'function').map((t: any) => t.name).sort(), ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'request_user_input'])
    const namespaces = tools.filter((t: any) => t.type === 'namespace')
    assert.equal(namespaces.length, 1); assert.equal(namespaces[0].name, 'mcp__ez')
    assert.deepEqual(namespaces[0].tools.map((t: any) => t.name).sort(), ['complete', 'context', 'note', 'report', 'send'])
    assert.match(JSON.stringify(requests[5].input), /inactive or expired/)
    assert.equal(sends.length, 1); assert.equal(sends[0].conversationId, 'contact-a')
    assert.equal((await tasks.get(proposal.id))!.state, 'completed')
  } finally {
    child?.kill(); clearInterval(timer); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()))
    await rm(root, { recursive: true, force: true })
  }
})
