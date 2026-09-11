import { needsFailureReview, failureStamp, redactFailure } from './failure.js'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { loadControlConfig } from './config.js'
import { ControlStore } from './control-state.js'
import { RunStore } from './runs.js'
import { initialPreset, isPreset } from './ai.js'
import { Scheduler } from './scheduler.js'
import { ownsRun } from './identity.js'
import { nextOccurrence, type Trigger } from './schedule-time.js'

async function main() {
  const { values:v, positionals:[action='list',id] } = parseArgs({allowPositionals:true,options:{
    cli:{type:'string'}, model:{type:'string'}, effort:{type:'string'},
    all:{type:'boolean'}, limit:{type:'string'}, when:{type:'string'}, status:{type:'string'}, diagnosis:{type:'string'}, recovery:{type:'string'}, outcome:{type:'string'}, 'failed-at':{type:'string'},
    name:{type:'string'}, text:{type:'string'}, 'text-file':{type:'string'}, at:{type:'string'}, now:{type:'boolean'},
    cron:{type:'string'}, timezone:{type:'string'}, 'every-seconds':{type:'string'}, start:{type:'string'}, until:{type:'string'}, help:{type:'boolean'},
  }})
  if(v.help){console.log(`ezenciel-agents-schedule list | runs | show ID | pause ID | resume ID | remove ID | cancel RUN_ID
  failures [--all] [--limit N] | run RUN_ID
  review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT
  create [ID] | edit ID --name NAME (--text TEXT | --text-file FILE)
    --now | --at ISO_WITH_OFFSET | --every-seconds N | --cron 'MIN HOUR DAY MONTH WEEKDAY' --timezone IANA
    [--cli EXECUTOR] [--model MODEL] [--effort none|minimal|low|medium|high|xhigh|max (Luna only)]
    [--start ISO_WITH_OFFSET] [--until ISO_WITH_OFFSET] [--when unreviewed-failures]
Failures default to unreviewed owner runs. Review records a diagnosis; it never changes execution status or retries work.
A conditional review schedule consumes no model run when there are no unreviewed failures.
New tasks default to Codex Luna/max, independently of the current chat. Explicit settings override these defaults; edit preserves existing settings unless overridden.
Creates a durable, asynchronous CLI task. Instructions are text, never shell commands.
Use --now to delegate long work and return to chat. Run completion is not delivery proof.
Edit replaces the full schedule. Pause/remove affect future work; cancel stops a particular run.
Cron uses numeric five-field syntax, lists/ranges/steps, and traditional day/weekday OR semantics.`);return}
  const config=loadControlConfig(), control=new ControlStore(config.controlDir,config.pairingTtlMs)
  const owner=(await control.status()).owner
  if(!owner)throw new Error('Pair an owner before scheduling')
  const runs=new RunStore(config.controlDir), scheduler=new Scheduler(config.controlDir)
  const caller=process.env.EZ_RUN_ID ? await runs.get(process.env.EZ_RUN_ID) : null
  if(process.env.EZ_RUN_ID && (!caller || caller.status!=='running' || caller.external || caller.taskId || caller.replyOnly ||
    !ownsRun(owner, caller) ||
    (caller.scheduled && caller.scheduled.pairedAt!==owner.pairedAt)))throw new Error('Scheduling requires an active owner-authorized run')
  const owned=(s:{owner:typeof owner})=>s.owner.telegramUserId===owner.telegramUserId && s.owner.telegramChatId===owner.telegramChatId && s.owner.pairedAt===owner.pairedAt
  const ownsFailureRun=(r:Awaited<ReturnType<RunStore['get']>>)=>r && ownsRun(owner,r) && (!r.scheduled || r.scheduled.pairedAt===owner.pairedAt)
  const show=async(s:Awaited<ReturnType<Scheduler['get']>>)=>{
    const interruptedRunIds=(await runs.list()).filter(r=>r.scheduled?.id===s.id && r.scheduled.revision===s.revision && r.interrupted).map(r=>r.id)
    const next=s.enabled && !interruptedRunIds.length ? nextOccurrence(s.trigger,Date.now()) : null
    return {...s,interruptedRunIds,nextEligibleAt:next===null ? null : new Date(next).toISOString()}
  }
  let result:unknown
  if(action==='failures'){
    const limit=Number(v.limit || 20)
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100)throw new Error('Limit must be 1..100')
    const matches=(await runs.list()).filter(r=>ownsFailureRun(r) && (v.all ? r.status==='failed' : needsFailureReview(r)))
    result={total:matches.length,runs:matches.slice(0,limit).map(r=>({id:r.id,schedule:r.scheduled?.id,failedAt:failureStamp(r),exitCode:r.exitCode,reason:r.failureReason,nativeSessionId:r.nativeSessionId,failure:r.failure,review:r.failureReview}))}
  }else if(action==='run' || action==='review'){
    if(!id)throw new Error('Run ID required')
    const run=await runs.get(id)
    if(!ownsFailureRun(run))throw new Error('Unknown owner run')
    if(action==='run')result=run
    else {
      if(!v.diagnosis || !v.recovery || !v.outcome || !v['failed-at'] || !['resolved','attention'].includes(v.status || ''))throw new Error('Review requires --failed-at, --status resolved|attention, --diagnosis, --recovery and --outcome')
      result=await runs.patch(id,{failureReview:{failedAt:v['failed-at'],reviewedAt:new Date().toISOString(),reviewerRunId:caller?.id,status:v.status as 'resolved'|'attention',diagnosis:redactFailure(v.diagnosis).slice(0,2000),recovery:redactFailure(v.recovery).slice(0,2000),outcome:redactFailure(v.outcome).slice(0,2000)}})
    }
  }else if(action==='list')result=await Promise.all((await scheduler.list()).filter(owned).map(show))
  else if(action==='runs')result=(await runs.list()).filter(r=>r.scheduled && r.scheduled.pairedAt===owner.pairedAt && r.telegramUserId===owner.telegramUserId && r.chatId===owner.telegramChatId)
  else if(action==='create' || action==='edit'){
    if(action==='edit' && (!id || !owned(await scheduler.get(id))))throw new Error('Unknown schedule')
    if(action==='create' && id && (await scheduler.list()).some(s=>s.id===id))throw new Error('Schedule exists; use edit')
    if([v.now,v.at,v.cron,v['every-seconds']].filter(Boolean).length!==1)throw new Error('Choose exactly one trigger')
    if(Boolean(v.text)===Boolean(v['text-file']))throw new Error('Choose --text or --text-file')
    const start=v.start || new Date(Date.now()+1000).toISOString()
    const trigger:Trigger=v.now ? {at:new Date(Date.now()+1000).toISOString()} : v.at ? {at:v.at} :
      v.cron ? {cron:v.cron,timezone:v.timezone!,start,until:v.until} : {everySeconds:Number(v['every-seconds']),start,until:v.until}
    const previous = action === 'edit' ? (await scheduler.get(id!)).execution : undefined
    const base = v.cli ? initialPreset(v.cli) : previous?.preset || initialPreset('codex')
    const preset = {...base, ...(v.model ? {model:v.model} : {}), ...(v.effort ? {effort:v.effort} : {})}
    if (!isPreset(preset)) throw new Error('Invalid task AI selection')
    result=await show(await scheduler.save({id:id || 's_'+randomUUID(),name:v.name || 'Task',
      text:v.text || await readFile(v['text-file']!,'utf8'),when:v.when as 'unreviewed-failures' | undefined,trigger,enabled:true,owner,
      execution:{sessionId:previous?.sessionId || randomUUID(),preset}},action==='create'))
  }else{
    if(!id)throw new Error('ID required')
    if(action==='cancel'){
      const run=await runs.get(id)
      if(!run?.scheduled || run.scheduled.pairedAt!==owner.pairedAt || run.telegramUserId!==owner.telegramUserId || run.chatId!==owner.telegramChatId)throw new Error('Unknown background run')
      await scheduler.cancel(id);result={cancelRequested:id}
    }else{
      const s=await scheduler.get(id)
      if(!owned(s))throw new Error('Schedule ownership mismatch')
      if(action==='show')result=await show(s)
      else if(action==='pause' || action==='resume')result=await show(await scheduler.enable(id,action==='resume'))
      else if(action==='remove'){await scheduler.remove(id);result={removed:id}}
      else throw new Error('Unknown action; use --help')
    }
  }
  console.log(JSON.stringify(result,null,2))
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
