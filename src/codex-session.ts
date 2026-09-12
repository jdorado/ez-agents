import { executionDefaults } from './model-policy.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { terminateJob } from './executor.js'

type Options = {workspace:string;controlDir:string;toolsHome?:string;sharedWorkspace?:string;model?:string;effort?:string;prompt:string}
type Message = {id?:number;method?:string;params?:any;result?:any;error?:{message:string;code?:number}}

// Keep Codex's native session alive. Codex itself starts goal continuation turns;
// this transport never generates a continuation prompt or an Ez goal record.
export async function runCodexSession(options:Options, io:{launch?:()=>ChildProcess;emit?:(line:string)=>void}={}):Promise<number> {
  options = executionDefaults('codex', options)
  const child=io.launch?.() ?? spawn('codex',['app-server','--stdio','--disable','memories','--enable','skip_host_skill_discovery'],{cwd:options.workspace,env:process.env,stdio:['pipe','pipe','pipe']})
  const emit=io.emit ?? (line=>process.stdout.write(line+'\n'))
  let id=0,threadId:string|undefined,activeTurn:string|undefined,finished=false,sawTurn=false,hadGoal=false
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
    if(goal && goal.status!=='complete'){console.error(`Native goal stopped: ${goal.status}`);finish(1);return}
    if(!goal && hadGoal){fail(new Error('Native goal disappeared without verified completion'));return}
    if(!sawTurn)return
    finish(0)
  }
  child.stderr?.pipe(process.stderr)
  child.on('error',fail)
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
    if(message.params?.threadId!==threadId)return
    if(message.method==='turn/started'){activeTurn=message.params.turn.id;sawTurn=true}
    if(message.method==='thread/goal/updated')settled(message.params.goal)
    if(message.method==='thread/goal/cleared')settled(null)
    if(message.method==='turn/completed'){
      if(activeTurn===message.params.turn.id)activeTurn=undefined
      if(message.params.turn.status!=='completed'){finish(message.params.turn.status==='interrupted'?130:1);return}
      // Completion of a turn is not completion of a native goal. The native
      // app-server remains running and owns any automatic next turn.
      void request('thread/goal/get',{threadId}).then(result=>settled(result.goal)).catch(fail)
    }
  })
  try{
    await request('initialize',{clientInfo:{name:'ezenciel-agents',version:'1'},capabilities:{experimentalApi:true}})
    send({method:'initialized',params:{}})
    const result=await request('thread/start',{
      cwd:options.workspace,approvalPolicy:'never',sandbox:'workspace-write',model:options.model,
      config:{'sandbox_workspace_write.writable_roots':[options.controlDir,...(options.toolsHome?[options.toolsHome]:[]),...(options.sharedWorkspace?[options.sharedWorkspace]:[])],
        'sandbox_workspace_write.network_access':Boolean(options.toolsHome),...(options.effort?{model_reasoning_effort:options.effort}:{})},
    })
    threadId=result.thread?.id
    if(!threadId)throw new Error('Codex did not return a native thread ID')
    emit(JSON.stringify({type:'thread.started',thread_id:threadId}))
    await request('turn/start',{threadId,input:[{type:'text',text:options.prompt}],model:options.model,effort:options.effort})
    return await done
  }catch(error){fail(error);return 1}
  finally{
    finished=true
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex session closed'))}
    pending.clear();lines.close();child.stdin?.end();terminateJob(child)
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let input='';for await(const chunk of process.stdin)input+=chunk
  process.exitCode=await runCodexSession(JSON.parse(input))
}
