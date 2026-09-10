// Real restricted Codex reply while a synthetic writer stays active. No Telegram network.
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRelay } from '../src/index.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'
import { initialPreset } from '../src/ai.js'
import { startExecutorJob } from '../src/executor.js'
import { serveHostExecutor } from '../src/host-executor.js'
import { fileURLToPath } from 'node:url'
import { initializeWorkspace } from '../src/workspace.js'
import type { Update } from 'grammy/types'
if (process.argv.includes('--host')) {
 const root=process.argv[process.argv.indexOf('--host')+1], abort=new AbortController()
 process.once('SIGTERM',()=>abort.abort())
 await serveHostExecutor({cli:'codex',agents:[{name:'fixture',workspace:join(root,'mind'),controlDir:join(root,'control'),binDir:fileURLToPath(new URL('../bin',import.meta.url)),sharedWorkspace:join(root,'mind')}]},abort.signal,async(texts,options)=>{
  if((await new RunStore(options.controlDir).get(options.runId))?.replyOnly)return startExecutorJob(texts,options)
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','pipe','pipe']})
  return {child,stdout:'',cleanup:async()=>{}}
 })
 process.exit(0)
}
const root=await mkdtemp(join(tmpdir(),'ez-busy-reply-')), workspace=join(root,'mind'), controlDir=join(root,'control')
await initializeWorkspace(workspace);await mkdir(controlDir,{recursive:true})
if(process.env.EZ_REPLY_QA_AUTH){await mkdir(join(controlDir,'cli','codex'),{recursive:true});await symlink(process.env.EZ_REPLY_QA_AUTH,join(controlDir,'cli','codex','auth.json'))}
const hostMode=process.argv.includes('--transport')
const hostEnvironment={...process.env};delete hostEnvironment.EZ_EXECUTOR_TRANSPORT
const host=hostMode?spawn(process.execPath,['--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(import.meta.url),'--host',root],{env:hostEnvironment,stdio:['ignore','inherit','inherit']}):undefined
if(hostMode)process.env.EZ_EXECUTOR_TRANSPORT='host'
const control=new ControlStore(controlDir,1000),runs=new RunStore(controlDir)
await control.requestPairing(101,101);await control.approveOwner(101)
let writer:any,replyEvents=''
const relay=createRelay({workspace,controlDir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(texts,options)=>{
 if(hostMode)return startExecutorJob(texts,options)
 const run=await runs.get(options.runId)
 if(run?.replyOnly){const job=await startExecutorJob(texts,options);job.child.stdout?.on('data',c=>{replyEvents+=c});return job}
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe']});writer=child
 return {child,stdout:'',cleanup:async()=>{}}
})
relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as any
const replies:string[]=[]
relay.bot.api.config.use(async(_p,method,payload)=>{if(method==='sendMessage')replies.push((payload as any).text);return {ok:true,result:method==='sendMessage'?{message_id:replies.length,date:0,chat:{id:101,type:'private'},text:(payload as any).text}:true} as any})
const msg=(id:number,text:string):Update=>({update_id:id,message:{message_id:id,date:0,text,from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}})
try{
 await relay.bot.handleUpdate(msg(1,'Long work'));await relay.drainInbox(true)
 await relay.bot.handleUpdate(msg(2,'What is running? Also calculate 17 times 19. Use your available reply tools. Do not queue any work.'));await relay.drainInbox(true)
 const started=Date.now()
 while(!replies.length && Date.now()-started<120000){await relay.drainOutbox();await new Promise(r=>setTimeout(r,250))}
 if(!replies.some(s=>s.includes('323')))throw new Error('No verified arithmetic reply: '+JSON.stringify(replies))
 if((await runs.get('tg_1'))?.status!=='running')throw new Error('Writer stopped')
 while((await runs.get('tg_2'))?.status==='running' && Date.now()-started<120000)await new Promise(r=>setTimeout(r,250))
 if((await runs.get('tg_2'))?.status!=='completed')throw new Error('Reply did not finish successfully')
 const reply=await runs.get('tg_2');if(!reply?.replyOnly)throw new Error('No restricted reply lane')
 await writeFile(join(root,'evidence.json'),JSON.stringify({replyMs:Date.now()-started,replies,writerRunning:(await runs.get('tg_1'))?.status==='running',replyEvents},null,2))
 console.log(JSON.stringify({root,replyMs:Date.now()-started,replies,writerRunning:true}))
}finally{await relay.stop();writer?.kill();host?.kill();delete process.env.EZ_EXECUTOR_TRANSPORT}
