// Opt-in token-consuming probe. Real executor and relay handlers; synthetic Telegram provider.
// Run: node --import tsx scripts/smoke-scheduler.ts [seconds=1860] [cli=codex]
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { Scheduler } from '../src/scheduler.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
import { initializeWorkspace } from '../src/workspace.js'
import type { Update } from 'grammy/types'

const duration=Number(process.argv[2] || 1860),cli=process.argv[3] || 'codex'
if(!Number.isSafeInteger(duration) || duration<30)throw new Error('Duration must be at least 30 seconds')
const root=await mkdtemp(join(tmpdir(),'ez-scheduler-smoke-')),workspace=join(root,'agent'),controlDir=join(root,'control')
await initializeWorkspace(workspace)
const control=new ControlStore(controlDir,1000),scheduler=new Scheduler(controlDir),runs=new RunStore(controlDir)
await control.requestPairing(101,101);await control.approveOwner(101)
const owner=(await control.status()).owner!,execution=await control.captureChoice(initialPreset(cli))
const replies:{at:number;text:string}[]=[]
const relay=createRelay({workspace,controlDir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:cli,telegramBotToken:'fixture'})
relay.bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof relay.bot.botInfo
relay.bot.api.config.use(async(_previous,method,payload)=>{
 if(method==='sendMessage') {const reply={at:Date.now(),text:(payload as {text:string}).text};replies.push(reply);console.log(JSON.stringify({reply}))}
 return {ok:true,result:{message_id:replies.length}} as never
})
const due=Date.now()+2000
await scheduler.save({id:'sleep',name:'Long-running synthetic QA',text:`This is an authorized synthetic test. In your task directory write progress.md with WAITING. Run a terminal sleep for ${duration} seconds and wait for that command to finish. Then write finished.txt containing DONE and use ezenciel-agents-message --text 'BACKGROUND_DONE'. Do not reschedule or finish early. No external services are needed.`,trigger:{at:new Date(due).toISOString()},enabled:true,owner,execution})
let draining=false
const tick=setInterval(()=>{if(!draining){draining=true;void relay.drainSources().then(()=>relay.drainOutbox()).catch(console.error).finally(()=>{draining=false})}},250)
const until=async(check:()=>Promise<boolean>,seconds:number)=>{
 const deadline=Date.now()+seconds*1000
 while(!await check()){if(Date.now()>deadline)throw new Error('Probe timed out');await new Promise(r=>setTimeout(r,250))}
}
console.log(JSON.stringify({root,duration,cli}))
try{
 await until(async()=>(await runs.list()).some(r=>r.scheduled && r.status==='running'),60)
 const [background]=(await runs.list()).filter(r=>r.scheduled)
 const message:Update={update_id:10,message:{message_id:10,date:0,text:"What is 17 times 19? Reply with the number using ezenciel-agents-message. This is a local test with a synthetic delivery provider.",from:{id:101,is_bot:false,first_name:'Fixture'},chat:{id:101,type:'private',first_name:'Fixture'}}}
 const askedAt=Date.now();await relay.bot.handleUpdate(message);await relay.drainInbox(true)
 await until(async()=>replies.some(r=>/323/.test(r.text)),180)
 if((await runs.get(background.id))?.status!=='running')throw new Error('Background stopped before chat reply')
 console.log(JSON.stringify({chatReplyMs:Date.now()-askedAt,backgroundState:'running'}))
 if(duration>360){
  await until(async()=>Date.now()-askedAt>360000,duration)
  const followup={...message,update_id:11,message:{...message.message!,message_id:11,text:'Check ezenciel-agents-schedule runs. If the background task is actually running, send BACKGROUND_STATUS_RUNNING followed by its exact run ID. Otherwise report the problem.'}} as Update
  const before=replies.length;await relay.bot.handleUpdate(followup);await relay.drainInbox(true)
  await until(async()=>replies.slice(before).some(r=>r.text.includes('BACKGROUND_STATUS_RUNNING') && r.text.includes(background.id)),180)
  if((await runs.get(background.id))?.status!=='running')throw new Error('Background stopped at six-minute check')
  console.log(JSON.stringify({sixMinuteCheck:'passed',backgroundState:'running'}))
 }
 await until(async()=> (await runs.get(background.id))?.status!=='running',duration+180)
 await relay.drainOutbox()
 const status=(await runs.get(background.id))?.status
 if(status!=='completed' || replies.filter(r=>r.text.includes('BACKGROUND_DONE')).length!==1)throw new Error('Missing completed run or exactly one delivered result')
 const finished=await readFile(join(workspace,'work/tasks',background.id,'finished.txt'),'utf8')
 if(finished.trim()!=='DONE')throw new Error('Missing finished.txt artifact')
 const record=(await runs.get(background.id))!
 if(Date.parse(record.endedAt!)-Date.parse(record.startedAt!) < duration*1000)throw new Error('Worker completed before requested duration')
 const evidence={duration,cli,status,replies,run:await runs.get(background.id)}
 await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600})
 console.log(JSON.stringify({passed:true,evidence:join(root,'evidence.json')}))
}finally{clearInterval(tick);while(draining)await new Promise(r=>setTimeout(r,50));await relay.stop()}
