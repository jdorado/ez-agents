import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import { executorEnvironment } from './executor.js'
import { taskCall } from './task-rpc.js'
import { taskCommandAllowed } from './plugins/exposure.mjs'
import type { TaskCapability } from './tasks.js'
import {attachmentLimit,stageTaskAttachment,type TaskAttachment} from './task-attachments.js'

const execute = promisify(execFile)
const MAX_OUTPUT = 131072

export async function assertChannelQuery(toolsHome: string | undefined, capability: TaskCapability) {
  if (!toolsHome || !path.isAbsolute(toolsHome)) throw new Error('Channel capabilities require an installed tool registry')
  const registry = JSON.parse(await readFile(path.join(toolsHome,'registry.json'),'utf8')) as {
    commands?: Record<string,string>, plugins?: Record<string,{manifest?:{commands?:Record<string,unknown>}}>
  }
  const command = registry.plugins?.[registry.commands?.[capability.command] ?? '']?.manifest?.commands?.[capability.command]
  if (!taskCommandAllowed(command, capability))
    throw new Error(`Capability ${capability.id} is not an installed ${capability.access ? `scoped ${capability.access}` : 'read-only channel query'} command`)
}

type Grant = {lease:string;token?:string}
// Isolated executors have no registry: the broker resolves the lease with the relay.
function brokerCapability(runId: string, input: string, grant: Grant): Promise<{stdout:string;code:number}> {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/ez',import.meta.url)),'--task-capability'],{env:{...executorEnvironment(),EZ_RUN_ID:runId},stdio:['pipe','pipe','pipe']})
    let stdout='';const timer=setTimeout(()=>{child.kill();reject(Error('Channel capability timed out'))},30000)
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>MAX_OUTPUT){child.kill();reject(Error('Channel capability output is too large'))}})
    child.stderr.resume();child.on('error',reject)
    child.on('close',code=>{clearTimeout(timer);resolve({stdout,code:code??1})})
    child.stdin.end(JSON.stringify({lease:grant.lease,input,...(grant.token?{token:grant.token}:{})}))
  })
}

export async function runTaskCapability(toolsHome: string | undefined, capability: TaskCapability, input: string, staging?:{controlDir:string;runId:string;lease:string;token?:string;pluginContext?:unknown}):Promise<{output:string;attachment?:never}|{attachment:TaskAttachment;output?:never}> {
  const isolated = !!process.env.EZ_PLUGIN_BROKER_SOCKET
  if (!isolated) await assertChannelQuery(toolsHome,capability)
  const args = [capability.command, ...capability.args.map(value => value === '{input}' ? input : value)]
  if(capability.output==='file') {
    if(!staging)throw Error('File capability requires task staging')
    if(isolated)throw Error('File capabilities are unavailable to isolated executors')
    const result=await execute(path.join(toolsHome!,'bin','ez'),args,{encoding:'buffer',env:executorEnvironment(),timeout:30000,maxBuffer:attachmentLimit})
    const attachment=await stageTaskAttachment(staging.controlDir,staging.runId,staging.lease,input,result.stdout)
    return {attachment}
  }
  let stdout = '', code = 0
  if (isolated) {
    if (!staging) throw Error('Isolated capabilities require a task lease')
    ;({stdout, code} = await brokerCapability(staging.runId, input, staging))
  } else try {
    // The scope and its token reach only this plugin call, as its EZ_PLUGIN_CONTEXT.
    const context = staging?.pluginContext ? {EZ_TASK_PLUGIN_CONTEXT: JSON.stringify(staging.pluginContext)} : {}
    const result = await execute(path.join(toolsHome!,'bin','ez'),args,{encoding:'utf8',env:{...executorEnvironment(),...context},timeout:15000,maxBuffer:MAX_OUTPUT})
    stdout = result.stdout
  } catch (error) {
    const failure = error as Error & {stdout?:string;code?:number|string}
    stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
    code = typeof failure.code === 'number' ? failure.code : 1
  }
  if (Buffer.byteLength(stdout) > MAX_OUTPUT) throw new Error('Channel capability output is too large')
  if (code !== 0 || !stdout.trim()) throw new Error(`Channel capability failed with exit ${code}`)
  return {output:stdout}
}

// The trusted task broker's one capability path: the relay authorizes a lease
// (and, for scoped grants, mints the token), the plugin runs, the relay records it.
export async function invokeTaskCapability(controlDir: string, runId: string, toolsHome: string | undefined, id: string, input: string | undefined) {
  const begun = await taskCall(controlDir,runId,'worker','capability_begin',{id,...(input === undefined ? {} : {input})}) as {capability:TaskCapability;lease:string;token?:string;pluginContext?:unknown}
  const result = await runTaskCapability(toolsHome,begun.capability,input ?? '',{controlDir,runId,lease:begun.lease,token:begun.token,pluginContext:begun.pluginContext})
  const receipt = result.output === undefined ? {} : {outputSha256:createHash('sha256').update(result.output).digest('hex'),bytes:Buffer.byteLength(result.output)}
  await taskCall(controlDir,runId,'worker','capability_result',{id,...(input === undefined ? {} : {input}),lease:begun.lease,...receipt,...('attachment' in result && result.attachment?{attachment:result.attachment}:{})})
  return result
}

export async function launchTaskApplication(toolsHome: string | undefined, launch:{command:string;args:string[]}, input:unknown, runId:string):Promise<unknown> {
  const isolated=!!process.env.EZ_PLUGIN_BROKER_SOCKET
  if(!isolated && (!toolsHome || !path.isAbsolute(toolsHome)))throw Error('Installed tool registry required')
  const config=!isolated ? JSON.parse(await readFile(path.join(toolsHome!,'config.json'),'utf8')) : undefined
  // Fixed owner-configured command; literal private stdin, never a shell or model-selected args.
  return new Promise((resolve,reject)=>{
    const child=spawn(isolated ? process.execPath : path.join(toolsHome!,'bin','ez'),isolated ? [fileURLToPath(new URL('../bin/ez',import.meta.url)),'--task-application'] : [launch.command,...launch.args],{env:{...executorEnvironment(),EZ_RUN_ID:runId},...(config ? {cwd:config.workspace} : {}),stdio:['pipe','pipe','pipe']})
    let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Application launch timed out'))},30000)
    child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>16000){child.kill();reject(Error('Application launch output too large'))}})
    child.stderr.resume();child.on('error',reject)
    child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error('Application launch failed');const value=JSON.parse(output);const url=new URL(value.launch?.url);if(url.protocol!=='https:' || url.username || url.password || typeof value.launch?.expiresAt!=='number')throw Error('Invalid application launch receipt');resolve(value.launch)}catch(e){reject(e)}})
    child.stdin.end(JSON.stringify(input))
  })
}
