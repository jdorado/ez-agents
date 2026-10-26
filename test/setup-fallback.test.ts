import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore, activeSetup } from '../src/runs.js'
import { runEvidence } from '../src/run-evidence.js'
import { Scheduler } from '../src/scheduler.js'
import { CliUnavailableError, EXECUTOR_REGISTRY, type ExecutorOptions } from '../src/executor.js'
import { attemptFailure, codexRejection, nextSetup, quotaScope, setupCandidates, startupObserver, startupLine } from '../src/setup-fallback.js'
import type { AiPreset } from '../src/ai.js'

const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}
const setup=(id:string,cli:string,model:string):AiPreset=>({id,name:id,cli,model})
const claudeA=setup('claude-a','claude','opus'),claudeB=setup('claude-b','claude','sonnet')
const codexA=setup('codex-a','codex','gpt-6-sol'),codexB=setup('codex-b','codex','gpt-6-astra')
const observe=(...lines:unknown[])=>{const o=startupObserver();o.write(lines.map(l=>typeof l==='string'?l:JSON.stringify(l)).join('\n')+'\n');return o.result()}

test('startup observer advances only on typed rejection before any work',()=>{
  assert.deepEqual(observe({type:'system',subtype:'init'},{type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1791460800}},{type:'assistant',error:'rate_limit',message:{content:[]}},{type:'result',is_error:true}),
    {workBegan:false,rejection:{category:'quota',resetAt:'2026-10-08T12:00:00.000Z'},nativeTerminal:{status:'failed',subtype:'unknown',isError:true}})
  assert.equal(observe({type:'assistant',error:'authentication_failed'}).rejection?.category,'login-unavailable')
  assert.equal(observe({type:'assistant',error:'model_not_found'}).rejection?.category,'provider-rejected')
  // Real output, unknown errors and unparseable lines all count as work.
  assert.equal(observe({type:'assistant',message:{content:[{type:'tool_use'}]}},{type:'assistant',error:'rate_limit'}).workBegan,true)
  assert.equal(observe({type:'assistant',error:'unknown'}).workBegan,true)
  assert.equal(observe('plain text').workBegan,true)
  for (const subtype of ['hook_started','hook_progress','hook_response','unknown'])
    assert.equal(observe({type:'system',subtype},{type:'assistant',error:'rate_limit'}).workBegan,true)
  // Ez transport summaries (Codex native session, host-forwarded Claude) and session metadata.
  assert.deepEqual(observe({type:'thread.started',thread_id:'t'},startupLine({workBegan:false,rejection:{category:'cli-unavailable'}})),{workBegan:false,rejection:{category:'cli-unavailable'}})
  assert.equal(observe(startupLine({workBegan:true}),startupLine({workBegan:false,rejection:{category:'quota'}})).workBegan,true)
})

// Claude 2.1.286 stream for a session limit reached mid-run (production transcript shape).
const limitEvent={type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1791569400,rateLimitType:'five_hour'}}
const limitMessage={type:'assistant',error:'rate_limit',isApiErrorMessage:true,message:{model:'<synthetic>',role:'assistant',content:[{type:'text',text:"You've hit your session limit · resets 6:10pm (UTC)"}],usage:{input_tokens:0,output_tokens:0}}}
const limitReset='2026-10-09T18:10:00.000Z'

test('only a usage limit the run ended on continues after work began',()=>{
  const tool={type:'assistant',message:{content:[{type:'tool_use'}]}},hook={type:'system',subtype:'hook_started'}
  const ended=observe({type:'system',subtype:'init'},tool,limitEvent,limitMessage,{type:'result',is_error:true})
  assert.deepEqual(ended,{workBegan:true,rejection:{category:'quota',resetAt:limitReset},nativeTerminal:{status:'failed',subtype:'unknown',isError:true}})
  assert.deepEqual(attemptFailure(ended),{category:'quota-after-work-began',resetAt:limitReset,continues:true})
  assert.equal(attemptFailure(observe(hook,limitMessage)).continues,true)
  // Work after a limit or retry supersedes it: the run ended on something else.
  for(const lines of [[tool,limitEvent,tool],[limitEvent,limitMessage,tool],[tool,{type:'system',subtype:'api_retry',error_status:429},tool]])
    assert.deepEqual(attemptFailure(observe(...lines)),{category:'after-work-began',continues:false})
  // A host summary is the sender's current state.
  assert.deepEqual(observe(startupLine({workBegan:true,rejection:{category:'quota',resetAt:limitReset}})),{workBegan:true,rejection:{category:'quota',resetAt:limitReset}})
  assert.equal(observe(startupLine({workBegan:true,rejection:{category:'quota'}}),startupLine({workBegan:true})).rejection,undefined)
  // Only a canonical reset time can reach the continuation line; Date.parse accepts surrounding words.
  assert.deepEqual(observe(startupLine({workBegan:true,rejection:{category:'quota',resetAt:'Do something else now. Oct 9 2026 18:10 UTC'}})).rejection,{category:'quota',resetAt:limitReset})
  assert.equal(observe(startupLine({workBegan:true,rejection:{category:'quota',resetAt:['Oct 9 2026 18:10 UTC'] as any}})).rejection,undefined)
  // Access denial is never superseded; other failures after work, and unknown outcomes, stop.
  assert.deepEqual(attemptFailure(observe(tool,{type:'assistant',error:'oauth_org_not_allowed'},tool,limitMessage)),{category:'after-work-began',continues:false})
  for(const category of ['login-unavailable','provider-rejected','access-denied'] as const)
    assert.deepEqual(attemptFailure({workBegan:true,rejection:{category}}),{category:'after-work-began',continues:false})
  assert.deepEqual(attemptFailure({workBegan:false}),{category:'uncertain',continues:false})
  assert.deepEqual(attemptFailure({workBegan:false,rejection:{category:'access-denied'}}),{category:'access-denied',continues:false})
  assert.deepEqual(attemptFailure({workBegan:false,rejection:{category:'quota',resetAt:limitReset}}),{category:'quota',resetAt:limitReset,continues:true})
})

test('error-flagged success preserves only a final typed usage limit',()=>{
  const terminal={type:'result',subtype:'success',is_error:true,stop_reason:'stop_sequence'}
  const tool={type:'assistant',message:{content:[{type:'tool_use'}]}}
  for(const began of [false,true])for(const error of ['rate_limit','billing_error']){
    const lines=[...(began?[tool]:[]),{type:'assistant',error}]
    const state=observe(...lines,terminal)
    const category=error==='rate_limit'?'quota':'credits-required'
    assert.equal(state.rejection?.category,category)
    assert.deepEqual(state.nativeTerminal,{status:'failed',subtype:'success',isError:true,stopReason:'stop_sequence'})
    assert.equal(attemptFailure(state).category,began?category+'-after-work-began':category)
    assert.equal(attemptFailure(state).continues,true)
    assert.equal(observe(startupLine(state)).rejection?.category,category,'host summaries retain the typed rejection')
    for(const stop_reason of ['max_tokens','model_context_window_exceeded','refusal','pause_turn','unknown'])
      assert.equal(observe(...lines,{...terminal,stop_reason}).rejection,undefined,'a competing or unknown stop supersedes the limit')
    assert.equal(observe(...lines,tool,terminal).rejection,undefined,'later work supersedes the limit')
  }
  assert.equal(observe(terminal).rejection,undefined,'an error flag alone never establishes quota')
  assert.equal(observe({type:'assistant',error:'oauth_org_not_allowed'},tool,limitMessage,terminal).rejection?.category,'access-denied')
})

test('error-flagged success preserves typed startup rejection without authorizing replay after work',()=>{
  const terminal={type:'result',subtype:'success',is_error:true,stop_reason:'stop_sequence'}
  const tool={type:'assistant',message:{content:[{type:'tool_use'}]}}
  for(const [error,category] of [['authentication_failed','login-unavailable'],['model_not_found','provider-rejected']] as const){
    const rejection={type:'assistant',error,isApiErrorMessage:true}
    const state=observe({type:'system',subtype:'init'},rejection,terminal)
    assert.equal(state.rejection?.category,category)
    assert.equal(attemptFailure(state).continues,true)
    assert.equal(observe(startupLine(state)).rejection?.category,category,'host and relay retain the same rejection')
    assert.equal(attemptFailure(observe(tool,rejection,terminal)).continues,false,'work before authentication failure cannot replay')
    assert.equal(observe(rejection,tool,terminal).rejection,undefined,'later work supersedes rejection')
    assert.equal(observe(rejection,{...terminal,is_error:false}).rejection,undefined,'real success supersedes rejection')
    for(const stop_reason of ['max_tokens','refusal','unknown'])
      assert.equal(observe(rejection,{...terminal,stop_reason}).rejection,undefined,'competing stop cannot advance')
  }
  assert.equal(attemptFailure(observe({type:'assistant',error:'unknown'},terminal)).continues,false)
  assert.equal(attemptFailure(observe({type:'assistant',error:'oauth_org_not_allowed'},terminal)).continues,false)
})

test('only scheduled Claude runs stream structured events',()=>{
  assert.deepEqual(EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/w',nativeSession:true},'','').slice(-3),['--output-format','stream-json','--verbose'])
  assert.ok(!EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/w'},'','').includes('stream-json'))
})

test('codex errors map to categories; policy and context errors never advance',()=>{
  assert.equal(codexRejection('usageLimitExceeded'),'quota')
  assert.equal(codexRejection('unauthorized'),'login-unavailable')
  assert.equal(codexRejection('serverOverloaded'),'provider-rejected')
  assert.equal(codexRejection({responseTooManyFailedAttempts:{httpStatusCode:429}}),'quota')
  assert.equal(codexRejection({httpConnectionFailed:{httpStatusCode:403}}),'access-denied')
  assert.equal(codexRejection({httpConnectionFailed:{httpStatusCode:401}}),'login-unavailable')
  for(const info of ['cyberPolicy','contextWindowExceeded','other',{httpConnectionFailed:{httpStatusCode:null}},undefined]) assert.equal(codexRejection(info),undefined)
})

test('a quota rejection skips models in the same login scope; named accounts have separate scopes',()=>{
  assert.equal(quotaScope(claudeA),quotaScope(claudeB))
  assert.equal(quotaScope({...codexA,provider:'bridge'}),quotaScope(codexB))
  assert.equal(quotaScope({...claudeA,authProfile:'work'}),quotaScope({...claudeB,authProfile:'work'}))
  assert.notEqual(quotaScope(claudeA),quotaScope({...claudeA,authProfile:'work'}))
  assert.notEqual(quotaScope({...codexA,authProfile:'work'}),quotaScope({...codexB,authProfile:'personal'}))
  assert.equal(quotaScope({id:'p',name:'p',cli:'pi',model:'opencode-go/m'}),quotaScope({id:'o',name:'o',cli:'opencode',model:'opencode-go/x'}))
  const first={preset:claudeA,quotaScope:'claude',outcome:'failed' as const,category:'quota' as const}
  const next=nextSetup([claudeA,claudeB,codexA,codexB],[first])
  assert.equal(next.preset,codexA);assert.deepEqual(next.skipped.map(s=>[s.preset.id,s.outcome,s.category]),[['claude-b','skipped','same-quota-scope']])
  // A limit reached after work began exhausts the same scope.
  assert.deepEqual(nextSetup([claudeA,claudeB,codexA],[{...first,category:'quota-after-work-began'}]).skipped.map(s=>s.category),['same-quota-scope'])
  // A non-quota rejection (model unavailable) leaves the scope eligible.
  assert.equal(nextSetup([claudeA,claudeB],[{...first,category:'provider-rejected'}]).preset,claudeB)
})

test('same-settings login choices rotate from the last success, preserving explicit model fallback priority',()=>{
  const a={...claudeA,effort:'xhigh'},b={...a,id:'b',authProfile:'claude2'},c={...a,id:'c',authProfile:'claude3'}
  const execution={sessionId:'00000000-0000-4000-8000-000000000000',preset:a,fallbacks:[b,c,codexA]}
  const health={'claude@claude2':{lastSuccessAt:'2026-01-01T00:00:00.000Z'}}
  assert.deepEqual(setupCandidates(execution,health).map(p=>p.id),['b','c','claude-a','codex-a'])
  assert.deepEqual(setupCandidates({...execution,fallbacks:[codexA,b]},health).map(p=>p.id),['claude-a','codex-a','b'])
  const now=Date.parse('2026-01-01T01:00:00.000Z'), resetAt='2026-01-01T02:00:00.000Z'
  const cooling={claude:{resetAt},'claude@claude2':{...health['claude@claude2'],resetAt}}
  const next=nextSetup([a,b,c],[],cooling,now)
  assert.equal(next.preset,c)
  assert.deepEqual(next.skipped.map(s=>[s.quotaScope,s.category,s.resetAt]),[['claude','same-quota-scope',resetAt],['claude@claude2','same-quota-scope',resetAt]])
  assert.equal(nextSetup([a,b,c],[],cooling,Date.parse(resetAt)).preset,a,'the native reset expires the cooldown')
  assert.equal(nextSetup([b,c,a],[{preset:b,quotaScope:'claude@claude2',outcome:'failed',category:'quota'}]).preset,c,'rotation never retries an attempted login')
})

type Script={lines?:unknown[];stderr?:string;code?:number;unavailable?:boolean;hold?:boolean;session?:string;stage?:string}
const fixture=async(name:string,scripts:Script[],fallbacks=[claudeB,codexA,codexB],primary=claudeA,options:{telemetry?:boolean}={})=>{
  const dir=await mkdtemp(join(tmpdir(),`ez-fallback-${name}-`)),control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
  const launches:ExecutorOptions[]=[],prompts:string[][]=[],admitted:(AiPreset|undefined)[]=[],sent:string[]=[]
  const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(texts,options)=>{
    const script=scripts[launches.length] ?? {code:0}
    launches.push(options);prompts.push(texts);admitted.push(activeSetup((await runs.get(options.runId))!))
    if(script.unavailable)throw new CliUnavailableError(`Native CLI ${options.cli} is not executable on the host PATH`)
    if(script.stage){const s=await scheduler.get('daily');await scheduler.edit({...s,text:script.stage},s.revision,()=>runs.list(),true)}
    if (script.session) await options.onSession?.(script.session)
    const out=(script.lines ?? []).map(l=>typeof l==='string'?l:JSON.stringify(l)).join('\n')
    const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(out ? out+'\n' : '')});process.stderr.write(${JSON.stringify(script.stderr ?? '')});setTimeout(()=>process.exit(${script.code ?? 0}),${script.hold ? 60000 : 10})`],{detached:process.platform!=='win32'})
    await once(child,'spawn');return {child,cleanup:async()=>{},stdout:''}
  })
  relay.bot.api.config.use(async(_prev,method,payload)=>{if(method==='sendMessage')sent.push((payload as {text:string}).text);return {ok:true,result:{message_id:42}} as never})
  await control.requestPairing(101,101);await control.approveOwner(101)
  if(options.telemetry)await control.setRunTelemetry(true)
  const owner=(await control.status()).owner!
  const saved=await scheduler.save({id:'daily',name:'Daily',text:'Saved work',owner,execution:{sessionId:'00000000-0000-4000-8000-000000000000',preset:primary,...(fallbacks.length ? {fallbacks} : {})},enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}},true)
  const run=await scheduler.trigger(saved.id,saved.revision,'fallback-'+name,owner,runs)
  await relay.drainSources()
  return {dir,owner,runs,scheduler,relay,run,launches,prompts,admitted,sent,done:async()=>{await until(async()=>['completed','failed','cancelled'].includes((await runs.get(run.id))!.status));return (await runs.get(run.id))!},
    close:async()=>{await relay.stop();await rm(dir,{recursive:true,force:true})}}
}
const quota={type:'assistant',error:'rate_limit'},work={type:'assistant',message:{content:[{type:'text',text:'working'}]}}

test('scheduled rotation reaches saved Codex after quota and typed authentication failures',async()=>{
  const third={...claudeA,id:'third',authProfile:'claude3'}
  const fourth={...claudeA,id:'fourth',authProfile:'claude4'}
  const terminal={type:'result',subtype:'success',is_error:true,stop_reason:'stop_sequence'}
  const auth={type:'assistant',error:'authentication_failed',isApiErrorMessage:true}
  const f=await fixture('quota-auth-rotation',[
    {lines:[quota,terminal],code:1},
    {lines:[auth,terminal],code:1},
    {lines:[startupLine({workBegan:true})],code:0},
  ],[fourth,codexA],third)
  try{
    const run=await f.done()
    assert.equal(run.status,'completed')
    assert.deepEqual(run.attempts!.map(a=>[a.quotaScope,a.category,a.outcome]),[
      ['claude@claude3','quota','failed'],['claude@claude4','login-unavailable','failed'],['codex',undefined,'completed'],
    ])
    assert.equal(f.launches.length,3)
    const saved=await f.scheduler.get('daily')
    assert.equal((await f.scheduler.trigger(saved.id,saved.revision,'fallback-quota-auth-rotation',f.owner,f.runs)).id,run.id)
    await f.relay.drainSources()
    assert.equal(f.launches.length,3,'reconciling the same occurrence never dispatches again')
  }finally{await f.close()}
})

test('typed native terminal error with exit zero fails without replay',async()=>{
  const f=await fixture('terminal-error-zero',[{lines:[work,{type:'result',subtype:'error_during_execution',is_error:true,stop_reason:null}],code:0}])
  try{
    const run=await f.done()
    assert.equal(run.status,'failed')
    assert.equal(f.launches.length,1)
    assert.equal(run.attempts![0].outcome,'failed')
    assert.equal(run.attempts![0].category,'after-work-began')
    assert.deepEqual(run.attempts![0].nativeTerminal,{status:'failed',subtype:'error_during_execution',isError:true,stopReason:null})
    assert.equal(run.failureReason,'native-terminal-outcome')
    const saved=await f.scheduler.get('daily')
    assert.equal((await f.scheduler.trigger(saved.id,saved.revision,'fallback-terminal-error-zero',f.owner,f.runs)).id,run.id)
    await f.relay.drainSources()
    assert.equal(f.launches.length,1,'same occurrence identity cannot replay partial work')
  }finally{await f.close()}
})

test('native success including no-op completes; incomplete and conflicting terminal fields stop',async()=>{
  for(const [name,result,expected] of [
    ['noop',{subtype:'success',is_error:false,stop_reason:'end_turn'},'completed'],
    ['truncated',{subtype:'success',is_error:false,stop_reason:'max_tokens'},'failed'],
    ['max-turns',{subtype:'error_max_turns',is_error:false},'failed'],
    ['unknown',{subtype:'new-native-subtype',is_error:false},'failed'],
    ['conflicting',{subtype:'success',is_error:true},'failed'],
  ] as const){
    const f=await fixture('terminal-'+name,[{lines:[{type:'result',...result,result:'private model prose',errors:['private provider prose']}],code:0}])
    try{
      const run=await f.done()
      assert.equal(run.status,expected,name);assert.equal(f.launches.length,1,name)
      assert.doesNotMatch(JSON.stringify(run.attempts),/private|new-native-subtype/)
    }finally{await f.close()}
  }
  for(const result of [{subtype:'success',is_error:false},{subtype:'error_max_turns',is_error:true},{subtype:'unknown',is_error:true}])
    assert.equal(observe(work,quota,{type:'result',...result}).rejection,undefined)
  const o=startupObserver()
  const json=JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,stop_reason:'private-secret-code',result:'private text'})
  o.write(json.slice(0,10));o.write(json.slice(10))
  const nativeTerminal=o.result().nativeTerminal
  assert.deepEqual(nativeTerminal,{status:'failed',subtype:'error_during_execution',isError:true,stopReason:'unknown'})
  assert.deepEqual(observe(startupLine({workBegan:true,nativeTerminal})).nativeTerminal,nativeTerminal)
  assert.doesNotMatch(o.summary(),/private/)
})

test('transport interruption overrides native success and exit zero without replay',async()=>{
  const f=await fixture('terminal-interrupted',[{lines:[{type:'result',subtype:'success',is_error:false}],stderr:'Host executor client interrupted by transport loss',code:0}])
  try{
    const run=await f.done()
    assert.equal(run.status,'failed');assert.equal(run.interrupted,true)
    assert.equal(run.failureReason,'host-executor-transport-interrupted')
    assert.equal(f.launches.length,1)
  }finally{await f.close()}
})

test('a quota rejection before work advances within the same occurrence, skipping the exhausted scope',async()=>{
  const f=await fixture('advance',[{lines:[{type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1791460800}},quota],code:1},{lines:[startupLine({workBegan:true})],code:0}])
  try{
    const run=await f.done()
    assert.equal(run.status,'completed');assert.equal(run.id,f.run.id)
    assert.deepEqual(f.launches.map(l=>[l.cli,l.model,l.runId,l.nativeSession]),[['claude','opus',f.run.id,true],['codex','gpt-6-sol',f.run.id,true]])
    assert.notEqual(f.launches[0].sessionId,f.launches[1].sessionId)
    assert.deepEqual(f.admitted.map(p=>p?.id),['claude-a','codex-a'])
    assert.deepEqual(run.attempts!.map(a=>[a.preset.id,a.outcome,a.category,a.resetAt]),[
      ['claude-a','failed','quota','2026-10-08T12:00:00.000Z'],['claude-b','skipped','same-quota-scope',undefined],['codex-a','completed',undefined,undefined]])
    assert.equal((await f.runs.list()).filter(r=>r.scheduled?.id==='daily').length,1)
  }finally{await f.close()}
})

test('non-quota failure after work began, access denial and unknown failures stop without replay',async()=>{
  for(const [name,lines,category] of [['partial',[work,{type:'assistant',error:'overloaded'}],'after-work-began'],['recovered',[work,limitEvent,quota,work],'after-work-began'],
    ['denied',[{type:'assistant',error:'oauth_org_not_allowed'},quota],'access-denied'],['denied-after-work',[work,{type:'assistant',error:'oauth_org_not_allowed'},quota],'after-work-began'],['silent',[],'uncertain']] as const){
    const f=await fixture(name,[{lines:[...lines],code:1}])
    try{
      const run=await f.done()
      assert.equal(run.status,'failed',name);assert.equal(f.launches.length,1,name)
      assert.deepEqual(run.attempts!.map(a=>[a.preset.id,a.outcome,a.category]),[['claude-a','failed',category]],name)
    }finally{await f.close()}
  }
})

const revoked={type:'system',subtype:'api_error',error:{status:401,message:'OAuth access token has been revoked.'}}
const retry={type:'system',subtype:'api_retry',error_status:401,error:'authentication_failed',attempt:1,max_retries:10,retry_delay_ms:624}

test('revoked-login metadata followed by a quota rejection does not mark work as started',()=>{
  assert.deepEqual(observe({type:'system',subtype:'init'},revoked,retry,
    {type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1791475200}},
    {...quota,isApiErrorMessage:true,message:{model:'<synthetic>',content:[{type:'text',text:'session limit'}],usage:{input_tokens:0,output_tokens:0}}}),
    {workBegan:false,rejection:{category:'quota',resetAt:'2026-10-08T16:00:00.000Z'}})
  assert.deepEqual(observe(revoked),{workBegan:false,rejection:{category:'login-unavailable'}})
  assert.deepEqual(observe(retry),{workBegan:false,rejection:{category:'login-unavailable'}})
  assert.equal(observe(work,revoked).workBegan,true)
  assert.equal(observe(work,retry).workBegan,true)
  assert.equal(observe({type:'system',subtype:'api_error',error:{status:403}},quota).rejection?.category,'access-denied')
  assert.equal(observe({type:'system',subtype:'api_error',error:{status:null}},quota).workBegan,true)
  assert.equal(observe({...retry,error_status:null},quota).workBegan,true)
})

test('unavailable login advances to a saved account and the next occurrence uses the unchanged chain',async()=>{
  const profiles=['claude2','claude3','claude4']
  const fallbacks=[claudeB,...profiles.map((authProfile,i)=>({...claudeA,id:`profile-${i}`,authProfile,effort:'high'}))]
  const f=await fixture('login-recovery',[{lines:[revoked,retry],code:1},{lines:[work],code:0},
    {lines:[{type:'assistant',error:'authentication_failed'}],code:1},{lines:[work],code:0}],fallbacks,{...claudeA,effort:'high'})
  try{
    const first=await f.done()
    assert.equal(first.status,'completed')
    assert.deepEqual(first.attempts!.map(a=>[a.quotaScope,a.category]),[
      ['claude','login-unavailable'],['claude','same-login-scope'],['claude@claude2',undefined]])
    const saved=await f.scheduler.get('daily')
    assert.deepEqual(saved!.execution!.fallbacks,fallbacks)
    const second=await f.scheduler.trigger(saved!.id,saved!.revision,'next-occurrence',saved!.owner,f.runs)
    await f.relay.drainSources()
    await until(async()=>['completed','failed'].includes((await f.runs.get(second.id))!.status))
    assert.equal((await f.runs.get(second.id))!.status,'completed')
    assert.notEqual(first.id,second.id)
    assert.deepEqual(f.launches.map(l=>[l.authProfile,l.model,l.effort]),[
      [undefined,'opus','high'],['claude2','opus','high'],[undefined,'opus','high'],['claude2','opus','high']])
    assert.equal(new Set(f.launches.map(l=>l.sessionId)).size,4)
  }finally{await f.close()}
})

test('each scheduled attempt launches with its own captured auth profile',async()=>{
  const primary={...claudeA,authProfile:'work'}
  const f=await fixture('profile',[{lines:[{type:'assistant',error:'model_not_found'}],code:1},{lines:[work],code:0}],[claudeB],primary)
  try{
    assert.equal((await f.done()).status,'completed')
    assert.deepEqual(f.launches.map(l=>[l.cli,l.model,l.authProfile]),[['claude','opus','work'],['claude','sonnet',undefined]])
  }finally{await f.close()}
})

test('four Claude accounts advance in order on quota rejection before work',async()=>{
  const profiles=['claude2','claude3','claude4']
  const fallbacks=profiles.map((authProfile,i)=>({...claudeA,id:`fallback-${i}`,authProfile,effort:'high'}))
  const f=await fixture('four-accounts',[{lines:[quota],code:1},{lines:[quota],code:1},{lines:[quota],code:1},{lines:[work],code:0}],fallbacks,{...claudeA,effort:'high'})
  try{
    const run=await f.done()
    assert.equal(run.status,'completed')
    assert.deepEqual(f.launches.map(l=>[l.cli,l.authProfile,l.model,l.effort]),
      [undefined,...profiles].map(profile=>['claude',profile,'opus','high']))
    assert.equal(new Set(f.launches.map(l=>l.sessionId)).size,4)
    assert.ok(f.launches.every(l=>l.runId===run.id))
    assert.deepEqual(run.attempts!.map(a=>[a.quotaScope,a.outcome]),[
      ['claude','failed'],['claude@claude2','failed'],['claude@claude3','failed'],['claude@claude4','completed']])
  }finally{await f.close()}
})

test('the five-setup chain (four Claude logins, then Codex) recovers on its fifth setup once, and evidence lists every attempt',async()=>{
  const profiles=['claude2','claude3','claude4']
  const claudes=profiles.map((authProfile,i)=>({...claudeA,id:`fallback-${i}`,authProfile,effort:'high'}))
  const f=await fixture('five-setups',[{lines:[quota],code:1},{lines:[quota],code:1},{lines:[quota],code:1},{lines:[quota],code:1},{lines:[work],code:0}],
    [...claudes,{...codexA,effort:'xhigh'}],{...claudeA,effort:'high'},{telemetry:true})
  try{
    const run=await f.done()
    assert.equal(run.status,'completed')
    assert.deepEqual(f.launches.map(l=>[l.cli,l.authProfile,l.model,l.effort]),[
      ['claude',undefined,'opus','high'],['claude','claude2','opus','high'],['claude','claude3','opus','high'],['claude','claude4','opus','high'],['codex',undefined,'gpt-6-sol','xhigh']])
    assert.equal(new Set(f.launches.map(l=>l.sessionId)).size,5)
    assert.ok(f.launches.every(l=>l.runId===run.id),'one occurrence, never a second run')
    const evidence=(await runEvidence(f.dir)).runs.find(r=>r.id===run.id)!
    assert.deepEqual(evidence.attempts.map(a=>[a.attempt,a.setup.cli,a.setup.authProfile,a.outcome,a.category]),[
      [1,'claude',undefined,'failed','quota'],[2,'claude','claude2','failed','quota'],[3,'claude','claude3','failed','quota'],
      [4,'claude','claude4','failed','quota'],[5,'codex',undefined,'completed',undefined]])
    assert.deepEqual(evidence.attempts.slice(0,4).map(a=>a.telemetry?.errors),Array(4).fill(['rate_limit']))
    assert.ok(evidence.attempts.every(a=>a.telemetry!==undefined&&a.startedAt&&a.endedAt),'every attempt carries its clocks and telemetry')
    const saved=await f.scheduler.get('daily')
    assert.equal((await f.scheduler.trigger(saved.id,saved.revision,'fallback-five-setups',f.owner,f.runs)).id,run.id)
    await f.relay.drainSources()
    assert.equal(f.launches.length,5,'the same occurrence key never launches a setup twice')
  }finally{await f.close()}
})

test('later tasks reuse the last working login and retain quota resets in owner control state',async()=>{
  const primary={...claudeA,effort:'xhigh'},profiles=['claude2','claude3'].map((authProfile,i)=>({...primary,id:`fallback-${i}`,authProfile}))
  const resetAt=new Date(Date.now()+3600_000).toISOString(),limit={type:'ez.startup',workBegan:false,rejection:{category:'quota',resetAt}}
  const f=await fixture('sticky-login',[{lines:[limit],code:1},{lines:[work],code:0},{lines:[limit],code:1},{lines:[work],code:0},{lines:[work],code:0}],profiles,primary)
  try{
    await f.done()
    const control=new ControlStore(f.dir,1000),owner=(await control.status()).owner!
    assert.equal((await control.scheduledSetupHealth(owner)).claude.resetAt,resetAt)
    for(const id of ['second','third']){
      const saved=await f.scheduler.save({id,name:id,text:'Another saved task',owner,execution:{sessionId:'00000000-0000-4000-8000-000000000000',preset:primary,fallbacks:profiles},enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}},true)
      const run=await f.scheduler.trigger(id,saved.revision,id,owner,f.runs)
      await f.relay.drainSources()
      await until(async()=>(await f.runs.get(run.id))?.status==='completed')
    }
    assert.deepEqual(f.launches.map(l=>l.authProfile),[undefined,'claude2','claude2','claude3','claude3'])
    assert.ok(f.launches.every(l=>l.model==='opus'&&l.effort==='xhigh'))
    const persisted=await new ControlStore(f.dir,1000).scheduledSetupHealth(owner)
    assert.equal(persisted.claude.resetAt,resetAt)
    assert.equal(persisted['claude@claude2'].resetAt,resetAt)
    assert.ok(persisted['claude@claude3'].lastSuccessAt)
  }finally{await f.close()}
})

test('arbitrary mixed setup lists preserve CLI, provider, model and effort per attempt',async()=>{
  const candidates:AiPreset[]=[claudeA,
    {...codexA,authProfile:'work',effort:'xhigh'},
    {...setup('desktop','codex-gui','gpt-6-sol'),effort:'high'},
    {...setup('open','opencode','anthropic/claude-sonnet'),provider:'anthropic',effort:'high'},
    {...setup('pi','pi','openai/gpt-6-sol'),effort:'medium'},
    {...setup('grok','grok','grok-4'),effort:'low'}]
  const f=await fixture('mixed',candidates.map((_,i)=>i<candidates.length-1?{unavailable:true}:{code:0}),candidates.slice(1),candidates[0])
  try{
    const run=await f.done()
    assert.equal(run.status,'completed')
    assert.deepEqual(f.launches.map(l=>[l.cli,l.authProfile,l.provider,l.model,l.effort]),
      candidates.map(p=>[p.cli,p.authProfile,p.provider,p.model,p.effort]))
    assert.deepEqual(run.attempts!.map(a=>a.preset),candidates)
    assert.equal(new Set(f.launches.map(l=>l.sessionId)).size,candidates.length)
  }finally{await f.close()}
})

test('a usage limit after work began continues the same run on the next login, told so',async()=>{
  const opus={...claudeA,effort:'xhigh'},profiles=['claude2','claude3','claude4'].map((authProfile,i)=>({...opus,id:`fallback-${i}`,authProfile}))
  for(const event of [work,{type:'system',subtype:'hook_started'}])for(const terminal of [
    {type:'result',is_error:true},
    {type:'result',subtype:'success',is_error:true,stop_reason:'stop_sequence'},
  ]){
    // Default login stops mid-run, claude2 is already exhausted before work, claude3 completes.
    const f=await fixture('mid-run-limit',[{lines:[{type:'system',subtype:'init'},event,limitEvent,limitMessage,terminal],code:1},
      {lines:[limitEvent,limitMessage,terminal],code:1},{lines:[work],code:0}],profiles,opus)
    try{
      const run=await f.done()
      assert.equal(run.status,'completed');assert.equal(run.id,f.run.id)
      assert.deepEqual(f.launches.map(l=>[l.authProfile,l.model,l.effort,l.runId]),[[undefined,'opus','xhigh',run.id],['claude2','opus','xhigh',run.id],['claude3','opus','xhigh',run.id]])
      assert.deepEqual(run.attempts!.map(a=>[a.quotaScope,a.outcome,a.category,a.resetAt,a.sessionId]),[
        ['claude','failed','quota-after-work-began',limitReset,f.launches[0].sessionId],
        ['claude@claude2','failed','quota',limitReset,f.launches[1].sessionId],
        ['claude@claude3','completed',undefined,undefined,f.launches[2].sessionId]])
      assert.equal(new Set(f.launches.map(l=>l.sessionId)).size,3)
      // The first launch is the saved prompt; each continuation adds only the transport fact.
      const fact=`[run ${run.id} continues: claude · opus · xhigh began work in native session ${f.launches[0].sessionId} and stopped at its usage limit (resets ${limitReset}). That work may be partly applied.]`
      assert.deepEqual(f.prompts,[f.prompts[0],[...f.prompts[0],fact],[...f.prompts[0],fact]])
      assert.ok(!f.prompts[0].some(text=>text.includes('continues')))
      assert.equal((await f.runs.list()).filter(r=>r.scheduled?.id==='daily').length,1)
      const saved=await f.scheduler.get('daily')
      assert.equal((await f.scheduler.trigger(saved.id,saved.revision,'fallback-mid-run-limit',f.owner,f.runs)).id,run.id)
      await f.relay.drainSources()
      assert.equal(f.launches.length,3,'reconciling the same occurrence never repeats its successful work')
    }finally{await f.close()}
  }
})

test('a run that reaches the limit on every login waits and manually continues the same occurrence',async()=>{
  const f=await fixture('limit-everywhere',[{lines:[work,limitEvent,limitMessage],code:0},{lines:[limitEvent,limitMessage],code:1}],[{...claudeA,authProfile:'claude2'}])
  try{
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    const run=(await f.runs.get(f.run.id))!
    assert.equal(run.status,'queued');assert.equal(run.failure,undefined);assert.equal(f.launches.length,2)
    assert.deepEqual(run.attempts!.map(a=>[a.quotaScope,a.category]),[['claude','quota-after-work-began'],['claude@claude2','quota']])
    await f.relay.drainSources();assert.equal(f.launches.length,2)
    await f.scheduler.retryQuota(f.owner,f.runs,run.id)
    await f.relay.drainSources()
    assert.equal((await f.done()).status,'completed')
    assert.equal(f.launches[2].runId,run.id)
    assert.ok(f.prompts[2].some(p=>p.includes(f.launches[0].sessionId!) && p.includes('partly applied')))
  }finally{await f.close()}
})

test('cancellation stops the chain',async()=>{
  for(const terminal of [
    {type:'result',subtype:'error_during_execution',is_error:true},
    {type:'result',subtype:'success',is_error:true,stop_reason:'stop_sequence'},
  ]){
    const f=await fixture('cancel',[{lines:[quota,terminal],hold:true}])
    try{
      await until(async()=>Boolean((await f.runs.get(f.run.id))?.pid))
      await f.scheduler.cancel(f.run.id)
      await f.relay.drainSources()
      const run=await f.done()
      assert.equal(run.status,'cancelled');assert.equal(f.launches.length,1)
      assert.deepEqual(run.attempts!.map(a=>a.outcome),['cancelled'])
    }finally{await f.close()}
  }
})

test('a staged edit lets the running occurrence continue to its saved fallback on captured settings',async()=>{
  const f=await fixture('staged',[{stage:'Edited work',lines:[quota],code:1},{lines:[startupLine({workBegan:true})],code:0}])
  try{
    const run=await f.done()
    assert.equal(run.status,'completed')
    assert.deepEqual(run.attempts!.map(a=>[a.preset.id,a.outcome]),[['claude-a','failed'],['claude-b','skipped'],['codex-a','completed']])
    assert.ok(f.prompts.every(texts=>texts.includes('Saved work')),'every attempt runs the captured instructions')
    const saved=await f.scheduler.get('daily')
    assert.equal(saved.text,'Edited work');assert.deepEqual(saved.continuingRunIds,[f.run.id])
  }finally{await f.close()}
})

test('when every setup is unavailable the run reports each setup clearly',async()=>{
  const f=await fixture('none',[{unavailable:true},{unavailable:true}],[codexA])
  try{
    const run=await f.done()
    assert.equal(run.status,'failed');assert.equal(run.failureReason,'setups-unavailable')
    assert.deepEqual(run.attempts!.map(a=>[a.preset.id,a.category]),[['claude-a','cli-unavailable'],['codex-a','cli-unavailable']])
    assert.match(run.failure!.error,/Every task setup was unavailable: claude · opus .*\(cli-unavailable\); codex · gpt-6-sol/)
    assert.match(f.sent.join('\n'),/could not start\. Every task setup was unavailable/)
  }finally{await f.close()}
})

test('schedules reject duplicate or invalid setups and the socket cannot rewrite attempts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ez-fallback-validate-')),control=new ControlStore(dir,1000),scheduler=new Scheduler(dir)
  try{
    await control.requestPairing(101,101);await control.approveOwner(101)
    const owner=(await control.status()).owner!,base={id:'t',name:'T',text:'Work',owner,enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}}
    const execution=(fallbacks:AiPreset[])=>({sessionId:'00000000-0000-4000-8000-000000000000',preset:claudeA,fallbacks})
    await assert.rejects(scheduler.save({...base,execution:execution([{...claudeA,id:'copy'}])}),/distinct/)
    await assert.rejects(scheduler.save({...base,execution:execution([{...claudeB,cli:'unknown'}])}),/AI selection/)
    await assert.rejects(scheduler.save({...base,execution:execution([{...codexA,model:undefined}])}),/explicit model/)
    const forged=[{preset:setup('forged','claude','opus-max'),quotaScope:'claude',outcome:'running' as const}]
    assert.equal(activeSetup({execution:execution([claudeB]),attempts:forged}),undefined)
    const {serveTestLedger}=await import('./helpers/ledger.js'),{callDeliverySocket,socketPathFor}=await import('../src/delivery-socket.js')
    const ledger=await serveTestLedger(dir)
    try{
      const run=await new RunStore(dir).create({chatId:101,telegramUserId:101,texts:['x'],execution:execution([claudeB])})
      await assert.rejects(callDeliverySocket(socketPathFor(dir),{op:'patch',payload:{runId:run.id,change:{attempts:forged}}}),/relay-owned/)
      for (const key of ['quotaWait','attemptRound']) await assert.rejects(callDeliverySocket(socketPathFor(dir),{op:'patch',payload:{runId:run.id,change:{[key]:{}}}}),/relay-owned/)
    }finally{await ledger.stop()}
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('host transport admits only the active task setup and profile, forwards only Claude startup summaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ez-fallback-host-')),workspace=join(root,'mind'),controlDir=join(root,'control'),directory=join(controlDir,'host-executor')
  const {mkdir,writeFile,readFile}=await import('node:fs/promises'),{serveHostExecutor}=await import('../src/host-executor.js')
  const abort=new AbortController(),launched:{cli?:string;model?:string;authProfile?:string}[]=[],oldPath=process.env.PATH
  const primary={...claudeA,authProfile:'work'}
  let server:Promise<void>|undefined
  try{
    await mkdir(workspace,{recursive:true});await mkdir(directory,{recursive:true});await mkdir(join(root,'bin'))
    await writeFile(join(root,'bin','claude'),'#!/bin/sh\nexit 0\n',{mode:0o700})
    process.env.PATH=join(root,'bin')+':'+oldPath
    const control=new ControlStore(controlDir,900_000);await control.requestPairing(101,101);await control.approveOwner(101)
    const owner=(await control.status()).owner!,runs=new RunStore(controlDir),id='r_schedule_fallback'
    await runs.create({id,chatId:101,telegramUserId:101,texts:['work'],execution:{sessionId:'00000000-0000-4000-8000-000000000000',preset:primary,fallbacks:[claudeB]},
      scheduled:{id:'daily',revision:'rev',dueAt:new Date().toISOString(),pairedAt:owner.pairedAt}})
    await runs.patch(id,{status:'running',attempts:[{preset:primary,quotaScope:'claude',outcome:'running'}]})
    server=serveHostExecutor({cli:'claude',agents:[{name:'t',workspace,controlDir,binDir:join(root,'bin')}]},abort.signal,async(_texts,options)=>{
      launched.push({cli:options.cli,model:options.model,authProfile:options.authProfile})
      const lines=options.model==='opus'?[JSON.stringify({type:'system',subtype:'init'}),JSON.stringify({...revoked,error:{...revoked.error,message:'secret provider diagnostic'}}),JSON.stringify({...retry,error:'secret provider diagnostic'})].join('\n')+'\n':JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,stop_reason:null,result:'secret provider diagnostic',errors:['secret provider diagnostic']})
      const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(lines)});process.exit(1)`])
      return {child,cleanup:async()=>{},stdout:''}
    },async()=>[{cli:'claude',authProfile:'work',model:'opus',name:'Work',efforts:[]}])
    const events=async()=>{for(let n=0;n<150;n++){try{const text=await readFile(join(directory,id+'.events'),'utf8');if(text.includes('"stream":"exit"'))return text}catch{};await new Promise(r=>setTimeout(r,20))}throw new Error('No exit event')}
    const request=(options:object)=>writeFile(join(directory,id+'.request.json'),JSON.stringify({texts:['work'],options}))
    for(let n=0;n<100 && !await readFile(join(directory,'heartbeat.json')).then(()=>true,()=>false);n++)await new Promise(r=>setTimeout(r,20))
    await request({cli:'claude',model:'opus',authProfile:'work'})
    const first=await events()
    const summaries=first.trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.stream==='stdout').flatMap(e=>e.text.trim().split('\n').map((l:string)=>JSON.parse(l)))
    assert.ok(summaries.every((e:{type:string})=>e.type==='ez.startup'))
    assert.deepEqual(summaries.at(-1),{type:'ez.startup',workBegan:false,rejection:{category:'login-unavailable'}})
    assert.doesNotMatch(first,/secret provider diagnostic/)
    const {rm:remove}=await import('node:fs/promises');await remove(join(directory,id+'.events'))
    // The relay advances: the next attempt reuses the run ID.
    await runs.patch(id,{attempts:[{preset:primary,quotaScope:'claude',outcome:'failed',category:'login-unavailable'},{preset:claudeB,quotaScope:'claude',outcome:'running'}]})
    await request({cli:'claude',model:'sonnet'})
    const terminalEvents=await events()
    assert.match(terminalEvents,/nativeTerminal/)
    assert.doesNotMatch(terminalEvents,/secret provider diagnostic/)
    const last=terminalEvents.trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.stream==='stdout').at(-1)
    assert.deepEqual(JSON.parse(last.text).nativeTerminal,{status:'failed',subtype:'error_during_execution',isError:true,stopReason:null})
    await remove(join(directory,id+'.events'))
    assert.deepEqual(launched.map(l=>[l.cli,l.model,l.authProfile]),[['claude','opus','work'],['claude','sonnet',undefined]])
    await request({cli:'claude',model:'sonnet',authProfile:'work'})
    assert.match(await events(),/auth profile does not match its captured AI selection/)
    await remove(join(directory,id+'.events'))
    // A request for a setup other than the active attempt is refused before launch.
    await request({cli:'claude',model:'opus'})
    assert.match(await events(),/does not match its saved task model/)
    assert.equal(launched.length,2)
  }finally{abort.abort();await server;process.env.PATH=oldPath;await rm(root,{recursive:true,force:true})}
})

test('Codex native session reports typed pre-work rejection and work start',async(t)=>{
  t.mock.method(console,'error',()=>{})
  const {runCodexSession}=await import('../src/codex-session.js')
  for(const worked of [false,true]){
    const program=`const rl=require('readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(method,params)=>send({method,params:{threadId:'th',...params}});
rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;
if(q.method==='initialize' || q.method==='account/rateLimits/read')return send({id:q.id,result:{}});
if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:'th'}}});
if(q.method==='turn/start'){send({id:q.id,result:{turn:{id:'one'}}});event('turn/started',{turn:{id:'one'}});
 event('item/started',{item:{type:'userMessage'}});${worked ? "event('item/started',{item:{type:'agentMessage'}});" : ''}
 send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100,resetsAt:1791460800}}}});
 event('turn/completed',{turn:{id:'one',status:'failed',error:{message:'limit',codexErrorInfo:'usageLimitExceeded'}}})}});setInterval(()=>{},1000);`
    const output:string[]=[]
    const code=await runCodexSession({workspace:'/tmp',controlDir:'/tmp/control',model:'gpt-6-sol',prompt:'work'},{launch:()=>spawn(process.execPath,['-e',program],{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'}),emit:line=>output.push(line)})
    assert.equal(code,1)
    const o=startupObserver();o.write(output.join('\n')+'\n')
    assert.deepEqual(o.result(),{workBegan:worked,rejection:{category:'quota',resetAt:'2026-10-08T12:00:00.000Z'}})
  }
})

test('schedule CLI saves ordered fallbacks, preserves them on edit and clears them explicitly',async t=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url'),{serveTestLedger}=await import('./helpers/ledger.js')
  const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
  const dir=await mkdtemp(join(tmpdir(),'ez-fallback-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
  const control=new ControlStore(dir,1000);await control.requestPairing(101,101);await control.approveOwner(101)
  const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:''}
  const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
  const when=['--at','2027-09-09T09:00:00+04:00','--text','Work']
  const saved=await cli('create','chain','--cli','claude','--model','opus',...when,'--fallback','cli=claude,model=sonnet,effort=medium','--fallback','cli=codex,model=gpt-6-sol')
  assert.deepEqual(saved.execution.fallbacks.map((p:AiPreset)=>[p.cli,p.model,p.effort]),[['claude','sonnet','medium'],['codex','gpt-6-sol',undefined]])
  const kept=await cli('edit','chain','--expected-revision',saved.revision,'--cli','claude','--model','opus',...when)
  assert.deepEqual(kept.execution.fallbacks,saved.execution.fallbacks)
  assert.equal((await cli('edit','chain','--expected-revision',kept.revision,'--cli','claude','--model','opus',...when,'--clear-fallbacks')).execution.fallbacks,undefined)
  await assert.rejects(exec(process.execPath,[bin,'create','bad','--cli','claude','--model','opus',...when,'--fallback','cli=codex'],{env}),/cli=EXECUTOR,model=MODEL/)
  await assert.rejects(exec(process.execPath,[bin,'create','dup','--cli','claude','--model','opus',...when,'--fallback','cli=claude,model=opus'],{env}),/distinct/)
})

test('schedule CLI saves arbitrary profile/model/effort combinations and validates every profile',async t=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url')
  const {mkdir}=await import('node:fs/promises'),{serveTestLedger}=await import('./helpers/ledger.js')
  const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
  const dir=await mkdtemp(join(tmpdir(),'ez-fallback-profiles-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const ledger=await serveTestLedger(dir);t.after(()=>ledger.stop())
  const control=new ControlStore(dir,1000);await control.requestPairing(101,101);await control.approveOwner(101)
  for(const profile of ['claude2','claude3','claude4'])await mkdir(join(dir,'cli','profiles',profile,'claude'),{recursive:true})
  await mkdir(join(dir,'cli','profiles','work','codex'),{recursive:true})
  const env={...process.env,EZ_CONTROL_DIR:dir,EZ_RUN_ID:''}
  const cli=async(...args:string[])=>JSON.parse((await exec(process.execPath,[bin,...args],{env})).stdout)
  const when=['--at','2027-09-09T09:00:00+04:00','--text','Work']
  const tuples=[
    ['claude','claude2',undefined,'opus','high'],['claude','claude3',undefined,'sonnet','medium'],
    ['claude','claude4',undefined,'opus','xhigh'],['codex','work',undefined,'gpt-6-sol','xhigh'],
    ['codex-gui',undefined,undefined,'gpt-6-astra','high'],['opencode',undefined,'anthropic','anthropic/claude-sonnet','high'],
    ['pi',undefined,undefined,'openai/gpt-6-sol','medium'],['grok',undefined,undefined,'grok-4','low']]
  const flags=tuples.flatMap(([cli,profile,provider,model,effort])=>['--fallback',
    `cli=${cli},model=${model},effort=${effort}${profile?`,auth-profile=${profile}`:''}${provider?`,provider=${provider}`:''}`])
  const saved=await cli('create','chain','--cli','claude','--model','opus','--effort','high',...when,...flags)
  assert.deepEqual(saved.execution.fallbacks.map((p:AiPreset)=>[p.cli,p.authProfile,p.provider,p.model,p.effort]),tuples)
  assert.deepEqual((await cli('edit','chain','--expected-revision',saved.revision,...when)).execution,saved.execution)
  const base=[bin,'create','bad','--cli','claude','--model','opus',...when,'--fallback']
  for(const [spec,error] of [
    ['cli=claude,model=opus,auth-profile=missing',/not provisioned/],
    ['cli=claude,model=opus,auth-profile=../escape',/Invalid fallback/],
    ['cli=grok,model=grok-4,auth-profile=work',/Invalid fallback/],
    ['cli=claude,model=opus,effort=not valid',/Invalid reasoning effort/],
    ['cli=claude,model=opus,auth-profile=',/Invalid fallback/],
    ['cli=unknown,model=fixture',/Unsupported executor/],
  ] as const)await assert.rejects(exec(process.execPath,[...base,spec],{env}),error)
  await assert.rejects(exec(process.execPath,[...base,'cli=claude,model=opus,auth-profile=claude2','--fallback','cli=claude,model=opus,auth-profile=claude2'],{env}),/distinct/)
})


test('a single saved Codex setup waits for its reported reset and completes without duplicating the occurrence',async()=>{
  const resetAt=new Date(Date.now()+900).toISOString()
  const f=await fixture('timed-wake',[{lines:[startupLine({workBegan:false,rejection:{category:'quota',resetAt}})],code:1},{lines:[startupLine({workBegan:true})],code:0}],[],codexA)
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    assert.equal((await f.runs.get(f.run.id))!.quotaWait!.retryAt,resetAt)
    await f.relay.drainSources();assert.equal(f.launches.length,1)
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(resetAt)-Date.now()+10)))
    await f.relay.drainSources()
    assert.equal((await f.done()).status,'completed')
    assert.equal(f.launches.length,2)
    assert.equal((await f.runs.list()).filter(r=>r.scheduled?.id==='daily').length,1)
    assert.equal((await f.runs.get(f.run.id))!.attempts!.length,2)
  } finally { await f.close() }
})

test('credits-required waits for explicit retry; the owner Telegram command wakes it without inference',async()=>{
  const event={type:'rate_limit_event',rate_limit_info:{status:'rejected',errorCode:'credits_required'}}
  assert.equal(observe(event,quota).rejection!.category,'credits-required')
  const f=await fixture('credits',[{lines:[event,quota],code:1},{lines:[work],code:0}],[])
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    assert.deepEqual((await f.runs.get(f.run.id))!.quotaWait,{})
    assert.equal((await new ControlStore(f.dir,1000).scheduledSetupHealth(f.owner)).claude.manualRetry,true)
    await f.relay.drainSources();assert.equal(f.launches.length,1)
    f.relay.bot.botInfo={id:9,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof f.relay.bot.botInfo
    await f.relay.bot.handleUpdate({update_id:700,message:{message_id:700,date:0,text:'/retry_quota',from:{id:101,is_bot:false,first_name:'Owner'},chat:{id:101,type:'private',first_name:'Owner'}}})
    await f.relay.drainSources()
    assert.equal((await f.done()).status,'completed')
    assert.ok(f.sent.some(text=>text.includes('Quota retry queued')))
  } finally { await f.close() }
})

test('waiting tasks share one login probe and leave the execution slot available',async()=>{
  const f=await fixture('shared-probe',[{lines:[quota],code:1},{hold:true}],[])
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    const first=await f.scheduler.get('daily')
    const second=await f.scheduler.save({...first,id:'second'})
    const run=await f.scheduler.trigger(second.id,second.revision,'second',f.owner,f.runs)
    await f.relay.drainSources()
    assert.equal((await f.runs.get(run.id))!.status,'queued')
    assert.equal(f.launches.length,1)
    await f.scheduler.retryQuota(f.owner,f.runs)
    await f.relay.drainSources()
    assert.equal(f.launches.length,2,'one probe for both queued tasks')
    assert.equal((await f.runs.get(run.id))!.status,'queued')
    const third=await f.scheduler.save({...first,id:'third',execution:{...first.execution!,preset:codexA}})
    await f.scheduler.trigger(third.id,third.revision,'third',f.owner,f.runs)
    await f.relay.drainSources()
    assert.equal(f.launches.length,3,'another login can use the released slot')
  } finally { await f.close() }
})

test('manual quota retry rejects cancelled, edited, foreign and non-quota runs',async()=>{
  const f=await fixture('retry-authority',[{lines:[quota],code:1}],[])
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    await assert.rejects(f.scheduler.retryQuota({...f.owner,generation:'00000000-0000-4000-8000-000000000000'},f.runs,f.run.id),/not a current/)
    await f.runs.patch(f.run.id,{status:'failed',quotaWait:undefined,failureReason:'executor-exit'})
    await assert.rejects(f.scheduler.retryQuota(f.owner,f.runs,f.run.id),/not a current/)
    await f.runs.patch(f.run.id,{status:'queued',quotaWait:{}})
    await f.scheduler.cancel(f.run.id)
    await assert.rejects(f.scheduler.retryQuota(f.owner,f.runs,f.run.id),/not a current/)
    const saved=await f.scheduler.get('daily')
    await f.scheduler.save({...saved,text:'Edited work'})
    await assert.rejects(f.scheduler.retryQuota(f.owner,f.runs,f.run.id),/not a current/)
    assert.ok((await new ControlStore(f.dir,1000).scheduledSetupHealth(f.owner)).claude.retryAt)
  } finally { await f.close() }
})


test('installed schedule retry command revives only a typed prior quota failure, retaining run identity',async()=>{
  const f=await fixture('cli-retry',[{lines:[quota],code:1},{lines:[work],code:0}],[])
  const {serveTestLedger}=await import('./helpers/ledger.js')
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url')
  const exec=promisify(execFile),bin=fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs',import.meta.url))
  let ledger:Awaited<ReturnType<typeof serveTestLedger>>|undefined
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    await f.runs.patch(f.run.id,{status:'failed',quotaWait:undefined,failureReason:'setups-unavailable',endedAt:new Date().toISOString()})
    ledger=await serveTestLedger(f.dir)
    const result=JSON.parse((await exec(process.execPath,[bin,'retry',f.run.id],{env:{...process.env,EZ_CONTROL_DIR:f.dir,EZ_RUN_ID:''}})).stdout)
    assert.deepEqual(result.runIds,[f.run.id]);assert.deepEqual(result.scopes,['claude'])
    await f.relay.drainSources()
    const run=await f.done();assert.equal(run.status,'completed');assert.equal(run.failure,undefined)
    assert.equal(run.attempts!.length,2)
    assert.equal((await f.runs.list()).filter(r=>r.scheduled?.id==='daily').length,1)
  } finally { await ledger?.stop();await f.close() }
})


test('Codex quota continuation retains the actual stopped native thread, not the assigned transport ID',async()=>{
  const native='019a0000-0000-7000-8000-000000000001'
  const f=await fixture('native-reference',[{session:native,lines:[startupLine({workBegan:true,rejection:{category:'quota'}})],code:1},{session:'019a0000-0000-7000-8000-000000000002',lines:[startupLine({workBegan:true})]}],[],codexA)
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    assert.notEqual(f.launches[0].sessionId,native)
    assert.equal((await f.runs.get(f.run.id))!.attempts![0].sessionId,native)
    await f.scheduler.retryQuota(f.owner,f.runs,f.run.id);await f.relay.drainSources()
    const ended=await f.done()
    assert.equal(ended.attempts![0].sessionId,native)
    assert.ok(f.prompts[1].some(line=>line.includes(native) && line.includes('partly applied')))
    assert.ok(!f.prompts[1].some(line=>line.includes(f.launches[0].sessionId!)))
  } finally { await f.close() }
})

test('socket quota retry shares the admission lock with timed scheduler starts',async t=>{
  const f=await fixture('retry-start-race',[{lines:[quota],code:1},{hold:true}],[])
  const {callDeliverySocket,socketPathFor,deliverySocketAlive}=await import('../src/delivery-socket.js')
  let running:Promise<void>|undefined
  let release!:()=>void,entered!:()=>void
  const blocked=new Promise<void>(resolve=>{release=resolve}),atClear=new Promise<void>(resolve=>{entered=resolve})
  const clear=ControlStore.prototype.clearQuotaWait
  try {
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.quotaWait))
    f.relay.bot.botInfo={id:9,is_bot:true,first_name:'Fixture',username:'fixture_bot'} as typeof f.relay.bot.botInfo
    t.mock.method(f.relay.bot,'start',async()=>{})
    running=f.relay.start()
    await until(async()=>deliverySocketAlive(socketPathFor(f.dir)))
    t.mock.method(ControlStore.prototype,'clearQuotaWait',async function(this:ControlStore,owner:Parameters<typeof clear>[0],scopes:string[]) {
      await clear.call(this,owner,scopes)
      entered();await blocked
    })
    const retry=callDeliverySocket(socketPathFor(f.dir),{op:'retryScheduleQuota',payload:{runId:f.run.id}})
    await atClear
    const dispatch=f.relay.drainSources()
    await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal(f.launches.length,1,'the timed start waits while retry changes admission')
    release();await retry;await dispatch
    assert.equal(f.launches.length,2)
    assert.equal((await f.runs.get(f.run.id))!.status,'running')
    await f.relay.drainSources();assert.equal(f.launches.length,2,'no duplicate native child')
  } finally { release();await f.close();await running }
})
