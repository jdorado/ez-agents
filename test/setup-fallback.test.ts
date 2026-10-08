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
import { Scheduler } from '../src/scheduler.js'
import { CliUnavailableError, EXECUTOR_REGISTRY, type ExecutorOptions } from '../src/executor.js'
import { codexRejection, nextSetup, quotaScope, startupObserver, startupLine } from '../src/setup-fallback.js'
import type { AiPreset } from '../src/ai.js'

const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,20))}throw new Error('Timed out')}
const setup=(id:string,cli:string,model:string):AiPreset=>({id,name:id,cli,model})
const claudeA=setup('claude-a','claude','opus'),claudeB=setup('claude-b','claude','sonnet')
const codexA=setup('codex-a','codex','gpt-6-sol'),codexB=setup('codex-b','codex','gpt-6-astra')
const observe=(...lines:unknown[])=>{const o=startupObserver();o.write(lines.map(l=>typeof l==='string'?l:JSON.stringify(l)).join('\n')+'\n');return o.result()}

test('startup observer advances only on typed rejection before any work',()=>{
  assert.deepEqual(observe({type:'system',subtype:'init'},{type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:1791460800}},{type:'assistant',error:'rate_limit',message:{content:[]}},{type:'result',is_error:true}),
    {workBegan:false,rejection:{category:'quota',resetAt:'2026-10-08T12:00:00.000Z'}})
  assert.equal(observe({type:'assistant',error:'authentication_failed'}).rejection?.category,'access-denied')
  assert.equal(observe({type:'assistant',error:'model_not_found'}).rejection?.category,'provider-rejected')
  // Real output, unknown errors and unparseable lines all count as work.
  assert.equal(observe({type:'assistant',message:{content:[{type:'tool_use'}]}},{type:'assistant',error:'rate_limit'}).workBegan,true)
  assert.equal(observe({type:'assistant',error:'unknown'}).workBegan,true)
  assert.equal(observe('plain text').workBegan,true)
  // Ez transport summaries (Codex native session, host-forwarded Claude) and session metadata.
  assert.deepEqual(observe({type:'thread.started',thread_id:'t'},startupLine({workBegan:false,rejection:{category:'cli-unavailable'}})),{workBegan:false,rejection:{category:'cli-unavailable'}})
  assert.equal(observe(startupLine({workBegan:true}),startupLine({workBegan:false,rejection:{category:'quota'}})).workBegan,true)
})

test('only scheduled Claude runs stream structured events',()=>{
  assert.deepEqual(EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/w',nativeSession:true},'','').slice(-3),['--output-format','stream-json','--verbose'])
  assert.ok(!EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/w'},'','').includes('stream-json'))
})

test('codex errors map to categories; policy and context errors never advance',()=>{
  assert.equal(codexRejection('usageLimitExceeded'),'quota')
  assert.equal(codexRejection('unauthorized'),'access-denied')
  assert.equal(codexRejection('serverOverloaded'),'provider-rejected')
  assert.equal(codexRejection({responseTooManyFailedAttempts:{httpStatusCode:429}}),'quota')
  assert.equal(codexRejection({httpConnectionFailed:{httpStatusCode:403}}),'access-denied')
  for(const info of ['cyberPolicy','contextWindowExceeded','other',{httpConnectionFailed:{httpStatusCode:null}},undefined]) assert.equal(codexRejection(info),undefined)
})

test('a quota rejection skips later setups in the same scope, even with different credentials',()=>{
  assert.equal(quotaScope(claudeA),quotaScope(claudeB))
  assert.equal(quotaScope({...codexA,provider:'bridge'}),quotaScope(codexB))
  assert.equal(quotaScope({id:'p',name:'p',cli:'pi',model:'opencode-go/m'}),quotaScope({id:'o',name:'o',cli:'opencode',model:'opencode-go/x'}))
  const first={preset:claudeA,quotaScope:'claude',outcome:'failed' as const,category:'quota' as const}
  const next=nextSetup([claudeA,claudeB,codexA,codexB],[first])
  assert.equal(next.preset,codexA);assert.deepEqual(next.skipped.map(s=>[s.preset.id,s.outcome,s.category]),[['claude-b','skipped','same-quota-scope']])
  // A non-quota rejection (model unavailable) leaves the scope eligible.
  assert.equal(nextSetup([claudeA,claudeB],[{...first,category:'provider-rejected'}]).preset,claudeB)
})

type Script={lines?:unknown[];code?:number;unavailable?:boolean;hold?:boolean}
const fixture=async(name:string,scripts:Script[],fallbacks=[claudeB,codexA,codexB])=>{
  const dir=await mkdtemp(join(tmpdir(),`ez-fallback-${name}-`)),control=new ControlStore(dir,1000),runs=new RunStore(dir),scheduler=new Scheduler(dir)
  const launches:ExecutorOptions[]=[],admitted:(AiPreset|undefined)[]=[],sent:string[]=[]
  const relay=createRelay({workspace:dir,controlDir:dir,pairingTtlMs:1000,executorTimeoutMs:0,executorCli:'codex',telegramBotToken:'fixture'},async(_texts,options)=>{
    const script=scripts[launches.length] ?? {code:0}
    launches.push(options);admitted.push(activeSetup((await runs.get(options.runId))!))
    if(script.unavailable)throw new CliUnavailableError(`Native CLI ${options.cli} is not executable on the host PATH`)
    const out=(script.lines ?? []).map(l=>typeof l==='string'?l:JSON.stringify(l)).join('\n')
    const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(out ? out+'\n' : '')});setTimeout(()=>process.exit(${script.code ?? 0}),${script.hold ? 60000 : 10})`],{detached:process.platform!=='win32'})
    await once(child,'spawn');return {child,cleanup:async()=>{},stdout:''}
  })
  relay.bot.api.config.use(async(_prev,method,payload)=>{if(method==='sendMessage')sent.push((payload as {text:string}).text);return {ok:true,result:{message_id:42}} as never})
  await control.requestPairing(101,101);await control.approveOwner(101)
  const owner=(await control.status()).owner!
  const saved=await scheduler.save({id:'daily',name:'Daily',text:'Saved work',owner,execution:{sessionId:'00000000-0000-4000-8000-000000000000',preset:claudeA,fallbacks},enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}},true)
  const run=await scheduler.trigger(saved.id,saved.revision,'fallback-'+name,owner,runs)
  await relay.drainSources()
  return {dir,runs,scheduler,relay,run,launches,admitted,sent,done:async()=>{await until(async()=>['completed','failed','cancelled'].includes((await runs.get(run.id))!.status));return (await runs.get(run.id))!},
    close:async()=>{await relay.stop();await rm(dir,{recursive:true,force:true})}}
}
const quota={type:'assistant',error:'rate_limit'},work={type:'assistant',message:{content:[{type:'text',text:'working'}]}}

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

test('failure after work began, access denial and unknown failures stop without replay',async()=>{
  for(const [name,lines,category] of [['partial',[work,quota],'after-work-began'],['denied',[{type:'assistant',error:'authentication_failed'}],'access-denied'],['silent',[],'uncertain']] as const){
    const f=await fixture(name,[{lines:[...lines],code:1}])
    try{
      const run=await f.done()
      assert.equal(run.status,'failed',name);assert.equal(f.launches.length,1,name)
      assert.deepEqual(run.attempts!.map(a=>[a.preset.id,a.outcome,a.category]),[['claude-a','failed',category]],name)
    }finally{await f.close()}
  }
})

test('cancellation stops the chain',async()=>{
  const f=await fixture('cancel',[{lines:[quota],hold:true}])
  try{
    await until(async()=>Boolean((await f.runs.get(f.run.id))?.pid))
    await f.scheduler.cancel(f.run.id)
    await f.relay.drainSources()
    const run=await f.done()
    assert.equal(run.status,'cancelled');assert.equal(f.launches.length,1)
    assert.deepEqual(run.attempts!.map(a=>a.outcome),['cancelled'])
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

test('schedules reject duplicate or excess setups and the socket cannot rewrite attempts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ez-fallback-validate-')),control=new ControlStore(dir,1000),scheduler=new Scheduler(dir)
  try{
    await control.requestPairing(101,101);await control.approveOwner(101)
    const owner=(await control.status()).owner!,base={id:'t',name:'T',text:'Work',owner,enabled:true,trigger:{at:'2027-01-01T00:00:00Z'}}
    const execution=(fallbacks:AiPreset[])=>({sessionId:'00000000-0000-4000-8000-000000000000',preset:claudeA,fallbacks})
    await assert.rejects(scheduler.save({...base,execution:execution([{...claudeA,id:'copy'}])}),/distinct/)
    await assert.rejects(scheduler.save({...base,execution:execution([claudeB,codexA,codexB,setup('x','codex','other')])}),/AI selection/)
    await assert.rejects(scheduler.save({...base,execution:execution([{...codexA,model:undefined}])}),/explicit model/)
    const forged=[{preset:setup('forged','claude','opus-max'),quotaScope:'claude',outcome:'running' as const}]
    assert.equal(activeSetup({execution:execution([claudeB]),attempts:forged}),undefined)
    const {serveTestLedger}=await import('./helpers/ledger.js'),{callDeliverySocket,socketPathFor}=await import('../src/delivery-socket.js')
    const ledger=await serveTestLedger(dir)
    try{
      const run=await new RunStore(dir).create({chatId:101,telegramUserId:101,texts:['x'],execution:execution([claudeB])})
      await assert.rejects(callDeliverySocket(socketPathFor(dir),{op:'patch',payload:{runId:run.id,change:{attempts:forged}}}),/relay-owned/)
    }finally{await ledger.stop()}
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('host transport admits only the active task setup, forwards only Claude startup summaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ez-fallback-host-')),workspace=join(root,'mind'),controlDir=join(root,'control'),directory=join(controlDir,'host-executor')
  const {mkdir,writeFile,readFile}=await import('node:fs/promises'),{serveHostExecutor}=await import('../src/host-executor.js')
  const abort=new AbortController(),launched:{cli?:string;model?:string}[]=[]
  let server:Promise<void>|undefined
  try{
    await mkdir(workspace,{recursive:true});await mkdir(directory,{recursive:true})
    const control=new ControlStore(controlDir,900_000);await control.requestPairing(101,101);await control.approveOwner(101)
    const owner=(await control.status()).owner!,runs=new RunStore(controlDir),id='r_schedule_fallback'
    await runs.create({id,chatId:101,telegramUserId:101,texts:['work'],execution:{sessionId:'00000000-0000-4000-8000-000000000000',preset:claudeA,fallbacks:[claudeB]},
      scheduled:{id:'daily',revision:'rev',dueAt:new Date().toISOString(),pairedAt:owner.pairedAt}})
    await runs.patch(id,{status:'running',attempts:[{preset:claudeA,quotaScope:'claude',outcome:'running'}]})
    server=serveHostExecutor({cli:'claude',agents:[{name:'t',workspace,controlDir,binDir:join(root,'bin')}]},abort.signal,async(_texts,options)=>{
      launched.push({cli:options.cli,model:options.model})
      const lines=options.model==='opus'?[JSON.stringify({type:'system'}),JSON.stringify({type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:'secret tool output'}]}})].join('\n')+'\n':''
      const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(lines)});process.exit(1)`])
      return {child,cleanup:async()=>{},stdout:''}
    },async()=>[])
    const events=async()=>{for(let n=0;n<150;n++){try{const text=await readFile(join(directory,id+'.events'),'utf8');if(text.includes('"stream":"exit"'))return text}catch{};await new Promise(r=>setTimeout(r,20))}throw new Error('No exit event')}
    const request=(options:object)=>writeFile(join(directory,id+'.request.json'),JSON.stringify({texts:['work'],options}))
    for(let n=0;n<100 && !await readFile(join(directory,'heartbeat.json')).then(()=>true,()=>false);n++)await new Promise(r=>setTimeout(r,20))
    await request({cli:'claude',model:'opus'})
    const first=await events()
    const summaries=first.trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.stream==='stdout').flatMap(e=>e.text.trim().split('\n').map((l:string)=>JSON.parse(l)))
    assert.ok(summaries.every((e:{type:string})=>e.type==='ez.startup'))
    assert.deepEqual(summaries.at(-1),{type:'ez.startup',workBegan:false,rejection:{category:'quota'}})
    assert.doesNotMatch(first,/secret tool output/)
    const {rm:remove}=await import('node:fs/promises');await remove(join(directory,id+'.events'))
    // The relay advances: the next attempt reuses the run ID.
    await runs.patch(id,{attempts:[{preset:claudeA,quotaScope:'claude',outcome:'failed',category:'quota'},{preset:claudeB,quotaScope:'claude',outcome:'running'}]})
    await request({cli:'claude',model:'sonnet'})
    await events();await remove(join(directory,id+'.events'))
    assert.deepEqual(launched.map(l=>[l.cli,l.model]),[['claude','opus'],['claude','sonnet']])
    // A request for a setup other than the active attempt is refused before launch.
    await request({cli:'claude',model:'opus'})
    assert.match(await events(),/does not match its saved task model/)
    assert.equal(launched.length,2)
  }finally{abort.abort();await server;await rm(root,{recursive:true,force:true})}
})

test('Codex native session reports typed pre-work rejection and work start',async(t)=>{
  t.mock.method(console,'error',()=>{})
  const {runCodexSession}=await import('../src/codex-session.js')
  for(const worked of [false,true]){
    const program=`const rl=require('readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(method,params)=>send({method,params:{threadId:'th',...params}});
rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;
if(q.method==='initialize')return send({id:q.id,result:{}});
if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:'th'}}});
if(q.method==='turn/start'){send({id:q.id,result:{turn:{id:'one'}}});event('turn/started',{turn:{id:'one'}});
 event('item/started',{item:{type:'userMessage'}});${worked ? "event('item/started',{item:{type:'agentMessage'}});" : ''}
 send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100,resetsAt:1791460800}}}});
 event('turn/completed',{turn:{id:'one',status:'failed',error:{message:'limit',codexErrorInfo:'usageLimitExceeded'}}})}});setInterval(()=>{},1000);`
    const output:string[]=[]
    const code=await runCodexSession({workspace:'/tmp',controlDir:'/tmp/control',model:'gpt-6-sol',prompt:'work'},{launch:()=>spawn(process.execPath,['-e',program],{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'}),emit:line=>output.push(line)})
    assert.equal(code,1)
    const o=startupObserver();o.write(output.join('\n')+'\n')
    assert.deepEqual(o.result(),worked ? {workBegan:true,rejection:undefined} : {workBegan:false,rejection:{category:'quota',resetAt:'2026-10-08T12:00:00.000Z'}})
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
  assert.deepEqual((await cli('edit','chain','--cli','claude','--model','opus',...when)).execution.fallbacks,saved.execution.fallbacks)
  assert.equal((await cli('edit','chain','--cli','claude','--model','opus',...when,'--clear-fallbacks')).execution.fallbacks,undefined)
  await assert.rejects(exec(process.execPath,[bin,'create','bad','--cli','claude','--model','opus',...when,'--fallback','cli=codex'],{env}),/cli=EXECUTOR,model=MODEL/)
  await assert.rejects(exec(process.execPath,[bin,'create','dup','--cli','claude','--model','opus',...when,'--fallback','cli=claude,model=opus'],{env}),/distinct/)
})
