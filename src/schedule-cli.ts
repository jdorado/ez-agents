import { needsFailureReview, failureStamp, redactFailure } from './failure.js'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { loadControlConfig } from './config.js'
import { ControlStore, sameOwner } from './control-state.js'
import { ApplicationBindings } from './application-channel.js'
import type { RunRecord } from './runs.js'
import { callDeliverySocket, socketPathFor } from './delivery-socket.js'
import { initialPreset, isPreset } from './ai.js'
import { executionOverrides } from './model-policy.js'
import { holdsSchedule, Scheduler } from './scheduler.js'
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
  failures [--all] [--limit N] | run RUN_ID | context
  review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT
  create [ID] | edit ID --name NAME (--text TEXT | --text-file FILE)
    --now | --at ISO_WITH_OFFSET | --every-seconds N | --cron 'MIN HOUR DAY MONTH WEEKDAY' --timezone IANA
    [--cli EXECUTOR] [--model MODEL] [--effort <native-effort>]
    [--start ISO_WITH_OFFSET] [--until ISO_WITH_OFFSET] [--when unreviewed-failures]
Context reads the current run only.
Failures default to unreviewed owner runs. Review records a diagnosis; it never changes execution status or retries work.
A conditional review schedule consumes no model run when there are no unreviewed failures.
New tasks inherit the selected engine settings. Omitted model/effort uses native defaults; edit preserves existing settings unless overridden.
Creates a scheduled task. Instructions are text, never shell commands.
Use --now to run once. Run completion is not delivery proof.
Edit replaces the full schedule. Pause/remove affect future work; cancel stops a particular run.
Cron uses numeric five-field syntax, lists/ranges/steps, and traditional day/weekday OR semantics.`);return}
  const config=loadControlConfig(), control=new ControlStore(config.controlDir,config.pairingTtlMs)
  const owner=(await control.status()).owner
  if(!owner)throw new Error('Pair an owner before scheduling')
  const socketPath=socketPathFor(config.controlDir)
  // Run records live in the relay memory ledger, reached through the delivery
  // socket. Schedule files stay on disk, so list/show/create/edit/pause/
  // resume/remove keep working with the relay stopped; run-inspecting actions
  // (context/failures/run/review/runs/cancel) require the running relay.
  const socketUnavailable = (error: unknown): boolean =>
    error instanceof Error && /Delivery relay unavailable/.test(error.message)
  const runs={
    get: (runId: string): Promise<RunRecord | null> =>
      callDeliverySocket(socketPath, { op: 'get', payload: { runId } }).then(run => run as RunRecord).catch(error => {
        if (error instanceof Error && /Unknown run/.test(error.message)) return null
        throw error
      }),
    list: (): Promise<RunRecord[]> => callDeliverySocket(socketPath, { op: 'list' }).then(result => result as RunRecord[]),
    listBestEffort: (): Promise<RunRecord[]> => callDeliverySocket(socketPath, { op: 'list' })
      .then(result => result as RunRecord[]).catch(error => { if (socketUnavailable(error)) return []; throw error }),
    patch: (runId: string, change: unknown): Promise<RunRecord> =>
      callDeliverySocket(socketPath, { op: 'patch', payload: { runId, change: change as Record<string, unknown> } }).then(run => run as RunRecord),
  }
  const scheduler=new Scheduler(config.controlDir)
  const caller=process.env.EZ_RUN_ID ? await runs.get(process.env.EZ_RUN_ID) : null
  if (caller?.application || caller?.delivery) await new ApplicationBindings(config.controlDir).authorize(caller)
  if(process.env.EZ_RUN_ID && (!caller || caller.status!=='running' || caller.external || caller.taskId || caller.replyOnly ||
    !ownsRun(owner, caller) ||
    (caller.scheduled && caller.scheduled.pairedAt!==owner.pairedAt)))throw new Error('Scheduling requires an active owner-authorized run')
  const owned=(s:{owner:typeof owner})=>sameOwner(s.owner,owner)
  const ownsFailureRun=(r:RunRecord | null)=>r && ownsRun(owner,r) && (!r.scheduled || r.scheduled.pairedAt===owner.pairedAt)
  const show=async(s:Awaited<ReturnType<Scheduler['get']>>)=>{
    const held=(await runs.listBestEffort()).filter(r=>holdsSchedule(s,r))
    const interruptedRunIds=held.filter(r=>r.interrupted).map(r=>r.id)
    const failedReviewRunIds=held.filter(r=>!r.interrupted).map(r=>r.id)
    const next=s.enabled && !held.length ? nextOccurrence(s.trigger,Date.now()) : null
    return {...s,interruptedRunIds,failedReviewRunIds,nextEligibleAt:next===null ? null : new Date(next).toISOString(),
      ...(held.length ? {recovery:'Inspect the failed run and explicitly edit this schedule to resume; pause/resume does not clear the stop.'} : {})}
  }
  let result:unknown
  if(action==='context'){
    if(!caller)throw new Error('Context requires an active owner run')
    const origin=caller.scheduled?.originRunId ? await runs.get(caller.scheduled.originRunId) : null
    if(origin && !ownsFailureRun(origin))throw new Error('Source context is outside this owner binding')
    result={run:caller,...(origin ? {origin} : {})}
  }else if(action==='failures'){
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
  else if(action==='runs')result=(await runs.list()).filter(r=>r.scheduled && r.scheduled.pairedAt===owner.pairedAt && ownsRun(owner,r))
  else if(action==='create' || action==='edit'){
    if(action==='edit' && (!id || !owned(await scheduler.get(id))))throw new Error('Unknown schedule')
    if(action==='create' && id && (await scheduler.list()).some(s=>s.id===id))throw new Error('Schedule exists; use edit')
    if([v.now,v.at,v.cron,v['every-seconds']].filter(Boolean).length!==1)throw new Error('Choose exactly one trigger')
    if(Boolean(v.text)===Boolean(v['text-file']))throw new Error('Choose --text or --text-file')
    const start=v.start || new Date(Date.now()+1000).toISOString()
    const trigger:Trigger=v.now ? {at:new Date(Date.now()+1000).toISOString()} : v.at ? {at:v.at} :
      v.cron ? {cron:v.cron,timezone:v.timezone!,start,until:v.until} : {everySeconds:Number(v['every-seconds']),start,until:v.until}
    const previousSchedule = action === 'edit' ? await scheduler.get(id!) : undefined
    const origin = caller?.application ?? caller?.delivery
    const delivery = previousSchedule ? previousSchedule.delivery : (origin ? {bindingId:origin.bindingId,scope:origin.scope} : undefined)
    if (!delivery && !owner.telegramChatId) throw new Error('Create the schedule from an authenticated channel turn to bind its reply destination')
    const previous = previousSchedule?.execution
    const state = await control.status()
    const selected = state.ai?.presets.find(p => p.id === state.ai!.selectedId)
    const base = v.cli ? initialPreset(v.cli) : previous?.preset || selected || initialPreset(process.env.EZ_EXECUTOR_CLI || 'codex')
    const preset = executionOverrides(base.cli, base, v.model, v.effort)
    if (!isPreset(preset)) throw new Error('Invalid task AI selection')
    result=await show(await scheduler.save({id:id || 's_'+randomUUID(),name:v.name || 'Task',
      originRunId:previousSchedule?.originRunId ?? caller?.scheduled?.originRunId ?? caller?.id,delivery,text:v.text || await readFile(v['text-file']!,'utf8'),when:v.when as 'unreviewed-failures' | undefined,trigger,enabled:true,owner,
      execution:{sessionId:previous?.sessionId || randomUUID(),preset}},action==='create'))
  }else{
    if(!id)throw new Error('ID required')
    if(action==='cancel'){
      const run=await runs.get(id)
      if(!run?.scheduled || run.scheduled.pairedAt!==owner.pairedAt || !ownsRun(owner,run))throw new Error('Unknown background run')
      await scheduler.cancel(id, run);result={cancelRequested:id}
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
