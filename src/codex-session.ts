import { executionDefaults } from './model-policy.js'
import { redactFailure } from './failure.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { terminateJob, validateCodexProvider, type CodexProviderBinding } from './executor.js'
import { codexRejection, codexResetAt, startupLine } from './setup-fallback.js'
import { telemetryObserver } from './run-telemetry.js'

type Options = {workspace:string;controlDir:string;toolsHome?:string;sharedWorkspace?:string;additionalWorkspaces?:string[];model?:string;effort?:string;prompt:string;codexSandbox?:'external';codexProvider?:CodexProviderBinding;telemetry?:boolean;sessionId?:string;isResume?:boolean;codexAutoCompactTokens?:number;codexCommand?:string;nativeSession?:boolean}
type Message = {id?:number;method?:string;params?:any;result?:any;error?:{message:string;code?:number}}

// Keep Codex's native session alive. Codex itself starts goal continuation turns;
// this transport never generates a continuation prompt or an Ez goal record.
// Owner input that arrives mid-turn steers the active native turn (`steerable`).
export async function runCodexSession(options:Options, io:{launch?:()=>ChildProcess;emit?:(line:string)=>void;steerable?:(steer:(text:string)=>Promise<boolean>)=>void}={}):Promise<number> {
  options = executionDefaults('codex', options)
  if (options.codexSandbox !== undefined && options.codexSandbox !== 'external') throw new Error('Invalid Codex sandbox selection')
  const provider = options.codexProvider ? validateCodexProvider(options.codexProvider) : undefined
  const child=io.launch?.() ?? spawn(options.codexCommand ?? 'codex',['app-server','--stdio','--disable','memories','--enable','skip_host_skill_discovery'],{cwd:options.workspace,env:process.env,stdio:['pipe','pipe','pipe']})
  const emit=io.emit ?? (line=>process.stdout.write(line+'\n'))
  let id=0,threadId:string|undefined,activeTurn:string|undefined,finished=false,sawTurn=false,hadGoal=false,workBegan=false,resetAt:string|undefined
  // Owner-enabled telemetry: app-server items and usage in the exec event shape.
  const telemetry=options.telemetry ? telemetryObserver() : undefined
  let reported=''
  const observe=(event?:object)=>{
    if(!telemetry)return
    if(event)telemetry.write(JSON.stringify(event)+'\n')
    const line=telemetry.summary();if(line!==reported){reported=line;emit(line)}
  }
  const tools:Record<string,string>={commandExecution:'command_execution',fileChange:'file_change',webSearch:'web_search',mcpToolCall:'mcp_tool_call'}
  let resolveDone!:(code:number)=>void
  const done=new Promise<number>(resolve=>{resolveDone=resolve})
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  const finish=(code:number)=>{if(!finished){finished=true;resolveDone(code)}}
  const fail=(error:unknown)=>{console.error('Codex native session failed:',error instanceof Error?error.message:String(error));finish(1)}
  const send=(message:Message)=>child.stdin!.write(JSON.stringify(message)+'\n')
  const request=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{
    const next=++id
    const timer=setTimeout(()=>{pending.delete(next);reject(new Error(`Codex request timed out: ${method}`))},30000)
    pending.set(next,{resolve,reject,timer});send({id:next,method,params})
  })
  const settled=(goal:any)=>{
    if(goal)hadGoal=true
    if(activeTurn || goal?.status==='active')return
    if(goal?.status==='usageLimited')emit(startupLine({workBegan,rejection:{category:'quota',...(resetAt?{resetAt}:{})}}))
    if(goal && goal.status!=='complete'){console.error(`Native goal stopped: ${goal.status}`);finish(1);return}
    if(!goal && hadGoal){fail(new Error('Native goal disappeared without verified completion'));return}
    if(!sawTurn)return
    finish(0)
  }
  child.stderr?.pipe(process.stderr)
  child.on('error',error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')emit(startupLine({workBegan:false,rejection:{category:'cli-unavailable'}}))
    fail(error)
  })
  child.stdin?.on('error',fail)
  child.once('close',()=>{
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex app-server closed'))}
    pending.clear();if(!finished)fail(new Error('Codex app-server closed before work completed'))
  })
  const lines=createInterface({input:child.stdout!})
  lines.on('line',line=>{
    let message:Message
    try{message=JSON.parse(line)}catch{fail(new Error('Invalid Codex app-server response'));return}
    if(message.id!==undefined && pending.has(message.id) && !message.method){
      const p=pending.get(message.id)!;pending.delete(message.id);clearTimeout(p.timer)
      if(message.error)p.reject(new Error(message.error.message));else p.resolve(message.result)
      return
    }
    if(message.id!==undefined && message.method){
      // Never turn an unexpected approval/elicitation request into permission.
      send({id:message.id,error:{code:-32601,message:`Unsupported unattended request: ${message.method}`}});fail(new Error(`Codex requires attention: ${message.method}`));return
    }
    if(message.method==='account/rateLimits/updated')resetAt=codexResetAt(message.params?.rateLimits) ?? resetAt
    if(message.params?.threadId!==threadId)return
    if(message.method==='turn/started'){activeTurn=message.params.turn.id;sawTurn=true}
    const item=message.params?.item
    if((message.method==='item/started'||message.method==='item/completed') && tools[item?.type])
      observe({type:message.method==='item/started'?'item.started':'item.completed',item:{id:item.id,type:tools[item.type],server:item.server,tool:item.tool,status:['failed','declined'].includes(item.status)?'failed':'completed'}})
    if(message.method==='thread/tokenUsage/updated'){const total=message.params.tokenUsage?.total
      observe({type:'turn.completed',usage:{input_tokens:total?.inputTokens,cached_input_tokens:total?.cachedInputTokens,output_tokens:total?.outputTokens}})}
    // Any item beyond the echoed input means the provider accepted the turn.
    if(message.method==='item/started' && message.params.item?.type!=='userMessage' && !workBegan){workBegan=true;emit(startupLine({workBegan}))}
    if(message.method==='thread/goal/updated')settled(message.params.goal)
    if(message.method==='thread/goal/cleared')settled(null)
    if(message.method==='turn/completed'){
      if(activeTurn===message.params.turn.id)activeTurn=undefined
      if(message.params.turn.status!=='completed'){
        if(message.params.turn.status==='interrupted')finish(130)
        else {
          observe({type:'turn.failed'})
          const rejected=codexRejection(message.params.turn.error?.codexErrorInfo)
          const category=!workBegan || rejected==='quota' ? rejected : undefined
          if(category)emit(startupLine({workBegan,rejection:{category,...(category==='quota' && resetAt ? {resetAt} : {})}}))
          fail(new Error(redactFailure(typeof message.params.turn.error?.message==='string'
          ? message.params.turn.error.message : 'Native turn failed without error details')))
        }
        return
      }
      // A chat turn ends with its one requested turn, as before; persistent
      // goals belong to scheduled sessions.
      if(!options.nativeSession){finish(0);return}
      // Completion of a turn is not completion of a native goal. The native
      // app-server remains running and owns any automatic next turn.
      void request('thread/goal/get',{threadId}).then(result=>settled(result.goal)).catch(fail)
    }
  })
  io.steerable?.(async text=>{
    if(finished || !threadId || !activeTurn)return false
    return await request('turn/steer',{threadId,expectedTurnId:activeTurn,input:[{type:'text',text}]}).then(()=>true,()=>false)
  })
  try{
    await request('initialize',{clientInfo:{name:'ezenciel-agents',version:'1'},capabilities:{experimentalApi:true}})
    send({method:'initialized',params:{}})
    // Read native quota metadata even when a rejected turn emits no update.
    await request('account/rateLimits/read',{}).then(limits=>{resetAt=codexResetAt(limits.rateLimits)}).catch(()=>{})
    const limit=options.codexAutoCompactTokens
    if(limit!==undefined && (!Number.isSafeInteger(limit) || limit<=0))throw new Error('Invalid Codex compaction token limit')
    // A chat turn resumes its conversation's native thread.
    const resume=options.isResume && options.sessionId
    const result=await request(resume ? 'thread/resume' : 'thread/start',{...(resume ? {threadId:options.sessionId} : {}),
      cwd:options.workspace,approvalPolicy:'never',sandbox:options.codexSandbox === 'external' ? 'danger-full-access' : 'workspace-write',model:options.model,
      config:{project_root_markers:['AGENTS.md','.git'],...(limit!==undefined?{model_auto_compact_token_limit:limit}:{}),'sandbox_workspace_write.writable_roots':[options.controlDir,...(options.toolsHome?[options.toolsHome]:[]),...(options.sharedWorkspace?[options.sharedWorkspace]:[]),...(options.additionalWorkspaces ?? [])],
        'sandbox_workspace_write.network_access':Boolean(options.toolsHome),...(options.effort?{model_reasoning_effort:options.effort}:{}),
        ...(provider?{model_provider:provider.id,[`model_providers.${provider.id}`]:{name:provider.name,base_url:provider.baseUrl,env_key:provider.envKey,wire_api:'responses',supports_websockets:false}}:{})},
    })
    threadId=result.thread?.id
    if(!threadId)throw new Error('Codex did not return a native thread ID')
    telemetry?.model(result.model)
    emit(JSON.stringify({type:'thread.started',thread_id:threadId}))
    await request('turn/start',{threadId,input:[{type:'text',text:options.prompt}],model:options.model,effort:options.effort,
      ...(options.codexSandbox === 'external' ? {sandboxPolicy:{type:'externalSandbox',networkAccess:'enabled'}} : {})})
    return await done
  }catch(error){fail(error);return 1}
  finally{
    finished=true
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex session closed'))}
    pending.clear();lines.close();child.stdin?.end();terminateJob(child)
  }
}

// Stdin: the launch options line, then optional `{"steer":{id,text}}` lines,
// each answered on stdout with `{"type":"ez.steer",id,accepted}`.
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const input=createInterface({input:process.stdin})
  let steer:((text:string)=>Promise<boolean>)|undefined
  const run=new Promise<number>(resolve=>{
    let started=false
    input.on('line',line=>{
      if(!started){started=true;void runCodexSession(JSON.parse(line),{steerable:fn=>{steer=fn}}).then(resolve,()=>resolve(1));return}
      let id:unknown,text:unknown
      try{({id,text}=JSON.parse(line).steer)}catch{return}
      if(typeof text!=='string')return
      void (steer?.(text) ?? Promise.resolve(false)).then(accepted=>process.stdout.write(JSON.stringify({type:'ez.steer',id,accepted})+'\n'))
    })
    input.once('close',()=>{if(!started)resolve(1)})
  })
  process.exitCode=await run
  input.close();process.stdin.destroy()
}
