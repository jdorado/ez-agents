import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import {createServer as createNetServer} from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { taskArguments, taskModelCatalog, TASK_CODEX_VERSION } from '../src/task-executor.js'
import { Tasks } from '../src/tasks.js'
import { ownerRun } from './helpers/owner-run.js'
import { EventSources } from '../src/event-sources.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import {ApplicationBindings} from '../src/application-channel.js'
import { taskRequests } from '../src/task-rpc.js'

// Real bundled model metadata plus native CLI, synthetic endpoint, no credentials or provider sends.
// Unknown fixture model names miss model-driven tool overrides.
// Run explicitly with EZ_TEST_NATIVE_TASKS=1 after installing the audited CLI.
test('native restricted task has only bounded MCP tools, ignores private guidance, and executes broker calls', { skip: !process.env.EZ_TEST_NATIVE_TASKS, timeout: 30000 }, async () => {
  assert.equal((await promisify(execFile)('codex',['--version'])).stdout.trim(), `codex-cli ${TASK_CODEX_VERSION}`)
  const root = await mkdtemp('/tmp/ez-native-task-'), directory = `${root}/task`, home = `${root}/home`
  await mkdir(directory); await mkdir(home)
  await writeFile(`${root}/AGENTS.md`, 'PRIVATE_CANARY_DO_NOT_LOAD')
  await writeFile(`${home}/config.toml`, 'invalid = [ syntax')
  const requests: any[] = [], sends: any[] = []
  const incoming={id:'1',conversationId:'contact-a',receivedAt:Date.now()+1000,text:'shop.txt attached'}
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')
  const videoPath = `${root}/fixture.mp4`
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:d=1','-c:v','mpeg4',videoPath])
  const video=await readFile(videoPath)
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const { command, args } = JSON.parse(body)
    res.end(JSON.stringify({ ok: true, data: command === 'events-head' ? { cursor: 0, accountId: 'fixture-account', taskProtocol: 'message-v1',taskVoice:true }
      : command === 'events-check' ? {events:[incoming,{...incoming,id:'2',text:'image.png attached'},{...incoming,id:'3',text:'video.mp4 attached; speech transcript: Shop closes at 6pm.'}]}
      : command === 'task-document' && args.incomingId === '3' ? {name:'video.mp4',data:video.toString('base64'),sha256:createHash('sha256').update(video).digest('hex')}
      : command === 'task-document' && args.incomingId === '2' ? {name:'image.png',data:png.toString('base64'),sha256:createHash('sha256').update(png).digest('hex')}
      : command === 'task-document' ? {name:'shop.txt',data:Buffer.from('Shop opens at 7am.').toString('base64'),sha256:createHash('sha256').update('Shop opens at 7am.').digest('hex')}
      : command === 'task-send' ? (sends.push(args), { ...args, state: 'accepted' }) : {} }))
  })
  await new Promise<void>(r => provider.listen(`${root}/p.sock`, r))
  await ownerRun(root, 'owner')
  await new EventSources(root).register('fixture', `${root}/p.sock`, (await new ControlStore(root, 900000).status()).owner!)
  const tasks = new Tasks(root,async () => ({buffer:Buffer.from('OggSfixture OpusHead'),mimeType:'audio/ogg'})), drain = taskRequests(tasks)
  const proposal: any = await tasks.ownerCall('owner', 'start', { sourceId: 'fixture', conversationId: 'contact-a', purpose: 'Book dinner without payment', context: 'Two people at 7pm', hours: 1 })
  assert.equal(proposal.state, 'active')
  const runs = new RunStore(root), run = await runs.create({id:'event_document_fixture',taskId:proposal.id,chatId:101,telegramUserId:101,texts:[],external:{sourceId:'fixture',bindingId:(await tasks.get(proposal.id))!.bindingId,eventIds:['1','2','3']}})
  await runs.patch(run.id, { status: 'running' })
  const bindings=new ApplicationBindings(root), owner=(await new ControlStore(root,900000).status()).owner!
  await bindings.register('browser','z'.repeat(48),owner)
  await bindings.taskLaunch('browser',{command:'fixture',args:['launch','--task'],tasks:[proposal.id]})
  let launchRequests=0
  const launchSocket=`${root}/launch.sock`
  const launchBroker=createNetServer(socket=>{
    let raw='';socket.on('data',chunk=>{raw+=chunk;if(!raw.includes('\n'))return;void(async()=>{
      const request=JSON.parse(raw.trim()),input=JSON.parse(request.stdin)
      assert.equal(request.operation,'task-launch');assert.equal(request.runId,run.id)
      assert.equal(input.taskId,proposal.id)
      const grant=await tasks.authorizeApplicationLaunch(run.id,createHash('sha256').update(input.taskToken).digest('hex'))
      assert.equal(grant.launch.command,'fixture');assert.deepEqual(grant.launch.args,['launch','--task'])
      launchRequests++
      socket.end(JSON.stringify({version:1,id:request.id,ok:true,code:0,stdout:JSON.stringify({launch:{url:'https://fixture.example/#launch='+ 'e'.repeat(64),expiresAt:Date.now()+300000}})})+'\n')
    })().catch(error=>socket.end(JSON.stringify({ok:false,error:error.message})+'\n'))})
  });await new Promise<void>(r=>launchBroker.listen(launchSocket,r))
  const sequence = [
    ['context', {}], ['browser_link',{application:'browser'}], ['read_attachment',{incomingId:'1'}], ['read_attachment',{incomingId:'2'}], ['read_attachment',{incomingId:'3'}], ['send', { text: 'Is a table for two available at 7pm?', key: 'first', voice:true }],
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
    const entry = new URL('../src/task-mcp.ts', import.meta.url).href
    await writeFile(`${root}/broker.mjs`, `if(process.env.HOME !== ${JSON.stringify(homedir())}) throw Error('Broker lost host CLI configuration'); await import(${JSON.stringify(entry)});`)
    const broker = [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), `${root}/broker.mjs`, root, run.id,'','[]','["browser"]']
    const catalog = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], { maxBuffer: 4 * 1024 * 1024 });
    await writeFile(`${root}/models.json`, JSON.stringify(taskModelCatalog(JSON.parse(catalog.stdout))));
    const args = taskArguments(directory, broker, JSON.stringify({event:'task_activated',taskId:proposal.id}), ['context','browser_link','read_attachment','send','note','report','complete'], {model:'gpt-6-astra'}, {EZ_PLUGIN_BROKER_SOCKET:launchSocket,EZ_DELIVERY_SOCKET:`${root}/delivery.sock`})
    args.splice(-1, 0, '--disable', 'enable_request_compression', '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${(server.address() as any).port}/v1",wire_api="responses",requires_openai_auth=false}`)
    child = spawn('codex', args, { cwd: directory, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin!.end(JSON.stringify({event:'task_activated',taskId:proposal.id}));
    let stderr = ''; child.stderr!.on('data', c => { stderr += c }); child.stdout!.resume()
    const code = await new Promise(r => child!.on('close', r))
    assert.equal(code, 0, `Requires audited Codex ${TASK_CODEX_VERSION}: ${stderr}`)
    assert.equal(launchRequests,1, 'Native MCP uses the installed isolated broker launcher without tools home')
    assert.ok(requests.length === 10, 'Native tool call completed a second model turn')
    assert.ok(!JSON.stringify(requests).includes('PRIVATE_CANARY_DO_NOT_LOAD'))
    assert.ok(JSON.stringify(requests).includes('https://fixture.example/#launch='))
    assert.ok(!JSON.stringify(requests).includes('taskToken'))
    const messages=requests[0].input.filter((v:any)=>v.role==='user')
    assert.ok(messages.some((m:any)=>m.content.some((c:any)=>c.text===JSON.stringify({event:'task_activated',taskId:proposal.id}))))
    const tools = requests[0].tools ?? requests[0].input.find((v: any) => v.type === 'additional_tools')?.tools
    assert.deepEqual(tools.filter((t: any) => t.type === 'function').map((t: any) => t.name).sort(), ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'request_user_input'])
    const namespaces = tools.filter((t: any) => t.type === 'namespace')
    assert.equal(namespaces.length, 1); assert.equal(namespaces[0].name, 'mcp__ez')
    assert.deepEqual(namespaces[0].tools.map((t: any) => t.name).sort(), ['browser_link','complete', 'context', 'note', 'read_attachment', 'report', 'send'])
    assert.match(JSON.stringify(requests.at(-1).input), /inactive or expired/)
    assert.ok(JSON.stringify(requests).includes('Shop opens at 7am.'))
    assert.ok(JSON.stringify(requests).includes('data:image/'), 'Native CLI forwards MCP images into vision input: '+JSON.stringify(requests.map(request=>request.input)))
    assert.ok(JSON.stringify(requests).includes('durationSeconds'), 'Native input includes video frame metadata')
    assert.ok(JSON.stringify(requests).includes('Shop closes at 6pm.'))
    const videoTurn=requests[5].input
    assert.ok(JSON.stringify(videoTurn).includes('data:image/'), 'Native CLI receives sampled video frames as vision input')
    assert.equal(sends.length, 1);assert.equal(Buffer.from(sends[0].audio.data,'base64').toString(),'OggSfixture OpusHead'); assert.equal(sends[0].conversationId, 'contact-a')
    assert.equal((await tasks.get(proposal.id))!.state, 'completed')
  } finally {
    child?.kill(); clearInterval(timer); await new Promise<void>(r=>launchBroker.close(()=>r())); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r()))
    await rm(root, { recursive: true, force: true })
  }
})
