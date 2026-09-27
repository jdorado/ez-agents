import { ownerRun } from './helpers/owner-run.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serveHostExecutor } from '../src/host-executor.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'
import { RunStore } from '../src/runs.js'

const until=async(check:()=>Promise<boolean>)=>{for(let n=0;n<250;n++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Host probe timed out')}
const stdout=(events:string) => events.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.stream==='stdout').map(event=>event.text).join('')
test('host transport serializes owner schedules and chat in the bound mind',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ez-scheduler-host-')),workspace=join(root,'agent'),controlDir=join(root,'control')
 await mkdir(workspace);await mkdir(controlDir)
 await writeFile(join(workspace,'AGENTS.md'),'bound-owner-instructions')
 const script=join(root,'fixture.mjs')
 await writeFile(script,`import {readFileSync} from 'node:fs';console.log(JSON.stringify({cwd:process.cwd(),agents:readFileSync('AGENTS.md','utf8'),token:process.env.TELEGRAM_BOT_TOKEN,run:process.env.EZ_RUN_ID}));if(process.env.EZ_RUN_ID.startsWith('r_schedule_'))setInterval(()=>{},1000);`)
 const old={...EXECUTOR_REGISTRY.grok},token=process.env.TELEGRAM_BOT_TOKEN
 EXECUTOR_REGISTRY.grok.command=process.execPath;EXECUTOR_REGISTRY.grok.buildArgs=()=>[script]
 process.env.TELEGRAM_BOT_TOKEN='never-in-child'
 const abort=new AbortController(),server=serveHostExecutor({cli:'grok',agents:[{name:'test',workspace,controlDir,binDir:root}]},abort.signal)
 const dir=join(controlDir,'host-executor'),runs=new RunStore(controlDir),id='r_schedule_fixture'
 const exists=async(file:string)=>readFile(join(dir,file),'utf8').catch(()=>'')
 try{
  await until(async()=>Boolean(await exists('heartbeat.json')))
  await runs.create({id,chatId:101,telegramUserId:101,texts:['slow'],execution:{sessionId:randomUUID(),preset:{id:'fixture',name:'Fixture',cli:'grok'}},scheduled:{id:'s',revision:'v',dueAt:new Date().toISOString(),pairedAt:'paired'}})
  const submit=async(id:string)=>writeFile(join(dir,id+'.request.json'),JSON.stringify({texts:['fixture'],options:{workspace:'/evil',controlDir:'/evil',cli:'grok',timeoutMs:1}}))
  await ownerRun(controlDir,'tg_1')
  await runs.patch(id,{status:'running'})
  await submit(id)
  await until(async()=>Boolean(await exists(id+'.process.json')))
  await submit('tg_1')
  await new Promise(resolve=>setTimeout(resolve,300))
  assert.ok(await exists('tg_1.request.json'))
  assert.equal(await exists('tg_1.events'),'')
  assert.ok(!(await exists(id+'.events')).includes('"stream":"exit"'))
  const scheduled=JSON.parse(stdout(await exists(id+'.events')))
  assert.equal(scheduled.cwd,await realpath(workspace))
  assert.equal(scheduled.agents,'bound-owner-instructions')
  assert.equal(scheduled.token,undefined)
  // An unknown scheduled run must not unwind the shared host service.
  await submit('r_schedule_corrupt')
  await until(async()=>(await exists('r_schedule_corrupt.events')).includes('"stream":"exit","code":1'))
  assert.ok(!(await exists(id+'.events')).includes('"stream":"exit"'))
  await ownerRun(controlDir,'tg_2')
  await submit('tg_2')
  assert.ok(await exists('tg_2.request.json'))
  await writeFile(join(dir,id+'.cancel'),'')
  await until(async()=>(await exists(id+'.events')).includes('"stream":"exit"'))
  await until(async()=>(await exists('tg_1.events')).includes('"stream":"exit","code":0'))
  await until(async()=>(await exists('tg_2.events')).includes('"stream":"exit","code":0'))
  const main=JSON.parse(stdout(await exists('tg_1.events')))
  assert.equal(main.cwd,await realpath(workspace))
  assert.equal(main.agents,'bound-owner-instructions')
  assert.equal(main.token,undefined)
 }finally{
  abort.abort();await server
  Object.assign(EXECUTOR_REGISTRY.grok,old)
  if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token
  await rm(root,{recursive:true,force:true})
 }
})
