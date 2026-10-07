import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import { executorEnvironment } from './executor.js'
import type { TaskCapability } from './tasks.js'
import {attachmentLimit,stageTaskAttachment,type TaskAttachment} from './task-attachments.js'

const execute = promisify(execFile)

export async function assertChannelQuery(toolsHome: string | undefined, capability: TaskCapability) {
  if (!toolsHome || !path.isAbsolute(toolsHome)) throw new Error('Channel capabilities require an installed tool registry')
  const registry = JSON.parse(await readFile(path.join(toolsHome,'registry.json'),'utf8')) as {
    commands?: Record<string,string>, plugins?: Record<string,{manifest?:{commands?:Record<string,{channelQuery?:boolean,channelFile?:boolean,exposure?:Record<string,boolean>}>}}>
  }
  const command = registry.plugins?.[registry.commands?.[capability.command] ?? '']?.manifest?.commands?.[capability.command]
  const exposure = command?.exposure
  if ((capability.output==='file'?command?.channelFile:command?.channelQuery) !== true || exposure?.receivesExternalContent !== true || exposure.sendsExternally !== false ||
      exposure.changesRecords !== false || exposure.requiresReview !== false)
    throw new Error(`Capability ${capability.id} is not an installed read-only channel query`)
}

export async function runTaskCapability(toolsHome: string | undefined, capability: TaskCapability, input: string, staging?:{controlDir:string;runId:string;lease:string}):Promise<{output:string;attachment?:never}|{attachment:TaskAttachment;output?:never}> {
  await assertChannelQuery(toolsHome,capability)
  const home = toolsHome!
  const args = [capability.command, ...capability.args.map(value => value === '{input}' ? input : value)]
  if(capability.output==='file') {
    if(!staging)throw Error('File capability requires task staging')
    const result=await execute(path.join(home,'bin','ez'),args,{encoding:'buffer',env:executorEnvironment(),timeout:30000,maxBuffer:attachmentLimit})
    const attachment=await stageTaskAttachment(staging.controlDir,staging.runId,staging.lease,input,result.stdout)
    return {attachment}
  }
  let stdout = '', code = 0
  try {
    const result = await execute(path.join(home,'bin','ez'),args,{encoding:'utf8',env:executorEnvironment(),timeout:15000,maxBuffer:131072})
    stdout = result.stdout
  } catch (error) {
    const failure = error as Error & {stdout?:string;code?:number|string}
    stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
    code = typeof failure.code === 'number' ? failure.code : 1
  }
  if (Buffer.byteLength(stdout) > 131072) throw new Error('Channel capability output is too large')
  if (code !== 0 || !stdout.trim()) throw new Error(`Channel capability failed with exit ${code}`)
  return {output:stdout}
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
