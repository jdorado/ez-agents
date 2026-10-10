import { redactFailure } from './failure.js'
import { Tasks } from './tasks.js'
import { ControlStore } from './control-state.js'
import { authorizeRun, readRun } from './delivery-socket.js'
import { runPromptSuffix } from './prompt-suffix.js'
import { mkdir, readFile, writeFile, readdir, rename, rm, appendFile, realpath, utimes, stat } from 'node:fs/promises'
import path from 'node:path'
import { isHostRunId } from './host-executor-protocol.js'
import { fileURLToPath } from 'node:url'
import { CliUnavailableError, startExecutorJob, terminateJob, resolveExecutor, validateCodexProvider, type CodexProviderBinding, type ExecutorOptions } from './executor.js'
import { activeSetup } from './runs.js'
import { startupLine, startupObserver } from './setup-fallback.js'
import { parseIsolationClass, type IsolationClass } from './isolation.js'
import { readModels, sameEngine, validateSelection, validateOpencodeProviders, type ModelChoice } from './ai.js'
import type { ChildProcess } from 'node:child_process'
import { packageVersion } from './version.js'
import { installedPluginVersions } from './software-status.js'
import { assertScheduledModel } from './model-policy.js'
import { processSnapshot } from './process-tree.js'

export type PluginNetworkRoute = { revisions:string[]; bindings:{service:string;network:string}[] }
export type HostBinding = { name: string; workspace: string; controlDir: string; binDir: string; toolsHome?: string; sharedWorkspace?: string; additionalWorkspaces?: string[]; pluginNetworkBindings?: Record<string, PluginNetworkRoute>; pluginFolderRoots?: Record<string,string[]>; codexProviders?: CodexProviderBinding[]; opencodeProviders?: string[] }
export type HostInstallation = { cli: string; isolation?: IsolationClass; agents: HostBinding[] }

// Periodic refresh body, extracted for testing. Throws on failure; the
// caller keeps the last-good disk catalog and the host alive.
export const refreshAgentCatalog = async (agent: HostBinding,
  readFresh: (agent: HostBinding) => Promise<ModelChoice[]>,
  seen: Map<HostBinding, string>): Promise<void> => {
  const catalogModels = await readFresh(agent)
  // Empty discovery is not an authoritative deletion of the installed catalog.
  if (!catalogModels.length) return
  const models = JSON.stringify(catalogModels)
  if (seen.get(agent) === models) return
  await new ControlStore(agent.controlDir, 900000).normalizeProviderBindings(catalogModels)
  const file = path.join(agent.controlDir, 'host-executor/models.json')
  await writeFile(file + '.tmp', models, { mode: 0o600 })
  await rename(file + '.tmp', file)
  seen.set(agent, models)
}

const processStart = async (pid:number) => (await processSnapshot()).get(pid)?.birth

export const serveHostExecutor = async (installation: HostInstallation, signal: AbortSignal, launch = startExecutorJob,
  readCatalog?: (agent: HostBinding) => Promise<ModelChoice[]>, retire?: AbortSignal) => {
  if (installation.isolation !== undefined) parseIsolationClass(installation.isolation)
  if (installation.isolation === 'isolated' && process.env.EZ_CONTAINER_EXECUTOR !== '1') throw new Error('Isolated agents run the native CLI in the relay; do not start host transport')
  resolveExecutor(installation.cli)
  if (new Set(installation.agents.map(a=>a.workspace)).size !== installation.agents.length ||
      new Set(installation.agents.map(a=>a.controlDir)).size !== installation.agents.length)
    throw new Error('Each agent requires a separate workspace and control directory')
  const containerId = process.env.EZ_CONTAINER_EXECUTOR === '1' ? process.env.HOSTNAME : undefined
  const hostStarted = await processStart(process.pid)
  let retiring = false
  const active = new Map<string, ChildProcess>()
  // A fallback attempt reuses its run ID; claim it only after the prior attempt's cleanup.
  const claimed = new Set<string>()
  const tasks = new Set<Promise<void>>()
  let catalogRefresh: Promise<void> | undefined
  const locks: string[] = []
  const sharedWorkspaces = new Map<HostBinding, string>()
  const activeWorkspaces = new Map<HostBinding, { lanes: Map<string, boolean>; release?: () => Promise<void> }>()
  const additionalWorkspaces = new Map<HostBinding, string[]>()
  const catalog = async (agent: HostBinding) => {
    const discovered = await readModels(undefined, undefined, path.join(agent.controlDir, 'cli', 'codex'),
      undefined, undefined, validateOpencodeProviders(agent.opencodeProviders), agent.controlDir)
    const providers = (agent.codexProviders ?? []).map(validateCodexProvider)
    const declared = providers.flatMap(provider => provider.models.map(model => {
      const native = discovered.find(candidate => candidate.cli === 'codex' && !candidate.provider && candidate.model === model)
      return {cli:'codex',provider:provider.id,model,name:`${provider.name} · ${model}`.slice(0,80),efforts:native?.efforts ?? []}
    }))
    const declaredModels = new Set(declared.map(model => model.model))
    const isReplacedByProvider = (model: {cli:string; model?:string}) =>
      model.model !== undefined && declaredModels.has(model.model) && model.cli === 'codex'
    return [...discovered.filter(model => !isReplacedByProvider(model)), ...declared]
  }
  const freshCatalog = readCatalog ?? catalog
  const beat = async (agent: HostBinding) => {
    const directory = path.join(agent.controlDir, 'host-executor')
    await writeFile(path.join(directory, 'heartbeat.tmp'), JSON.stringify({ at: Date.now(), pid: process.pid, version: packageVersion, platform: process.platform, arch: process.arch, ...(process.env.EZ_CONTAINER_EXECUTOR === '1' ? {containerExecutor:true,containerId} : {}), plugins: await installedPluginVersions(agent.toolsHome) }), { mode: 0o600 })
    await rename(path.join(directory, 'heartbeat.tmp'), path.join(directory, 'heartbeat.json'))
  }
  const recoverClaims = async (agent: HostBinding) => {
    const directory=path.join(agent.controlDir,'host-executor')
    for (const file of await readdir(directory)) if (file.endsWith('.running.json') && isHostRunId(file.slice(0,-13))) {
      const base=path.join(directory,file.slice(0,-13))
      if (claimed.has(base)) continue
      let prior: {pid?:number;started?:string;hostPid?:number;hostStarted?:string;containerId?:string} | undefined
      try { prior=JSON.parse(await readFile(base+'.process.json','utf8')) } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
      if(prior?.containerId && prior.containerId!==containerId){
        const touched=await stat(base+'.events').then(s=>s.mtimeMs,()=>0)
        if(Date.now()-touched<15000)continue
      }
      if (!prior?.containerId && prior?.hostPid && prior.hostStarted && await processStart(prior.hostPid)===prior.hostStarted) continue
      if (!prior?.containerId && prior?.pid && await processStart(prior.pid)) {
        if (!prior.hostPid) throw Error('Previous host CLI is still running; stop it before recovery')
        if (prior.started && await processStart(prior.pid)===prior.started) terminateJob({pid:prior.pid,exitCode:null,signalCode:null} as ChildProcess)
      }
      await appendFile(base+'.events',JSON.stringify({stream:'exit',code:1})+'\n',{mode:0o600})
      await rm(base+'.process.json',{force:true});await rm(base+'.running.json',{force:true})
    }
  }
  try {
    for (const agent of installation.agents) {
      if (![agent.workspace,agent.controlDir,agent.binDir].every(path.isAbsolute)) throw new Error('Host bindings require absolute paths')
      const providers=(agent.codexProviders ?? []).map(validateCodexProvider)
      if (new Set(providers.map(provider=>provider.id)).size !== providers.length) throw new Error('Codex provider IDs must be unique')
      validateOpencodeProviders(agent.opencodeProviders)
      if (agent.sharedWorkspace && !path.isAbsolute(agent.sharedWorkspace)) throw new Error('Shared workspace requires an absolute path')
      if (agent.sharedWorkspace) sharedWorkspaces.set(agent, await realpath(agent.sharedWorkspace))
      if (agent.additionalWorkspaces) {
        if (!Array.isArray(agent.additionalWorkspaces) || agent.additionalWorkspaces.some(workspace=>typeof workspace!=='string' || !path.isAbsolute(workspace))) throw new Error('Additional workspaces require absolute paths')
        additionalWorkspaces.set(agent,await Promise.all(agent.additionalWorkspaces.map(workspace=>realpath(workspace))))
      }
      if (agent.toolsHome && !containerId) {
        if (!path.isAbsolute(agent.toolsHome)) throw new Error('Plugin registry binding requires an absolute path')
        const config=JSON.parse(await readFile(path.join(agent.toolsHome,'config.json'),'utf8'))
        if (config.schemaVersion!==1 || config.workspace!==await realpath(agent.workspace)) throw new Error('Plugin registry belongs to another workspace')
      }
      const directory = path.join(agent.controlDir,'host-executor')
      await mkdir(directory,{recursive:true,mode:0o700})
      const lock=path.join(directory,'worker.lock')
      try {
        const prior=JSON.parse(await readFile(lock,'utf8'))
        if(prior.containerId&&prior.containerId!==containerId)throw Error('Previous isolated worker still owns the claim lock')
        const currentStart=await processStart(prior.pid)
        if (!prior.started || !currentStart || prior.started===currentStart) {
          try { process.kill(prior.pid,0); throw new Error('Host executor already running') }
          catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
        await rm(lock)
      }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeFile(lock,JSON.stringify({pid:process.pid,started:await processStart(process.pid),...(containerId ? {containerId} : {})}),{mode:0o600,flag:'wx'})
      locks.push(lock)
      const models = await freshCatalog(agent)
      await new ControlStore(agent.controlDir, 900000).normalizeProviderBindings(models)
      const modelsFile=path.join(directory,'models.json')
      await writeFile(modelsFile+'.tmp',JSON.stringify(models),{mode:0o600});await rename(modelsFile+'.tmp',modelsFile)
      await recoverClaims(agent)
      if (agent.toolsHome && !containerId) await (await import('./plugins/workspace-lease.mjs')).recoverNativeLease(agent.toolsHome)
    }
    let catalogAt=Date.now()
    const catalogSeen=new Map<HostBinding,string>()
    while (!signal.aborted) {
      const parent=Number(process.env.EZ_HOST_SUPERVISOR_PID)
      if(parent && !retiring) { try { process.kill(parent,0) } catch { break } }
      if (retire?.aborted && !retiring) {
        retiring=true
        await catalogRefresh
        for (const lock of locks.splice(0)) await rm(lock,{force:true})
      }
      if (retiring && !tasks.size) break
      // Keep transport liveness independent of native catalog I/O.
      if (!retiring) for (const agent of installation.agents) await beat(agent)
      if(!retiring && !catalogRefresh && Date.now()-catalogAt>30000){
        catalogAt=Date.now()
        catalogRefresh=(async()=>{
          for(const agent of installation.agents){
            if(signal.aborted)break
            try {
              await refreshAgentCatalog(agent, freshCatalog, catalogSeen)
            } catch (error) {
              console.error('Host catalog refresh failed, keeping last-good models', error instanceof Error ? error.message : error)
            }
          }
        })().finally(()=>{catalogRefresh=undefined})
      }
      for (const agent of installation.agents) {
        const directory=path.join(agent.controlDir,'host-executor')
        if (retiring) continue
        await recoverClaims(agent)
        for (const file of await readdir(directory)) {
          if (!file.endsWith('.request.json') || !isHostRunId(file.slice(0,-13))) continue
          const id=file.slice(0,-13)
          if (claimed.has(path.join(directory,id))) continue
          let run
          try {
            run = await readRun(agent.controlDir, id)
            if(id.startsWith('r_schedule_') && !run?.scheduled) throw new Error('Missing scheduled run')
          } catch {
            await appendFile(path.join(directory,id+'.events'),JSON.stringify({stream:'exit',code:1})+'\n',{mode:0o600})
            await rm(path.join(directory,file))
            continue
          }
          const sharedWorkspace=sharedWorkspaces.get(agent)
          const base=path.join(directory,id)
          const scheduled = Boolean(run?.scheduled)
          let workspace = activeWorkspaces.get(agent)
          if (!scheduled && workspace && [...workspace.lanes.values()].includes(false)) continue
          if (!workspace) {
            const release = agent.toolsHome && !containerId
              ? await (await import('./plugins/workspace-lease.mjs')).workspaceLease(agent.toolsHome,{kind:'native',runId:id}) : undefined
            if (agent.toolsHome && !containerId && !release) continue
            workspace = { lanes: new Map(), release }
            activeWorkspaces.set(agent, workspace)
          }
          workspace.lanes.set(id, scheduled)
          claimed.add(base)
          // Keep plugin workspace invocations excluded until all native jobs finish.
          const releaseWorkspace = async () => {
            workspace.lanes.delete(id)
            if (!workspace.lanes.size) {
              activeWorkspaces.delete(agent)
              await workspace.release?.()
            }
          }
          try {
            await writeFile(base+'.process.json',JSON.stringify({hostPid:process.pid,hostStarted,...(containerId ? {containerId} : {})}),{mode:0o600})
            await appendFile(base+'.events','',{mode:0o600})
            await rename(base+'.request.json',base+'.running.json')
          }
          catch (error) { claimed.delete(base); await releaseWorkspace(); throw error }
          const task=(async()=>{
            let job: Awaited<ReturnType<typeof startExecutorJob>> | undefined
            let cancellation: ReturnType<typeof setInterval> | undefined
            let writes=Promise.resolve()
            let observeClaude=false
            const emit=(event:unknown)=>{writes=writes.then(()=>appendFile(base+'.events',JSON.stringify(event)+'\n',{mode:0o600}))}
            try {
              try { await readFile(base+'.cancel'); throw new Error('Cancelled') } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              const request=JSON.parse(await readFile(base+'.running.json','utf8'))
              if (!Array.isArray(request.texts) || request.texts.some((text:unknown)=>typeof text!=='string')) throw new Error('Invalid job')
              const run = await readRun(agent.controlDir, path.basename(base))
              if (run?.taskId) {
                if (run.status !== 'running') throw new Error('No active task run')
                await new Tasks(agent.controlDir).authorize(run, false)
              } else await authorizeRun(agent.controlDir, path.basename(base))
              const opts=request.options as ExecutorOptions
              // Script occurrences come from the authorized run record, never the request.
              if (run?.script) {
                if (!run.scheduled) throw new Error('Script runs require a scheduled occurrence')
                const options:ExecutorOptions={workspace:agent.workspace,controlDir:agent.controlDir,binDir:agent.binDir,toolsHome:agent.toolsHome,sharedWorkspace,additionalWorkspaces:additionalWorkspaces.get(agent),
                  runId:path.basename(base),timeoutMs:0,repairEnabled:opts.repairEnabled,
                  script:{...run.script,scheduleId:run.scheduled.id,scheduleRevision:run.scheduled.revision,dueAt:run.scheduled.dueAt}}
                job=await launch(request.texts,options)
              } else {
                const cli = opts.cli || installation.cli
                if (run?.scheduled) {
                  const setup = activeSetup(run)
                  assertScheduledModel(setup?.model)
                  if (opts.model !== setup!.model || cli !== setup!.cli) throw new Error('Scheduled run model does not match its saved task model')
                  observeClaude = cli === 'claude'
                }
                resolveExecutor(cli)
                // The credential home comes from the authorized run's captured
                // choice; a request can never move it to another account.
                const captured = run?.scheduled ? activeSetup(run) : run?.execution?.preset
                if ((opts.authProfile !== undefined || (captured?.cli === cli && captured.authProfile !== undefined)) &&
                    !(captured && sameEngine(captured, {cli, authProfile: opts.authProfile})))
                  throw new Error('Run auth profile does not match its captured AI selection')
                const provider = cli === 'codex' && opts.provider
                  ? (agent.codexProviders ?? []).map(validateCodexProvider).find(candidate=>candidate.id===opts.provider)
                  : undefined
                if (opts.provider && !provider) throw new Error('Selected Codex provider is not installed for this agent')
                const model = opts.model
                if (provider && !model) throw new Error('Selected Codex provider requires a declared model')
                if (provider && model && !provider.models.includes(model)) throw new Error('Selected model is not declared for this Codex provider')
                if (!provider && model && (agent.codexProviders ?? []).some(binding=>binding.models.includes(model)))
                  throw new Error('Selected Codex provider is required for this model')
                // Admission and execution must use the same catalog snapshot. A
                // transient native-client probe failure must not reject a model
                // that the host just advertised to the relay and application.
                if (cli !== installation.cli || opts.authProfile !== undefined) await validateSelection({id:'selected',name:'Selected model',cli,provider:opts.provider,authProfile:opts.authProfile,model,effort:opts.effort},JSON.parse(await readFile(path.join(directory,'models.json'),'utf8')))
                const options:ExecutorOptions={workspace:agent.workspace,controlDir:agent.controlDir,binDir:agent.binDir,toolsHome:agent.toolsHome,sharedWorkspace,additionalWorkspaces:additionalWorkspaces.get(agent),cli,
                  runId:path.basename(base),timeoutMs:0,repairEnabled:opts.repairEnabled,
                  sessionId:opts.sessionId,isResume:opts.isResume,model,effort:opts.effort,provider:opts.provider,authProfile:opts.authProfile,codexAutoCompactTokens:opts.codexAutoCompactTokens,codexProvider:provider,
                  promptSuffix:runPromptSuffix(run),taskRun:Boolean(run?.taskId),nativeSession:Boolean(run?.scheduled)}
                job=await launch(request.texts,options)
              }
              active.set(base,job.child)
              await writeFile(base+'.process.json',JSON.stringify({pid:job.child.pid,started:job.child.pid ? await processStart(job.child.pid) : undefined,hostPid:process.pid,hostStarted,...(containerId ? {containerId} : {})}),{mode:0o600})
              if(signal.aborted)terminateJob(job.child)
              // Scheduled Claude streams every event; forward only the startup summary.
              const startup = observeClaude ? startupObserver() : undefined
              let summary = ''
              job.child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{
                if (!startup) return emit({stream:'stdout',text:chunk})
                startup.write(chunk)
                if (startup.summary() !== summary) { summary = startup.summary(); emit({stream:'stdout',text:summary+'\n'}) }
              })
              job.child.stderr?.on('data',chunk=>emit({stream:'stderr',text:chunk.toString()}))
              cancellation=setInterval(()=>{void readFile(base+'.cancel').then(()=>terminateJob(job!.child)).catch(()=>{}); const now=new Date();void utimes(base+'.events',now,now).catch(()=>{})},250)
              const code=await new Promise<number>(resolve=>job!.child.once('close',code=>resolve(code??1)))
              if (cancellation) clearInterval(cancellation)
              await job.cleanup()
              job = undefined
              emit({stream:'exit',code})
            } catch (error) {
              if (error instanceof CliUnavailableError) emit({stream:'stdout',text:startupLine({workBegan:false,rejection:{category:'cli-unavailable'}})+'\n'})
              emit({stream:'stderr',text:'Host CLI execution failed: '+redactFailure(error instanceof Error ? error.message : 'Unknown error')+'\n'}); emit({stream:'exit',code:1}) }
            finally {
              if(cancellation)clearInterval(cancellation)
              await job?.cleanup().catch(() => {})
              await writes
              await rm(base+'.running.json',{force:true})
              await rm(base+'.process.json',{force:true})
              await rm(base+'.cancel',{force:true})
              active.delete(base)
              await releaseWorkspace()
              claimed.delete(base)
            }
          })()
          tasks.add(task); void task.finally(()=>tasks.delete(task))
        }
      }
      await new Promise(resolve=>setTimeout(resolve,250))
    }
  } finally {
    for(const child of active.values())terminateJob(child)
    await Promise.allSettled(tasks)
    await catalogRefresh
    for(const lock of locks)await rm(lock,{force:true})
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const abort=new AbortController(),retire=new AbortController()
  process.once('SIGUSR2',()=>retire.abort())
  for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>abort.abort())
  const config=JSON.parse(await readFile(process.argv[2],'utf8'))
  await serveHostExecutor(config,abort.signal,undefined,undefined,retire.signal)
}
