import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { serveHostExecutor } from '../src/host-executor.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isHostRunId } from '../src/host-executor-protocol.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'
import { RunStore } from '../src/runs.js'
import { packageVersion } from '../src/version.js'
import { executionDefaults } from '../src/model-policy.js'

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
    process.env.PATH=root+path.delimiter+oldPath
    EXECUTOR_REGISTRY.grok.command=binary
    EXECUTOR_REGISTRY.grok.buildArgs=(opts,file,prompt)=>[...EXECUTOR_REGISTRY.codex.buildArgs(opts,file,prompt).slice(0,-1),prompt]
    process.env.TELEGRAM_BOT_TOKEN='must-not-reach-host-cli'
    const sharedAlias=path.join(root,'shared-alias')
    await symlink(root,sharedAlias)
    const agents=await Promise.all(['one','two'].map(async name=>{
      const workspace=path.join(root,name,'mind'),controlDir=path.join(root,name,'control')
      await mkdir(workspace,{recursive:true});await mkdir(controlDir,{recursive:true})
      const toolsHome=path.join(root,name,'tools');await mkdir(toolsHome)
      await writeFile(path.join(toolsHome,'config.json'),JSON.stringify({schemaVersion:1,workspace:await realpath(workspace)}))
      return {name,workspace,controlDir,binDir:path.join(root,'bin'),toolsHome,sharedWorkspace:name==='two'?sharedAlias:root}
    }))
    server=serveHostExecutor({cli:'grok',agents},abort.signal)
    for(const agent of agents){
      const dir=path.join(agent.controlDir,'host-executor')
      for(let n=0;n<100;n++){try{await readFile(path.join(dir,'heartbeat.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
      assert.equal(JSON.parse(await readFile(path.join(dir,'heartbeat.json'),'utf8')).version,packageVersion)
      await ownerRun(agent.controlDir, `r_${agent.name}`)
      await writeFile(path.join(dir,`r_${agent.name}.request.json`),JSON.stringify({texts:['test'],options:{workspace:'/wrong',controlDir:'/wrong',toolsHome:'/wrong',cli:'grok',timeoutMs:5000}}))
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
    const submit=async(id:string)=>{await ownerRun(agents[0].controlDir,id);await writeFile(path.join(directory,id+'.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok',timeoutMs:5000}}))}
    await submit('r_hold')
    for(let n=0;n<100;n++){try{await readFile(path.join(directory,'r_hold.process.json'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    await new RunStore(agents[0].controlDir).create({id:'r_schedule_queued',chatId:101,telegramUserId:101,texts:['test'],scheduled:{id:'shared',revision:'v1',dueAt:new Date().toISOString(),pairedAt:new Date().toISOString()}})
    await new RunStore(agents[0].controlDir).patch('r_schedule_queued',{status:'running'})
    await writeFile(path.join(directory,'r_schedule_queued.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok',sharedWorkspace:'/wrong'}}))
    const otherDirectory=path.join(agents[1].controlDir,'host-executor')
    await ownerRun(agents[1].controlDir,'r_other_shared')
    await writeFile(path.join(otherDirectory,'r_other_shared.request.json'),JSON.stringify({texts:['test'],options:{cli:'grok'}}))
    await new Promise(r=>setTimeout(r,350))
    await assert.rejects(readFile(path.join(directory,'r_schedule_queued.running.json')),{code:'ENOENT'})
    await assert.rejects(readFile(path.join(otherDirectory,'r_other_shared.running.json')),{code:'ENOENT'})
    await assert.rejects(readFile(path.join(otherDirectory,'r_other_shared.events')),{code:'ENOENT'})
    await writeFile(path.join(directory,'r_hold.cancel'),'')
    let output=''
    for(let n=0;n<200;n++){try{output=await readFile(path.join(directory,'r_schedule_queued.events'),'utf8');if(output.includes('"stream":"exit"'))break}catch{}await new Promise(r=>setTimeout(r,20))}
    assert.match(output, /"stream":"exit","code":0/)
    assert.match(await readFile(path.join(directory,'r_hold.events'),'utf8'), /"stream":"exit","code":1/)
    for(let n=0;n<200;n++){try{output=await readFile(path.join(otherDirectory,'r_other_shared.events'),'utf8');if(output.includes('"stream":"exit"'))break}catch{}await new Promise(r=>setTimeout(r,20))}
    assert.match(output, /"stream":"exit","code":0/)
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
  for(const id of ['tg_6293305','r_example_123','event_'+'a'.repeat(64)])assert.equal(isHostRunId(id),true)
  for(const id of ['../tg_1','tg_1/other','tg_abc','event_bad','event_'+'a'.repeat(63),'event_'+'g'.repeat(64),'tg_1\n','r_',''])assert.equal(isHostRunId(id),false)
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
