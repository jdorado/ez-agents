import { mkdir, readFile, writeFile, readdir, rename, rm, appendFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isHostRunId } from './host-executor-protocol.js'
import { fileURLToPath } from 'node:url'
import { startExecutorJob, terminateJob, resolveExecutor, type ExecutorOptions } from './executor.js'
import { readModels, validateSelection } from './ai.js'
import type { ChildProcess } from 'node:child_process'
import { packageVersion } from './version.js'
import { installedPluginVersions } from './software-status.js'

export type HostBinding = { name: string; workspace: string; controlDir: string; binDir: string; toolsHome?: string }
export type HostInstallation = { cli: string; agents: HostBinding[] }

export const serveHostExecutor = async (installation: HostInstallation, signal: AbortSignal) => {
  resolveExecutor(installation.cli)
  if (new Set(installation.agents.map(a=>a.workspace)).size !== installation.agents.length ||
      new Set(installation.agents.map(a=>a.controlDir)).size !== installation.agents.length)
    throw new Error('Each agent requires a separate workspace and control directory')
  const active = new Map<string, ChildProcess>()
  const busy = new Set<string>()
  const tasks = new Set<Promise<void>>()
  const locks: string[] = []
  try {
    for (const agent of installation.agents) {
      if (![agent.workspace,agent.controlDir,agent.binDir].every(path.isAbsolute)) throw new Error('Host bindings require absolute paths')
      if (agent.toolsHome) {
        if (!path.isAbsolute(agent.toolsHome)) throw new Error('Plugin registry binding requires an absolute path')
        const config=JSON.parse(await readFile(path.join(agent.toolsHome,'config.json'),'utf8'))
        if (config.schemaVersion!==1 || config.workspace!==await realpath(agent.workspace)) throw new Error('Plugin registry belongs to another workspace')
      }
      const directory = path.join(agent.controlDir,'host-executor')
      await mkdir(directory,{recursive:true,mode:0o700})
      const lock=path.join(directory,'worker.lock')
      try { const prior=JSON.parse(await readFile(lock,'utf8')); try { process.kill(prior.pid,0); throw new Error('Host executor already running') } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }; await rm(lock) }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeFile(lock,JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'})
      locks.push(lock)
      await writeFile(path.join(directory,'models.json'),JSON.stringify(await readModels()),{mode:0o600})
      // A host crash is terminal for a claimed job. Never replay an action.
      for (const file of await readdir(directory)) if (file.endsWith('.running.json')) {
        const base=path.join(directory,file.slice(0,-13))
        try {
          const prior=JSON.parse(await readFile(base+'.process.json','utf8'))
          try { process.kill(prior.pid,0); throw new Error('Previous host CLI is still running; stop it before recovery') }
          catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rm(base+'.process.json',{force:true})
        await appendFile(base+'.events',JSON.stringify({stream:'exit',code:1})+'\n',{mode:0o600})
        await rm(path.join(directory,file))
      }
    }
    let catalogAt=Date.now()
    while (!signal.aborted) {
      const parent=Number(process.env.EZ_HOST_SUPERVISOR_PID)
      if(parent) { try { process.kill(parent,0) } catch { break } }
      if(Date.now()-catalogAt>30000){
        const models=JSON.stringify(await readModels())
        for(const agent of installation.agents){
          const file=path.join(agent.controlDir,'host-executor/models.json')
          await writeFile(file+'.tmp',models,{mode:0o600});await rename(file+'.tmp',file)
        }
        catalogAt=Date.now()
      }
      for (const agent of installation.agents) {
        const directory=path.join(agent.controlDir,'host-executor')
        await writeFile(path.join(directory,'heartbeat.tmp'),JSON.stringify({at:Date.now(),pid:process.pid,version:packageVersion,plugins:await installedPluginVersions(agent.toolsHome)}),{mode:0o600})
        await rename(path.join(directory,'heartbeat.tmp'),path.join(directory,'heartbeat.json'))
        for (const file of await readdir(directory)) {
          if ((!file.endsWith('.request.json') || !isHostRunId(file.slice(0,-13))) || busy.has(agent.name)) continue
          const base=path.join(directory,file.slice(0,-13))
          await rename(base+'.request.json',base+'.running.json')
          busy.add(agent.name)
          const task=(async()=>{
            let job: Awaited<ReturnType<typeof startExecutorJob>> | undefined
            let cancellation: ReturnType<typeof setInterval> | undefined
            let writes=Promise.resolve()
            const emit=(event:unknown)=>{writes=writes.then(()=>appendFile(base+'.events',JSON.stringify(event)+'\n',{mode:0o600}))}
            try {
              try { await readFile(base+'.cancel'); throw new Error('Cancelled') } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              const request=JSON.parse(await readFile(base+'.running.json','utf8'))
              if (!Array.isArray(request.texts) || request.texts.some((text:unknown)=>typeof text!=='string')) throw new Error('Invalid job')
              const opts=request.options as ExecutorOptions
              const cli = opts.cli || installation.cli
              resolveExecutor(cli)
              if (cli !== installation.cli) await validateSelection({id:'selected',name:'Selected model',cli,model:opts.model,effort:opts.effort},await readModels())
              const options:ExecutorOptions={workspace:agent.workspace,controlDir:agent.controlDir,binDir:agent.binDir,toolsHome:agent.toolsHome,cli,
                runId:path.basename(base),timeoutMs:Math.min(Math.max(Number(opts.timeoutMs)||300000,1000),1800000),
                sessionId:opts.sessionId,isResume:opts.isResume,eventSource:opts.eventSource,model:opts.model,effort:opts.effort}
              job=await startExecutorJob(request.texts,options)
              active.set(agent.name,job.child)
              await writeFile(base+'.process.json',JSON.stringify({pid:job.child.pid}),{mode:0o600})
              if(signal.aborted)terminateJob(job.child)
              job.child.stdout?.on('data',chunk=>emit({stream:'stdout',text:chunk.toString()}))
              job.child.stderr?.on('data',chunk=>emit({stream:'stderr',text:chunk.toString()}))
              cancellation=setInterval(()=>{void readFile(base+'.cancel').then(()=>terminateJob(job!.child)).catch(()=>{})},250)
              const code=await new Promise<number>(resolve=>job!.child.once('close',code=>resolve(code??1)))
              emit({stream:'exit',code})
            } catch { emit({stream:'stderr',text:'Host CLI execution failed\n'}); emit({stream:'exit',code:1}) }
            finally {
              if(cancellation)clearInterval(cancellation)
              await job?.cleanup()
              await writes
              await rm(base+'.running.json',{force:true})
              await rm(base+'.process.json',{force:true})
              await rm(base+'.cancel',{force:true})
              active.delete(agent.name)
              busy.delete(agent.name)
            }
          })()
          tasks.add(task); void task.finally(()=>tasks.delete(task))
          // Do not claim a second job while asynchronous spawning is pending.
          break
        }
      }
      await new Promise(resolve=>setTimeout(resolve,250))
    }
  } finally {
    for(const child of active.values())terminateJob(child)
    await Promise.allSettled(tasks)
    for(const lock of locks)await rm(lock,{force:true})
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const abort=new AbortController()
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>abort.abort())
  const config=JSON.parse(await readFile(process.argv[2],'utf8'))
  await serveHostExecutor(config,abort.signal)
}
