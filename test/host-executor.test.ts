import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { serveHostExecutor, selectValidationCatalog, readCachedModels, refreshAgentCatalog } from '../src/host-executor.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isHostRunId } from '../src/host-executor-protocol.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'
import { RunStore } from '../src/runs.js'
import { packageVersion } from '../src/version.js'
import { executionDefaults } from '../src/model-policy.js'
import { workspaceLease } from '../src/plugins/workspace-lease.mjs'

test('host restart replaces a lock whose PID was reused by another process',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-reused-pid-'))
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),directory=path.join(controlDir,'host-executor')
  const abort=new AbortController();let server:Promise<void>|undefined
  try {
    await mkdir(workspace);await mkdir(directory,{recursive:true})
    await writeFile(path.join(directory,'worker.lock'),JSON.stringify({pid:process.pid,started:'reused-pid'}))
    server=serveHostExecutor({cli:'grok',agents:[{name:'test',workspace,controlDir,binDir:root}]},abort.signal)
    for(let n=0;n<300;n++){try{await readFile(path.join(directory,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    await readFile(path.join(directory,'heartbeat.json'))
    const lock=JSON.parse(await readFile(path.join(directory,'worker.lock'),'utf8'))
    assert.equal(lock.pid,process.pid)
    assert.notEqual(lock.started,'reused-pid')
  }finally{abort.abort();await server;await rm(root,{recursive:true,force:true})}
})

test('legacy host lock fails closed while its PID is alive',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-legacy-lock-'))
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),directory=path.join(controlDir,'host-executor')
  try {
    await mkdir(workspace);await mkdir(directory,{recursive:true})
    await writeFile(path.join(directory,'worker.lock'),JSON.stringify({pid:process.pid}))
    await assert.rejects(serveHostExecutor({cli:'grok',agents:[{name:'test',workspace,controlDir,binDir:root}]},new AbortController().signal),/already running/)
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'worker.lock'),'utf8')),{pid:process.pid})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('isolated installations cannot start host transport', async () => {
  const abort=new AbortController()
  await assert.rejects(serveHostExecutor({cli:'grok',isolation:'isolated',agents:[]},abort.signal),/Isolated agents run the native CLI in the relay/)
  abort.abort()
})

test('host bindings reject invalid opencode provider scopes before touching state', async () => {
  const abort=new AbortController()
  for (const opencodeProviders of [['BAD NAME'], [], ['ok', 'ok'], new Array(17).fill('ok')]) {
    await assert.rejects(serveHostExecutor({cli:'grok',agents:[{
      name:'t',workspace:'/tmp/ez-scope-x',controlDir:'/tmp/ez-scope-y',binDir:'/tmp/ez-scope-z',opencodeProviders} as never]},abort.signal),
      /one to sixteen unique provider IDs/)
  }
  abort.abort()
})

test('host restart clears dead native lease only after proving previous CLI stopped',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-native-recovery-'));
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),toolsHome=path.join(root,'tools'),directory=path.join(controlDir,'host-executor');
  const abort=new AbortController();let server:Promise<void>|undefined;
  try {
    await mkdir(workspace);await mkdir(toolsHome);await mkdir(directory,{recursive:true});
    await writeFile(path.join(toolsHome,'config.json'),JSON.stringify({schemaVersion:1,workspace:await realpath(workspace)}));
    const child=spawn(process.execPath,['-e','process.exit(0)']);const deadPid=child.pid;await new Promise(r=>child.once('close',r));
    await writeFile(path.join(toolsHome,'workspace-writer.lock'),JSON.stringify({pid:deadPid,kind:'native',runId:'r_old'}));
    await writeFile(path.join(directory,'r_old.running.json'),'{}');
    await writeFile(path.join(directory,'r_old.process.json'),JSON.stringify({pid:process.pid}));
    const installation={cli:'grok',agents:[{name:'test',workspace,controlDir,toolsHome,binDir:path.join(root,'bin')}]};
    await assert.rejects(serveHostExecutor(installation,abort.signal),/Previous host CLI is still running/);
    await readFile(path.join(toolsHome,'workspace-writer.lock'));
    await writeFile(path.join(directory,'r_old.process.json'),JSON.stringify({pid:deadPid}));
    server=serveHostExecutor(installation,abort.signal);
    for(let n=0;n<300;n++){try{await readFile(path.join(directory,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    await readFile(path.join(directory,'heartbeat.json'));
    await assert.rejects(readFile(path.join(toolsHome,'workspace-writer.lock')),{code:'ENOENT'});
  }finally{abort.abort();await server;await rm(root,{recursive:true,force:true});}
});

test('host execution resolves a declared provider from the bound agent, not a launcher wrapper', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-host-provider-'))
  const workspace = path.join(root, 'mind')
  const controlDir = path.join(root, 'control')
  const directory = path.join(controlDir, 'host-executor')
  const provider = {
    id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY', models: ['deepseek/deepseek-v4.1-flash'],
  }
  const installation = {
    cli: 'codex' as const,
    agents: [{name: 'test', workspace, controlDir, binDir: path.join(root, 'bin'), codexProviders: [provider]}],
  }
  const abort = new AbortController()
  let server: Promise<void> | undefined
  let captured: any
  const previousPath = process.env.PATH
  try {
    await mkdir(workspace, {recursive: true})
    await mkdir(directory, {recursive: true})
    const fakeBin = path.join(root, 'bin')
    await mkdir(fakeBin, {recursive: true})
    await mkdir(path.join(controlDir, 'cli', 'codex'), {recursive: true})
    await writeFile(path.join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n', {mode: 0o700})
    await writeFile(path.join(controlDir, 'cli', 'codex', 'models_cache.json'), JSON.stringify({models: [
      {slug: provider.models[0], visibility: 'list', display_name: 'DeepSeek V4.1 Flash', supported_reasoning_levels: [{effort: 'max'}]},
    ]}))
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`
    await ownerRun(controlDir, 'r_provider')
    server = serveHostExecutor(installation, abort.signal, async (_texts, options) => {
      captured = options
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
      return {child, cleanup: async () => {}, stdout: ''}
    })
    for (let n = 0; n < 100; n++) {
      try { await readFile(path.join(directory, 'heartbeat.json')); break }
      catch { await new Promise(resolve => setTimeout(resolve, 20)) }
    }
    await writeFile(path.join(directory, 'r_provider.request.json'), JSON.stringify({
      texts: ['hello'], options: {cli: 'codex', provider: 'openrouter', model: provider.models[0], effort: 'max'},
    }))
    let events = ''
    for (let n = 0; n < 100; n++) {
      try {
        events = await readFile(path.join(directory, 'r_provider.events'), 'utf8')
        if (events.includes('"stream":"exit"')) break
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.match(events, /"stream":"exit","code":0/)
    const catalog = JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf8'))
    assert.deepEqual(catalog.filter((model: any) => model.model === provider.models[0]), [
      {
        cli: 'codex-gui', model: provider.models[0],
        name: 'codex-gui · DeepSeek V4.1 Flash', efforts: ['max'],
      },
      {
        cli: 'codex', provider: 'openrouter', model: provider.models[0],
        name: `OpenRouter · ${provider.models[0]}`, efforts: ['max'],
      },
    ])
    assert.deepEqual(catalog.filter((model: any) => model.cli === 'codex' && !model.provider), [])
    assert.equal(captured.provider, 'openrouter')
    assert.deepEqual(captured.codexProvider, provider)
    assert.equal(captured.model, provider.models[0])
  } finally {
    abort.abort()
    await server
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(root, {recursive: true, force: true})
  }
})

test('one installed CLI executes two agent bindings with separate minds and sanitized environment', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-'))
  const abort=new AbortController()
  const old=EXECUTOR_REGISTRY.grok.command
  const oldBuild=EXECUTOR_REGISTRY.grok.buildArgs
  const oldToken=process.env.TELEGRAM_BOT_TOKEN
  const oldPath=process.env.PATH
  let server:Promise<void>|undefined
  try {
    const binary=path.join(root,'cli')
    await writeFile(binary,`#!${process.execPath}\nif(process.env.EZ_RUN_ID==='r_hold')setInterval(()=>{},1000);console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,token:process.env.TELEGRAM_BOT_TOKEN,control:process.env.EZ_CONTROL_DIR,run:process.env.EZ_RUN_ID,repair:process.env.EZ_REPAIR_ENABLED,args:process.argv.slice(2)}));\n`,{mode:0o700})
    await writeFile(path.join(root,'claude'),await readFile(binary),{mode:0o700})
    await writeFile(path.join(root,'codex'),await readFile(binary),{mode:0o700})
    await writeFile(path.join(root,'opencode'),'#!/bin/sh\nexit 0\n',{mode:0o700})
    process.env.PATH=root+path.delimiter+oldPath
    EXECUTOR_REGISTRY.grok.command=binary
    EXECUTOR_REGISTRY.grok.buildArgs=(opts,file,prompt)=>[...EXECUTOR_REGISTRY.codex.buildArgs(opts,file,prompt).slice(0,-1),prompt]
    process.env.TELEGRAM_BOT_TOKEN='must-not-reach-host-cli'
    const sharedAlias=path.join(root,'shared-alias')
    await symlink(root,sharedAlias)
    const additionalWorkspace=path.join(root,'additional');await mkdir(additionalWorkspace)
    const agents=await Promise.all(['one','two'].map(async name=>{
      const workspace=path.join(root,name,'mind'),controlDir=path.join(root,name,'control')
      await mkdir(workspace,{recursive:true});await mkdir(controlDir,{recursive:true})
      const toolsHome=path.join(root,name,'tools');await mkdir(toolsHome)
      await writeFile(path.join(toolsHome,'config.json'),JSON.stringify({schemaVersion:1,workspace:await realpath(workspace)}))
      return {name,workspace,controlDir,binDir:path.join(root,'bin'),toolsHome,sharedWorkspace:name==='two'?sharedAlias:root,additionalWorkspaces:name==='two'?[additionalWorkspace]:undefined}
    }))
    server=serveHostExecutor({cli:'grok',agents},abort.signal)
    for(const agent of agents){
      const dir=path.join(agent.controlDir,'host-executor')
      for(let n=0;n<300;n++){try{await readFile(path.join(dir,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
      assert.equal(JSON.parse(await readFile(path.join(dir,'heartbeat.json'),'utf8')).version,packageVersion)
      const release = await workspaceLease(agent.toolsHome)
      await ownerRun(agent.controlDir, `r_${agent.name}`)
      await writeFile(path.join(dir,`r_${agent.name}.request.json`),JSON.stringify({texts:['test'],options:{workspace:'/wrong',controlDir:'/wrong',toolsHome:'/wrong',cli:'grok',timeoutMs:5000}}))
      await new Promise(r=>setTimeout(r,300))
      await readFile(path.join(dir,`r_${agent.name}.request.json`))
      await assert.rejects(readFile(path.join(dir,`r_${agent.name}.process.json`)),{code:'ENOENT'})
      await release?.()
    }
    for(const agent of agents){
      const file=path.join(agent.controlDir,'host-executor',`r_${agent.name}.events`)
      let events:any[]=[]
      for(let n=0;n<150;n++){try{events=(await readFile(file,'utf8')).trim().split('\n').map(l=>JSON.parse(l));if(events.some(e=>e.stream==='exit'))break}catch{}await new Promise(r=>setTimeout(r,20))}
      assert.equal(events.find(e=>e.stream==='exit')?.code,0)
      const result=JSON.parse(events.filter(e=>e.stream==='stdout').map(e=>e.text).join(''))
      assert.equal(result.cwd,await realpath(agent.workspace))
      assert.equal(result.control,agent.controlDir)
      assert.equal(result.token,undefined)
      assert.equal(result.args.at(-1),'test')
      assert.equal(result.repair,'true')
      assert.ok(result.args.includes(agent.toolsHome))
      assert.ok(result.args.includes(await realpath(root)))
      assert.equal(result.args.includes(await realpath(additionalWorkspace)),agent.name==='two')
      assert.ok(!result.args.includes('/wrong'))
      assert.equal(result.home,process.env.HOME)
    }
    // Exercise the actual client -> file transport -> host CLI path, not a
    // hand-written smoke request, with the production Telegram batch ID shape.
    await ownerRun(agents[0].controlDir, 'tg_6293305')
    const client=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),agents[0].controlDir,'tg_6293305'],{stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''
    client.stdout.on('data',chunk=>stdout+=chunk)
    client.stderr.on('data',chunk=>stderr+=chunk)
    client.stdin.end(JSON.stringify({texts:['Telegram message'],options:{cli:'grok',timeoutMs:5000,codexAutoCompactTokens:32000,repairEnabled:false}}))
    assert.equal(await new Promise(resolve=>client.once('close',resolve)),0,stderr)
    assert.equal(JSON.parse(stdout).run,'tg_6293305')
    assert.equal(JSON.parse(stdout).args.at(-1),'Telegram message')
    assert.equal(JSON.parse(stdout).repair,'false')
    assert.ok(JSON.parse(stdout).args.includes('model_auto_compact_token_limit=32000'))
    const eventId='event_'+'a'.repeat(64)
    await ownerRun(agents[0].controlDir, eventId, {sourceId:'fixture',bindingId:'binding',eventIds:['1']})
    const eventClient=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),agents[0].controlDir,eventId],{stdio:['pipe','pipe','pipe']})
    let eventOutput='',eventError=''
    eventClient.stdout.on('data',chunk=>eventOutput+=chunk)
    eventClient.stderr.on('data',chunk=>eventError+=chunk)
    eventClient.stdin.end(JSON.stringify({texts:['Untrusted plugin event'],options:{cli:'grok',timeoutMs:5000}}))
    assert.equal(await new Promise(resolve=>eventClient.once('close',resolve)),1,eventError)
    assert.equal(eventOutput,'')
    assert.match(eventError,/Host CLI execution failed/)
    await ownerRun(agents[0].controlDir, 'tg_6293306')
    const switched=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),agents[0].controlDir,'tg_6293306'],{stdio:['pipe','pipe','pipe']})
    let switchedOutput=''
    switched.stdout.on('data',chunk=>switchedOutput+=chunk)
    switched.stderr.resume()
    switched.stdin.end(JSON.stringify({texts:['Explicit CLI change'],options:executionDefaults('claude',{cli:'claude',timeoutMs:5000,effort:undefined})}))
    assert.equal(await new Promise(resolve=>switched.once('close',resolve)),0)
    assert.ok(JSON.parse(switchedOutput).args.includes('--print'))
    // The bound cache may advertise a model absent from the host's cache.
    const codexHome=path.join(agents[0].controlDir,'cli','codex')
    await mkdir(codexHome,{recursive:true})
    await writeFile(path.join(codexHome,'models_cache.json'),JSON.stringify({models:[{slug:'agent-only-fixture',visibility:'list',display_name:'Agent model',supported_reasoning_levels:[]}]}))
    await ownerRun(agents[0].controlDir,'tg_6293307')
    const bound=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),agents[0].controlDir,'tg_6293307'],{stdio:['pipe','pipe','pipe']})
    let boundOutput='',boundError=''
    bound.stdout.on('data',chunk=>boundOutput+=chunk)
    bound.stderr.on('data',chunk=>boundError+=chunk)
    bound.stdin.end(JSON.stringify({texts:['Switch to agent model'],options:{cli:'codex',model:'agent-only-fixture',timeoutMs:5000}}))
    assert.equal(await new Promise(resolve=>bound.once('close',resolve)),0,boundError)
    assert.ok(JSON.parse(boundOutput).args.includes('agent-only-fixture'))
    await assert.rejects(serveHostExecutor({cli:'grok',agents},new AbortController().signal),/already running/)
    const directory=path.join(agents[0].controlDir,'host-executor')
    const runs=new RunStore(agents[0].controlDir)
    await runs.create({id:'r_hold',chatId:101,telegramUserId:101,texts:['test'],scheduled:{id:'held',revision:'v1',dueAt:new Date().toISOString(),pairedAt:new Date().toISOString()}})
    await runs.patch('r_hold',{status:'running'})
    await writeFile(path.join(directory,'r_hold.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok'}}))
    for(let n=0;n<100;n++){try{await readFile(path.join(directory,'r_hold.process.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    await new RunStore(agents[0].controlDir).create({id:'r_schedule_queued',chatId:101,telegramUserId:101,texts:['test'],scheduled:{id:'shared',revision:'v1',dueAt:new Date().toISOString(),pairedAt:new Date().toISOString()}})
    await new RunStore(agents[0].controlDir).patch('r_schedule_queued',{status:'running'})
    await writeFile(path.join(directory,'r_schedule_queued.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok',sharedWorkspace:'/wrong'}}))
    const otherDirectory=path.join(agents[1].controlDir,'host-executor')
    await ownerRun(agents[1].controlDir,'r_other_shared')
    await writeFile(path.join(otherDirectory,'r_other_shared.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok'}}))
    await runs.create({id:'tg_42',chatId:101,telegramUserId:101,messageId:42,texts:['Chat while scheduled work runs']})
    await runs.patch('tg_42',{status:'running'})
    await writeFile(path.join(directory,'tg_42.request.json'),JSON.stringify({texts:['Chat while scheduled work runs'],options:{cli:'grok'}}))
    const completed=async(dir:string,id:string)=>{
      let output=''
      for(let n=0;n<200;n++){try{output=await readFile(path.join(dir,id+'.events'),'utf8');if(output.includes('"stream":"exit"'))break}catch{}await new Promise(r=>setTimeout(r,20))}
      assert.match(output, /"stream":"exit","code":0/)
      return output.trim().split('\n').map(line=>JSON.parse(line))
    }
    // A running scheduled engine does not reserve either its agent or its
    // shared workspace, including another binding through a filesystem alias.
    const [,,chatEvents]=await Promise.all([completed(directory,'r_schedule_queued'),completed(otherDirectory,'r_other_shared'),completed(directory,'tg_42')])
    const chat=JSON.parse(chatEvents.filter(e=>e.stream==='stdout').map(e=>e.text).join(''))
    assert.match(chat.args.at(-1),/^Chat while scheduled work runs/)
    assert.match(chat.args.at(-1),/ezenciel-agents-message/)
    assert.doesNotMatch(await readFile(path.join(directory,'r_hold.events'),'utf8'),/"stream":"exit"/)
    await readFile(path.join(directory,'r_hold.running.json'))
    await writeFile(path.join(directory,'r_hold.cancel'),'')
    let heldOutput=''
    for(let n=0;n<200;n++){heldOutput=await readFile(path.join(directory,'r_hold.events'),'utf8');if(heldOutput.includes('"stream":"exit"'))break;await new Promise(r=>setTimeout(r,20))}
    assert.match(heldOutput, /"stream":"exit","code":1/)
  } finally {
    abort.abort();await server
    EXECUTOR_REGISTRY.grok.command=old
    EXECUTOR_REGISTRY.grok.buildArgs=oldBuild
    process.env.PATH=oldPath
    if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken
    await rm(root,{recursive:true,force:true})
  }
})


test('host run IDs accept production formats and reject unsafe paths',()=>{
  for(const id of ['tg_6293305','tg_replay_702267965_20260916','r_example_123','event_'+'a'.repeat(64)])assert.equal(isHostRunId(id),true)
  for(const id of ['../tg_1','tg_1/other','tg_abc','tg_replay_702267965','tg_replay_702267965_2026091x','event_bad','event_'+'a'.repeat(63),'event_'+'g'.repeat(64),'tg_1\n','r_',''])assert.equal(isHostRunId(id),false)
})

test('client tolerates missing heartbeat and consumes completion before checking host health',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-heartbeat-'))
 const directory=path.join(root,'host-executor');await mkdir(directory)
 const client=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),root,'tg_99'],{stdio:['pipe','pipe','pipe']})
 const closed=new Promise(resolve=>client.once('close',resolve))
 let stderr='';client.stderr.on('data',chunk=>stderr+=chunk);client.stdout.resume()
 client.stdin.end(JSON.stringify({texts:['test'],options:{}}))
 try {
  for(let n=0;n<100;n++){try{await readFile(path.join(directory,'tg_99.request.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
  await new Promise(r=>setTimeout(r,400))
  assert.equal(client.exitCode,null,stderr)
  await assert.rejects(readFile(path.join(directory,'tg_99.cancel')),{code:'ENOENT'})
  await writeFile(path.join(directory,'tg_99.events'),JSON.stringify({stream:'exit',code:0})+'\n')
  assert.equal(await closed,0,stderr)
 } finally {client.kill();await closed;await rm(root,{recursive:true,force:true})}
})

test('client records a relay interruption before exiting 130',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-host-interrupt-'))
 const directory=path.join(root,'host-executor');await mkdir(directory)
 const client=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),root,'tg_97'],{stdio:['pipe','pipe','pipe']})
 let stderr='';client.stderr.on('data',chunk=>stderr+=chunk);client.stdout.resume()
 client.stdin.end(JSON.stringify({texts:['test'],options:{}}))
 try {
  for(let n=0;n<100;n++){try{await readFile(path.join(directory,'tg_97.request.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
  const closed=new Promise<number|null>(resolve=>client.once('close',resolve))
  client.kill('SIGTERM')
  assert.equal(await closed,130)
  assert.equal(await readFile(path.join(directory,'tg_97.cancel'),'utf8'),'')
  assert.match(stderr,/Host executor client interrupted by SIGTERM/)
 } finally {if(client.exitCode===null && client.signalCode===null)client.kill();await rm(root,{recursive:true,force:true})}
})

test('client cancels on stale or invalid heartbeat instead of waiting indefinitely',async()=>{
 for(const heartbeat of [{at:Date.now()-60000},{at:'invalid'}]) {
  const root=await mkdtemp(path.join(tmpdir(),'ez-heartbeat-invalid-'))
  try {
   const directory=path.join(root,'host-executor');await mkdir(directory)
   await writeFile(path.join(directory,'heartbeat.json'),JSON.stringify(heartbeat))
   const client=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),root,'tg_98'],{stdio:['pipe','pipe','pipe']})
   let stderr='';client.stderr.on('data',chunk=>stderr+=chunk);client.stdout.resume()
   client.stdin.end(JSON.stringify({texts:['test'],options:{}}))
   assert.equal(await new Promise(resolve=>client.once('close',resolve)),1)
   assert.match(stderr,/offline|Invalid host CLI heartbeat/)
   assert.equal(await readFile(path.join(directory,'tg_98.cancel'),'utf8'),'')
  } finally {await rm(root,{recursive:true,force:true})}
 }
})


test('host rejects a plugin registry bound to another workspace',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-plugin-binding-'))
  try {
   await writeFile(path.join(root,'config.json'),JSON.stringify({schemaVersion:1,workspace:'/another-agent'}))
   await assert.rejects(serveHostExecutor({cli:'codex',agents:[{name:'test',workspace:root,controlDir:root,binDir:root,toolsHome:root}]},new AbortController().signal),/another workspace/)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('validation prefers fresh catalog but falls back to last-good disk on a blip',()=>{
  const fresh=[{cli:'opencode',model:'opencode-go/muse-spark-1.3-contributor',name:'Muse Spark',efforts:['xhigh']}]
  const cached=[{cli:'opencode',model:'opencode-go/muse-spark-1.3-contributor',name:'Muse Spark',efforts:['xhigh']}]
  assert.deepEqual(selectValidationCatalog(fresh,cached),fresh)
  assert.deepEqual(selectValidationCatalog([],cached),cached)
  assert.deepEqual(selectValidationCatalog([],[]),[])
  assert.deepEqual(selectValidationCatalog([],undefined),[])
})

test('readCachedModels round-trips disk and returns undefined when missing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-cached-'))
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),directory=path.join(controlDir,'host-executor')
  try {
    await mkdir(workspace,{recursive:true});await mkdir(directory,{recursive:true})
    const agent={name:'test',workspace,controlDir,binDir:root}
    assert.equal(await readCachedModels(agent),undefined)
    const models=[{cli:'codex',model:'cached-model',name:'Cached',efforts:[]}]
    await writeFile(path.join(directory,'models.json'),JSON.stringify(models))
    assert.deepEqual(await readCachedModels(agent),models)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('refresh blip throws so the caller keeps last-good models instead of crashing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-refresh-blip-'))
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),directory=path.join(controlDir,'host-executor')
  try {
    await mkdir(workspace,{recursive:true});await mkdir(directory,{recursive:true})
    const agent={name:'test',workspace,controlDir,binDir:root}
    const lastGood=[{cli:'codex',model:'cached-model',name:'Cached',efforts:[]}]
    await writeFile(path.join(directory,'models.json'),JSON.stringify(lastGood))
    const seen=new Map()
    await assert.rejects(refreshAgentCatalog(agent,async()=>{throw new Error('transient catalog blip')},seen),/transient catalog blip/)
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'models.json'),'utf8')),lastGood)
    assert.equal(seen.has(agent),false)
  } finally {await rm(root,{recursive:true,force:true})}
})

test('empty refresh preserves the last-good catalog and a later nonempty refresh replaces it',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-empty-refresh-'))
  const directory=path.join(root,'host-executor')
  try {
    await mkdir(directory)
    const agent={name:'test',workspace:root,controlDir:root,binDir:root}
    const lastGood=[{cli:'codex',model:'cached-model',name:'Cached',efforts:[]}]
    const fresh=[{cli:'codex',model:'new-model',name:'New',efforts:[]}]
    await writeFile(path.join(directory,'models.json'),JSON.stringify(lastGood))
    const seen=new Map([[agent,JSON.stringify(lastGood)]])
    await refreshAgentCatalog(agent,async()=>[],seen)
    assert.deepEqual(await readCachedModels(agent),lastGood)
    assert.equal(seen.get(agent),JSON.stringify(lastGood))
    await refreshAgentCatalog(agent,async()=>fresh,seen)
    assert.deepEqual(await readCachedModels(agent),fresh)
    assert.equal(seen.get(agent),JSON.stringify(fresh))
  } finally {await rm(root,{recursive:true,force:true})}
})

test('slow catalog refresh keeps heartbeats live and active client completes without cancellation', {timeout:70000}, async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-slow-refresh-'))
  const directory=path.join(root,'host-executor')
  const abort=new AbortController()
  let server:Promise<void>|undefined
  let client:ReturnType<typeof spawn>|undefined
  let closed:Promise<number|null>|undefined
  let releaseRefresh!:()=>void
  let startedRefresh!:()=>void
  const blocked=new Promise<void>(resolve=>{releaseRefresh=resolve})
  const refreshing=new Promise<void>(resolve=>{startedRefresh=resolve})
  let calls=0
  let finishRun: (()=>void) | undefined
  try {
    await mkdir(directory)
    await ownerRun(root,'r_slow_catalog')
    server=serveHostExecutor({cli:'grok',agents:[{name:'test',workspace:root,controlDir:root,binDir:root}]},abort.signal,async()=>{
      const child=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.once("data",()=>process.exit(0))'])
      finishRun=()=>{child.stdin!.end('done')}
      return {child,cleanup:async()=>{},stdout:''}
    },async()=>{
      if(++calls>1){startedRefresh();await blocked}
      return [{cli:'grok',name:'Grok',efforts:[]}]
    })
    for(let n=0;n<300;n++){try{await readFile(path.join(directory,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    client=spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('../src/host-executor-client.ts',import.meta.url)),root,'r_slow_catalog'],{stdio:['pipe','pipe','pipe']})
    closed=new Promise(resolve=>client!.once('close',resolve))
    let stderr='';client.stderr!.on('data',chunk=>stderr+=chunk);client.stdout!.resume()
    client.stdin!.end(JSON.stringify({texts:['test'],options:{cli:'grok'}}))
    await refreshing
    // Exceed the real relay client's 15s offline threshold while discovery hangs.
    await new Promise(resolve=>setTimeout(resolve,16500))
    const heartbeat=JSON.parse(await readFile(path.join(directory,'heartbeat.json'),'utf8'))
    assert.ok(Date.now()-heartbeat.at<5000,'heartbeat stopped during catalog I/O')
    assert.equal(client.exitCode,null,stderr)
    await assert.rejects(readFile(path.join(directory,'r_slow_catalog.cancel')),{code:'ENOENT'})
    assert.equal(calls,2,'catalog refresh must not overlap itself')
    assert.ok(finishRun,'the native run must have started')
    finishRun()
    assert.equal(await closed,0,stderr)
    releaseRefresh()
  } finally {
    releaseRefresh();abort.abort()
    if(client?.exitCode===null && client.signalCode===null)client.kill()
    await closed;await server;await rm(root,{recursive:true,force:true})
  }
})

test('cross-CLI run falls back to cached catalog instead of failing on an empty fresh read',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ez-host-validation-fallback-'))
  const workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),directory=path.join(controlDir,'host-executor')
  const abort=new AbortController();let server:Promise<void>|undefined
  const previousPath=process.env.PATH
  try {
    await mkdir(workspace,{recursive:true});await mkdir(directory,{recursive:true})
    const fakeBin=path.join(root,'bin');await mkdir(fakeBin,{recursive:true})
    await writeFile(path.join(fakeBin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
    process.env.PATH=`${fakeBin}${path.delimiter}${previousPath ?? ''}`
    const installation={cli:'grok' as const,agents:[{name:'test',workspace,controlDir,binDir:fakeBin}]}
    server=serveHostExecutor(installation,abort.signal,async()=>{
      const child=spawn(process.execPath,['-e','process.exit(0)'])
      return {child,cleanup:async()=>{},stdout:''}
    },async()=>[])
    for(let n=0;n<300;n++){try{await readFile(path.join(directory,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    await readFile(path.join(directory,'heartbeat.json'))
    const cached=[{cli:'codex',model:'cached-model',name:'Cached',efforts:[]}]
    await writeFile(path.join(directory,'models.json'),JSON.stringify(cached))
    await ownerRun(controlDir,'r_cached_fallback')
    await writeFile(path.join(directory,'r_cached_fallback.request.json'),JSON.stringify({
      texts:['hello'],options:{cli:'codex',model:'cached-model'},
    }))
    let events=''
    for(let n=0;n<200;n++){
      try{events=await readFile(path.join(directory,'r_cached_fallback.events'),'utf8');if(events.includes('"stream":"exit"'))break}catch{}
      await new Promise(r=>setTimeout(r,20))
    }
    assert.match(events,/"stream":"exit","code":0/)
  } finally {
    abort.abort();await server
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath
    await rm(root,{recursive:true,force:true})
  }
})
