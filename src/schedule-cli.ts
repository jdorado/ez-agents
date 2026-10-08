import { needsFailureReview, failureStamp, redactFailure } from './failure.js'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadControlConfig } from './config.js'
import { ControlStore, sameOwner } from './control-state.js'
import { ApplicationBindings } from './application-channel.js'
import type { RunRecord } from './runs.js'
import { callDeliverySocket, socketPathFor } from './delivery-socket.js'
import { initialPreset, isPreset, presetLabel, type AiPreset } from './ai.js'
import { executionOverrides } from './model-policy.js'
import { holdsSchedule, Scheduler, executionType } from './scheduler.js'
import { Scripts, fileSha256, workspaceEntry, DEFAULT_SCRIPT_TIMEOUT_SECONDS } from './scripts.js'
import { executorEnvironment } from './executor.js'
import { provisionedHome } from './auth-profile.js'
import { ownsRun } from './identity.js'
import { type Trigger } from './schedule-time.js'

// Each fallback selects its own native engine, credential home and model.
const fallbackSetup = (spec: string, index: number): AiPreset => {
  const fields = Object.fromEntries(spec.split(',').map(part => {
    const at = part.indexOf('=')
    if (at < 1) throw new Error('Fallback uses cli=EXECUTOR,model=MODEL[,auth-profile=NAME][,effort=EFFORT][,provider=ID]')
    return [part.slice(0, at), part.slice(at + 1)]
  }))
  if (Object.keys(fields).some(key => !['cli','model','auth-profile','effort','provider'].includes(key)) || !fields.cli || !fields.model)
    throw new Error('Fallback uses cli=EXECUTOR,model=MODEL[,auth-profile=NAME][,effort=EFFORT][,provider=ID]')
  const base = initialPreset(fields.cli)
  const preset = executionOverrides(base.cli, {...base, ...(fields.provider ? {provider: fields.provider} : {}),
    ...(fields['auth-profile'] !== undefined ? {authProfile: fields['auth-profile']} : {})}, fields.model, fields.effort)
  const named = {...preset, id: `fallback-${index + 1}`, name: presetLabel(preset).slice(0, 80)}
  if (!isPreset(named)) throw new Error('Invalid fallback setup')
  return named
}

async function main() {
  const { values:v, positionals:[action='list',id,scriptId] } = parseArgs({allowPositionals:true,options:{
    script:{type:'string'}, arg:{type:'string',multiple:true}, file:{type:'string'}, interpreter:{type:'string'}, 'timeout-seconds':{type:'string'},
    cli:{type:'string'}, 'auth-profile':{type:'string'}, model:{type:'string'}, effort:{type:'string'}, fallback:{type:'string',multiple:true}, 'clear-fallbacks':{type:'boolean'},
    all:{type:'boolean'}, limit:{type:'string'}, offset:{type:'string'}, expected:{type:'string'}, key:{type:'string'}, when:{type:'string'}, status:{type:'string'}, diagnosis:{type:'string'}, recovery:{type:'string'}, outcome:{type:'string'}, 'failed-at':{type:'string'},
    'preflight-file':{type:'string'},'clear-preflight':{type:'boolean'},name:{type:'string'}, text:{type:'string'}, 'text-file':{type:'string'}, at:{type:'string'}, now:{type:'boolean'},
    cron:{type:'string'}, timezone:{type:'string'}, 'every-seconds':{type:'string'}, start:{type:'string'}, until:{type:'string'}, help:{type:'boolean'},
  }})
  if(v.help){console.log(`ezenciel-agents-schedule list | runs | show ID | pause ID | resume ID | remove ID | cancel RUN_ID
  failures [--all] [--limit N] | run RUN_ID | context
  evidence [RUN_ID] [--offset N --limit N --expected SNAPSHOT_SHA256]
  trigger SCHEDULE_ID --key REQUEST_KEY
  review RUN_ID --failed-at ISO --status resolved|attention --diagnosis TEXT --recovery TEXT --outcome TEXT
  create [ID] | edit ID --name NAME (--text TEXT | --text-file FILE | --script SCRIPT_ID [--arg=VALUE ...])
    --now | --at ISO_WITH_OFFSET | --every-seconds N | --cron 'MIN HOUR DAY MONTH WEEKDAY' --timezone IANA
    [--cli EXECUTOR] [--auth-profile NAME] [--model MODEL] [--effort <native-effort>]
    [--fallback cli=EXECUTOR,model=MODEL[,auth-profile=NAME][,effort=EFFORT][,provider=ID] ... | --clear-fallbacks]
    [--preflight-file FILE | --clear-preflight]
    [--start ISO_WITH_OFFSET] [--until ISO_WITH_OFFSET] [--when unreviewed-failures]
  script list | show SCRIPT_ID | remove SCRIPT_ID
  script register|update SCRIPT_ID --file WORKSPACE_PATH --interpreter COMMAND [--arg=VALUE ...] [--timeout-seconds N]
Execution types: agent (prompt, engine, auth profile, model, effort) or script (registered script ID and saved arguments).
--auth-profile runs a Codex/Claude task under that provisioned login (ezenciel-agents-ai profiles); --cli alone uses the default login.
A script registration references an entry point inside the agent workspace and records its SHA-256. Core invokes
the installed interpreter with the entry point and arguments directly, without a shell or a model. Changed entry-point
bytes refuse to run until an explicit script update. The hash covers that file only, not imported dependencies.
Script runs receive EZ_RUN_ID, EZ_SCHEDULE_ID, EZ_SCHEDULE_REVISION, EZ_DUE_AT, EZ_SCRIPT_ID, EZ_SCRIPT_REVISION and
EZ_SCRIPT_SHA256 plus the normal executor allowlist. Stdout/stderr are bounded diagnostics in run, never owner messages.
Script runs have a timeout (default ${DEFAULT_SCRIPT_TIMEOUT_SECONDS}s) and are never retried automatically.
Context reads the current run only.
Evidence exports sanitized current-owner Telegram operational metadata only.
Follow nextOffset with --expected; a changed snapshot requires restarting.
Relay retention is incomplete. Content hashes identify submitted text, not recipient content.
Native sessions, tool/delegation events and failure/review prose are not exported.
Failures default to unreviewed owner runs. Review records a diagnosis; it never changes execution status or retries work.
A conditional review schedule consumes no model run when there are no unreviewed failures.
New tasks capture the selected engine settings; edit preserves existing settings unless overridden.
Every task requires a concrete saved model. Supply --model if the selected settings have none; existing tasks never fall back to chat or client defaults.
Fallbacks run in the saved order only when the previous setup's CLI is unavailable or its provider
rejected the turn before any work began. Access denial, unknown errors, cancellation and failure after work began stop
the chain; nothing is replayed. A quota rejection skips later setups of the same native login profile
or upstream provider. Named profiles must be owner-provisioned logins for separate accounts; Ez never enables overage.
The run records each attempt, setup, failure category and any reported reset time.
Trigger runs an existing task once with its saved instructions, AI and delivery binding in a fresh session. Reuse the request key after an uncertain result; the regular schedule is unchanged.
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
  // A script occurrence may read state and deliver through bound plugins; it
  // cannot change registrations or schedules, including its own.
  const readOnly=['list','runs','show','run','context','failures','evidence'].includes(action) || (action==='script' && ['list','show'].includes(id ?? ''))
  if(caller?.script && !readOnly)throw new Error('Script runs cannot change scripts or schedules')
  const owned=(s:{owner:typeof owner})=>sameOwner(s.owner,owner)
  const ownsFailureRun=(r:RunRecord | null)=>r && ownsRun(owner,r) && (!r.scheduled || r.scheduled.pairedAt===owner.pairedAt)
  const show=async(s:Awaited<ReturnType<Scheduler['get']>>)=>{
    const held=(await runs.listBestEffort()).filter(r=>holdsSchedule(s,r))
    const interruptedRunIds=held.filter(r=>r.interrupted).map(r=>r.id)
    const failedReviewRunIds=held.filter(r=>!r.interrupted).map(r=>r.id)
    const next=s.enabled && !held.length ? await scheduler.pendingOccurrence(s) : null
    return {...s,executionType:executionType(s),preflightReceipt:await scheduler.preflightReceipt(s),interruptedRunIds,failedReviewRunIds,nextEligibleAt:next===null ? null : new Date(next).toISOString(),
      ...(held.length ? {recovery:'Inspect the failed run and explicitly edit this schedule to resume; pause/resume does not clear the stop.'} : {})}
  }
  const scripts=new Scripts(config.controlDir)
  let result:unknown
  if(action==='script'){
    const workspace=process.env.EZ_AGENT_WORKSPACE?.trim() || process.cwd()
    if(id==='list')result=await scripts.list(owner)
    else if(!scriptId)throw new Error('Script ID required')
    else if(id==='show'){
      const registration=await scripts.owned(scriptId,owner)
      let current:string|null=null
      try{current=await fileSha256((await workspaceEntry(workspace,registration.entry)).file)}catch{}
      result={...registration,currentSha256:current,matchesRegistration:current===registration.sha256,
        schedules:(await scheduler.list()).filter(s=>owned(s) && s.script?.id===scriptId).map(s=>s.id)}
    }else if(id==='remove'){
      const users=(await scheduler.list()).filter(s=>owned(s) && s.script?.id===scriptId).map(s=>s.id)
      if(users.length)throw new Error(`Script is used by schedules ${users.join(', ')}; edit or remove them first`)
      await scripts.remove(scriptId,owner);result={removed:scriptId}
    }else if(id==='register' || id==='update'){
      const previous=id==='update' ? await scripts.owned(scriptId,owner) : undefined
      if(id==='register' && (!v.file || !v.interpreter))throw new Error('Register requires --file and --interpreter')
      const timeout=v['timeout-seconds']===undefined ? previous?.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS : Number(v['timeout-seconds'])
      result=await scripts.save({id:scriptId,owner,workspace,entry:v.file ? resolve(v.file) : previous!.entry,interpreter:v.interpreter ?? previous!.interpreter,
        args:v.arg ?? previous?.args ?? [],timeoutSeconds:timeout,pathValue:executorEnvironment().PATH},id==='register')
    }else throw new Error('Unknown script action; use --help')
  }else if(action==='evidence'){
    result=await callDeliverySocket(socketPath,{op:'evidence',payload:{
      ...(caller ? {callerRunId:caller.id} : {}), ...(id ? {runId:id} : {}),
      offset:Number(v.offset ?? 0),limit:Number(v.limit ?? 100),expected:v.expected,
    }})
  }else if(action==='context'){
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
  else if(action==='trigger'){
    if(!id || !v.key)throw new Error('Trigger requires SCHEDULE_ID and --key REQUEST_KEY')
    if(Object.keys(v).some(key=>key!=='key'))throw new Error('Trigger uses saved task settings; overrides are not allowed')
    const schedule=await scheduler.get(id)
    if(!owned(schedule))throw new Error('Schedule ownership mismatch')
    result=await callDeliverySocket(socketPath,{op:'triggerSchedule',payload:{scheduleId:id,revision:schedule.revision,key:v.key,...(caller ? {callerRunId:caller.id} : {})}})
  }else if(action==='create' || action==='edit'){
    if(action==='edit' && (!id || !owned(await scheduler.get(id))))throw new Error('Unknown schedule')
    if(action==='create' && id && (await scheduler.list()).some(s=>s.id===id))throw new Error('Schedule exists; use edit')
    if([v.now,v.at,v.cron,v['every-seconds']].filter(Boolean).length!==1)throw new Error('Choose exactly one trigger')
    if([v.text,v['text-file'],v.script].filter(Boolean).length!==1)throw new Error('Choose --text, --text-file or --script')
    if(v.script && (v.cli || v['auth-profile'] || v.model || v.effort || v.fallback || v['clear-fallbacks']))throw new Error('Script schedules run no model; --cli, --auth-profile, --model, --effort and --fallback do not apply')
    if(v.fallback && v['clear-fallbacks'])throw new Error('Choose --fallback or --clear-fallbacks')
    if(v.arg && !v.script)throw new Error('--arg applies to script schedules only')
    const start=v.start || new Date(Date.now()+1000).toISOString()
    const trigger:Trigger=v.now ? {at:new Date(Date.now()+1000).toISOString()} : v.at ? {at:v.at} :
      v.cron ? {cron:v.cron,timezone:v.timezone!,start,until:v.until} : {everySeconds:Number(v['every-seconds']),start,until:v.until}
    if(v['clear-preflight'] && v['preflight-file']) throw Error('Choose one preflight operation')
    const previousSchedule = action === 'edit' ? await scheduler.get(id!) : undefined
    const preflight = v['clear-preflight'] ? undefined : v['preflight-file'] ? JSON.parse(await readFile(v['preflight-file'],'utf8')) : previousSchedule?.preflight
    const origin = caller?.application ?? caller?.delivery
    const delivery = previousSchedule ? previousSchedule.delivery : (origin ? {bindingId:origin.bindingId,scope:origin.scope} : undefined)
    if (!delivery && !owner.telegramChatId) throw new Error('Create the schedule from an authenticated channel turn to bind its reply destination')
    if (v.script) {
      result=await show(await scheduler.save({id:id || 's_'+randomUUID(),name:v.name || v.script,preflight,
        originRunId:previousSchedule?.originRunId ?? caller?.scheduled?.originRunId ?? caller?.id,delivery,text:'',when:v.when as 'unreviewed-failures' | undefined,trigger,enabled:true,owner,
        script:{id:v.script,args:v.arg ?? []}},action==='create'))
      console.log(JSON.stringify(result,null,2));return
    }
    const previous = previousSchedule?.execution
    const state = await control.status()
    const selected = state.ai?.presets.find(p => p.id === state.ai!.selectedId)
    const base = v.cli ? initialPreset(v.cli) : previous?.preset || selected || initialPreset(process.env.EZ_EXECUTOR_CLI || 'codex')
    const preset = executionOverrides(base.cli, v['auth-profile'] === undefined ? base : {...base, authProfile:v['auth-profile']}, v.model, v.effort)
    if (!isPreset(preset)) throw new Error('Invalid task AI selection')
    const fallbacks = v['clear-fallbacks'] ? undefined : v.fallback ? v.fallback.map(fallbackSetup) : previous?.fallbacks
    for (const setup of [preset, ...fallbacks ?? []])
      if (setup.authProfile !== undefined) await provisionedHome(config.controlDir, setup.cli, setup.authProfile)
    result=await show(await scheduler.save({id:id || 's_'+randomUUID(),name:v.name || 'Task',
      preflight,
      originRunId:previousSchedule?.originRunId ?? caller?.scheduled?.originRunId ?? caller?.id,delivery,text:v.text || await readFile(v['text-file']!,'utf8'),when:v.when as 'unreviewed-failures' | undefined,trigger,enabled:true,owner,
      execution:{sessionId:previous?.sessionId || randomUUID(),preset,...(fallbacks ? {fallbacks} : {})}},action==='create'))
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
