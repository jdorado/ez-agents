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
test('host transport reserves separate task and main lanes, pins directories, and cancels only its target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ez-scheduler-host-')),workspace=join(root,'agent'),controlDir=join(root,'control')
 await mkdir(workspace);await mkdir(controlDir)
 const script=join(root,'fixture.mjs')
 await writeFile(script,`console.log(JSON.stringify({cwd:process.cwd(),token:process.env.TELEGRAM_BOT_TOKEN,run:process.env.EZ_RUN_ID}));if(process.env.EZ_RUN_ID.startsWith('r_schedule_'))setInterval(()=>{},1000);`)
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
  await until(async()=>(await exists('tg_1.events')).includes('"stream":"exit","code":0'))
  assert.ok(!(await exists(id+'.events')).includes('"stream":"exit"'))
  const scheduled=JSON.parse(JSON.parse((await exists(id+'.events')).trim().split('\n')[0]).text)
  const main=JSON.parse(JSON.parse((await exists('tg_1.events')).trim().split('\n')[0]).text)
  assert.equal(scheduled.cwd,await realpath(join(workspace,'work/tasks',id)));assert.equal(main.cwd,await realpath(workspace))
  assert.equal(scheduled.token,undefined);assert.equal(main.token,undefined)
  // A malformed scheduled request must not unwind the shared host service.
  await writeFile(join(controlDir,'runs/r_schedule_corrupt.json'),'{')
  await submit('r_schedule_corrupt')
  await until(async()=>(await exists('r_schedule_corrupt.events')).includes('"stream":"exit","code":1'))
  assert.ok(!(await exists(id+'.events')).includes('"stream":"exit"'))
  await ownerRun(controlDir,'tg_2')
  await submit('tg_2')
  await until(async()=>(await exists('tg_2.events')).includes('"stream":"exit","code":0'))
  await writeFile(join(dir,id+'.cancel'),'')
  await until(async()=>(await exists(id+'.events')).includes('"stream":"exit"'))
 }finally{
  abort.abort();await server
  Object.assign(EXECUTOR_REGISTRY.grok,old)
  if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token
  await rm(root,{recursive:true,force:true})
 }
})
