import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomic, locked } from '../plugins/manager.mjs';
import { callDeliverySocket } from '../delivery-socket-client.mjs';
import { state, read, jobs, jobPath, check, prepare, submit, missing, cleanupStaleBackups } from './control.mjs';
import { perform, environment, brokerNeedsRefresh, execute, relayArgs } from './runtime.mjs';

const reservedProviderKeys=new Set(['HOME','LANG','LC_ALL','LOGNAME','PATH','SHELL','TERM','TMPDIR','USER','CODEX_HOME','NODE_OPTIONS']);
const providerEnvironmentKey=value=>{
  if(typeof value!=='string'||value.length>64||!/^[A-Z][A-Z0-9_]{1,63}$/.test(value))throw Error('Invalid Codex provider environment key');
  if(reservedProviderKeys.has(value)||value.startsWith('EZ_')||value.startsWith('TELEGRAM_'))throw Error('Reserved Codex provider environment key');
  return value;
};

export function providerEnvironment(host, environment=process.env) {
  const names=(host.agents||[]).flatMap(agent=>(agent.codexProviders||[]).map(provider=>providerEnvironmentKey(provider.envKey)));
  return Object.fromEntries([...new Set(names)].flatMap(name=>environment[name]===undefined?[]:[[name,environment[name]]]));
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function waitForHostHeartbeat(controlDir,child,failure,{attempts=300,intervalMs=100,readHeartbeat=read,wait=sleep}={}) {
  for(let n=0;n<attempts;n++) {
    const error=failure();
    if(error||child.exitCode!==null)throw error||Error('Host transport failed to start');
    const beat=await readHeartbeat(path.join(controlDir,'host-executor/heartbeat.json')).catch(missing);
    if(beat?.pid===child.pid&&Date.now()-beat.at<10000)return;
    await wait(intervalMs);
  }
  throw Error('Host transport heartbeat timeout');
}
export async function idle(control) {
  const host=await fs.readdir(path.join(control,'host-executor')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  if(host.some(f=>f.endsWith('.running.json')||f.endsWith('.request.json')))return false;
  // Run records live in relay memory: the live socket status is the only
  // cross-process view of active work. A down relay cannot own a run.
  const status=await callDeliverySocket(path.join(control,'delivery.sock'),{op:'status'},2000).catch(()=>null);
  return !status||status.running===0;
}
// Pause admission only after work is idle, and release it if a turn raced the
// check. A queued upgrade must never hold the owner's chat behind a long turn.
export async function withIdleUpgrade(control,job,signal,apply,{isIdle=idle,wait=sleep}={}) {
  if(signal.aborted||!await isIdle(control))return;
  const pause=path.join(control,'upgrade-pause.json');
  await atomic(pause,{id:job.id});
  try {
    for(let n=0;n<3;n++) {
      await wait(500);
      if(signal.aborted||!await isIdle(control))return;
    }
    if(!signal.aborted)return await apply();
  } finally {await fs.rm(pause,{force:true});}
}
// Plugin replacement drains command leases at activation, not native turns.
export async function withUpgrade(control,job,signal,apply,options) {
  if((job.target==='main'&&!options?.preserveRuns)||options?.requiresIdle)return withIdleUpgrade(control,job,signal,apply,options);
  if(!signal.aborted)return apply();
}
export async function queueAutomatic(home,available) {
  const existing=await jobs(home);
  if(existing.some(job=>['queued','applying','recovery-required'].includes(job.status)))return null;
  for(const candidate of available) {
    if(!candidate.newer||!candidate.policy?.automatic||!candidate.available)continue;
    // A failed release needs a newer version or an explicit owner retry.
    if(existing.some(job=>job.target===candidate.target&&job.version===candidate.available&&['failed','rolled-back'].includes(job.status)))continue;
    try {
      const job=await prepare(home,candidate.target,{release:candidate.available});
      return await submit(home,job.id,true);
    }catch {
      console.error(`Automatic update of ${candidate.target} failed; inspect ez updates check/status.`);
    }
  }
  return null;
}
export async function supervise(deployment,signal,{discover=check}={}) {
  const host=await read(path.join(deployment,'host-executor.json'));
  if(host.agents.length!==1||!host.agents[0].toolsHome)throw Error('Initialize a single deployment plugin registry before starting the supervisor');
  const home=host.agents[0].toolsHome,{directory,agent}=await state(home);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  // Exclusive supervisor ownership. A dead owner can be recovered; a live one cannot.
  const lock=path.join(directory,'supervisor.lock');
  const prior=await read(lock).catch(missing);
  if(prior&&(!Number.isSafeInteger(prior.pid)||prior.pid<1))throw Error('Corrupt supervisor lock');
  if(prior){try{process.kill(prior.pid,0);throw Error('Supervisor already running');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.rm(lock);}
  await fs.writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
  let child,container;
  let retirements=[];
  let reloadPending=false;
  const generations=new Map();
  const removeContainer=async id=>{
    const generation=generations.get(id);
    if(generation){await execute('docker',['compose','--project-name',generation.project,'--file',generation.file,'down']);await fs.rm(generation.file,{force:true});await fs.rm(generation.configFile,{force:true});generations.delete(id);}
    else await execute('docker',['rm',id]);
  };
  const stopHost=async()=>{
    if(container){await execute('docker',['stop','--time','10',container]);await removeContainer(container);container=undefined;}
    if(!child)return;const running=child;child=undefined;
    if(running.exitCode!==null)return;
    const closed=new Promise(resolve=>running.once('close',resolve));running.kill('SIGTERM');
    const timer=setTimeout(()=>running.kill('SIGKILL'),10000);await closed;clearTimeout(timer);
  };
  const startHost=async root=>{
    if(host.isolation==='isolated') {
      const pkg=await read(path.join(root,'package.json'));
      if(pkg.ezRelease?.containerExecutor!==1)return;
      const lock=path.join(agent.controlDir,'host-executor/worker.lock');
      const prior=await read(lock).catch(missing);
      if(prior?.containerId){
        if(!/^[a-f0-9]{12,64}$/.test(prior.containerId))throw Error('Invalid previous isolated worker identity');
        const running=await execute('docker',['inspect','--format','{{.State.Running}}',prior.containerId],{stdoutOnly:true}).catch(()=>null);
        if(running?.trim()==='true')throw Error('Previous isolated worker is still running');
        // Only the supervisor can prove a foreign container stopped.
        if(JSON.stringify(await read(lock))!==JSON.stringify(prior))throw Error('Worker lock changed during recovery');
        await fs.rm(lock);
      }
      const config=(await state(home)).config;
      const deployment=JSON.parse(await execute('docker',[...relayArgs(config),'config','--format','json'],{stdoutOnly:true}));
      const relay=deployment.services.relay;
      if(!relay?.image||!Array.isArray(relay.volumes))throw Error('Invalid isolated relay binding');
      const generation=path.basename(root).replace(/[^a-zA-Z0-9_.-]/g,'-')+'-'+Date.now();
      const project='ez-executor-'+generation.toLowerCase();
      const file=path.join(directory,project+'.json');
      const configFile=path.join(directory,project+'-binding.json');
      await atomic(configFile,{...host,agents:host.agents.map(a=>({...a,binDir:'/app/bin'}))});
      const worker={image:relay.image,init:true,restart:'no',user:`${relay.environment.EZ_RUNTIME_UID||1000}:${relay.environment.EZ_RUNTIME_GID||1000}`,
        cap_drop:['ALL'],security_opt:['no-new-privileges:true'],entrypoint:['node','--import','/app/node_modules/tsx/dist/loader.mjs','/app/src/host-executor.ts','/run/executor.json'],
        environment:{...relay.environment,EZ_CONTAINER_EXECUTOR:'1',EZ_EXECUTOR_TRANSPORT:'local'},
        volumes:[...relay.volumes,{type:'bind',source:configFile,target:'/run/executor.json',read_only:true}],tmpfs:['/tmp']};
      await atomic(file,{services:{executor:worker}});
      await execute('docker',['compose','--project-name',project,'--file',file,'up','-d','--no-build','executor']);
      container=(await execute('docker',['compose','--project-name',project,'--file',file,'ps','-q','executor'],{stdoutOnly:true})).trim();
      if(!/^[a-f0-9]{12,64}$/.test(container))throw Error('Missing isolated executor');
      generations.set(container,{project,file,configFile});
      for(let n=0;n<300;n++){
        const running=await execute('docker',['inspect','--format','{{.State.Running}}',container],{stdoutOnly:true});
        if(running.trim()!=='true')throw Error('Isolated executor exited during startup');
        const heartbeat=await read(path.join(agent.controlDir,'host-executor/heartbeat.json')).catch(missing);
        if(heartbeat?.containerExecutor===true&&container.startsWith(heartbeat.containerId||'missing')&&Date.now()-heartbeat.at<1000)return;
        await sleep(100);
      }
      throw Error('Isolated executor heartbeat timeout');
    }
    child=spawn(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'src/host-executor.ts'),path.join(deployment,'host-executor.json')],
      {detached:true,env:{...environment(),...providerEnvironment(host),EZ_HOST_SUPERVISOR_PID:String(process.pid)},stdio:['ignore','inherit','inherit']});
    let error;child.once('error',e=>{error=e;});
    await waitForHostHeartbeat(agent.controlDir,child,()=>error);
  };
  const retireHost=async()=>{
    if(container){await execute('docker',['kill','--signal','SIGUSR2',container]);retirements.push({container});container=undefined;}
    if(child){const running=child;child=undefined;if(running.exitCode===null){running.kill('SIGUSR2');retirements.push({child:running});}}
    // A retiring generation releases its single claim lock before replacement.
    for(let n=0;n<300;n++){
      if(!await fs.stat(path.join(agent.controlDir,'host-executor/worker.lock')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return;
      await sleep(100);
    }
    throw Error('Native executor retirement timeout');
  };
  const preserveRuns=async job=>{
    if(job.target!=='main')return false;
    const old=await read(path.join((await state(home)).config.packageRoot,'package.json'));
    const candidate=await read(path.join(jobPath(home,job.id),'package/package.json'));
    return old.ezRelease?.runHandoff===1&&candidate.ezRelease?.runHandoff===1&&
      (host.isolation!=='isolated'||(old.ezRelease?.containerExecutor===1&&candidate.ezRelease?.containerExecutor===1));
  };
  const pause=path.join(agent.controlDir,'upgrade-pause.json');
  const refreshRequirement=async job=>{
    if(job.target==='main')return false;
    try {return await brokerNeedsRefresh((await state(home)).config);}
    catch(error) {
      job.status=job.status==='applying'?'recovery-required':'failed';job.error=error.message;
      await atomic(path.join(jobPath(home,job.id),'job.json'),job);
      return null;
    }
  };
  const beat=setInterval(()=>{void atomic(path.join(directory,'supervisor.json'),{pid:process.pid,at:Date.now()}).catch(()=>{});},1000);
  try {
    await atomic(path.join(directory,'supervisor.json'),{pid:process.pid,at:Date.now()});
    try { await cleanupStaleBackups(home); }
    catch(error) { console.error(`Update backup cleanup failed; host remains running: ${error.message}`); }
    // Reclaim only a lock left by this deployment's dead supervisor, including
    // a crash between queue claim and the first transaction journal write.
    const registryLock=path.join(home,'registry.lock'),owner=await read(registryLock).catch(missing);
    if(owner&&prior&&owner.pid===prior.pid)await fs.rm(registryLock);
    // Wait for an orphaned transport's parent-watch to terminate it first.
    await sleep(1200);
    const interrupted=(await jobs(home)).find(j=>j.status==='applying');
    if(interrupted){
      const refreshPluginBroker=await refreshRequirement(interrupted);
      const result=refreshPluginBroker===null?undefined:interrupted.target==='main'
        ? await (async()=>{await atomic(pause,{id:interrupted.id});try{return await locked(home,()=>perform(home,interrupted,{stopHost,startHost}));}finally{await fs.rm(pause,{force:true});}})()
        : await withUpgrade(agent.controlDir,interrupted,signal,()=>perform(home,interrupted,{stopHost,startHost,retireHost,signal,refreshPluginBroker}),{requiresIdle:refreshPluginBroker});
      if(['completed','rolled-back'].includes(result?.status)&&interrupted.target==='main')reloadPending=true;
    }
    const isolated=host.isolation==='isolated'
    if(!child && !container)await startHost((await state(home)).config.packageRoot);
    let nextCheck=0;
    while(!signal.aborted) {
      if(!isolated && child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Host transport exited; supervisor service should restart');
      if(container&&(await execute('docker',['inspect','--format','{{.State.Running}}',container],{stdoutOnly:true})).trim()!=='true')throw Error('Isolated executor exited; supervisor service should restart');
      if(reloadPending&&await idle(agent.controlDir))return;
      // Reap retired containers only after their worker exits.
      for(const item of retirements.filter(r=>r.container)){
        if((await execute('docker',['inspect','--format','{{.State.Running}}',item.container],{stdoutOnly:true})).trim()==='false'){await removeContainer(item.container);retirements=retirements.filter(r=>r!==item);}
      }
      const pending=!reloadPending&&(await jobs(home)).find(j=>j.status==='queued');
      if(pending) {
        const refreshPluginBroker=await refreshRequirement(pending);
        if(refreshPluginBroker===null)continue;
        const preserve=await preserveRuns(pending);
        const apply=async()=>{
          try {
            const activate=async()=>{const latest=await read(path.join(jobPath(home,pending.id),'job.json'));return perform(home,latest,{stopHost,startHost,retireHost,signal,refreshPluginBroker,preserveRuns:preserve});};
            return pending.target==='main'&&!preserve?await locked(home,activate,{drainInvocations:true,signal}):await activate();
          } catch(error) {
            // A pre-switch rejection is terminal. Applying jobs keep their journal for recovery.
            const latest=await read(path.join(jobPath(home,pending.id),'job.json'));
            if(latest.status==='queued'){latest.status='failed';latest.error=error.message;await atomic(path.join(jobPath(home,pending.id),'job.json'),latest);}else throw error;
          }
        };
        const result=await withUpgrade(agent.controlDir,pending,signal,apply,{requiresIdle:refreshPluginBroker,preserveRuns:preserve});
        if(['completed','rolled-back'].includes(result?.status)) {
          if(pending.target==='main')reloadPending=true;
          nextCheck=0;
        }
      }
      if(Date.now()>=nextCheck) {
        nextCheck=Date.now()+6*60*60*1000;
        try {
          const results=await discover(home);await atomic(path.join(directory,'available.json'),results);
          await queueAutomatic(home,results);
        } catch {
          // Discovery is optional; its failure must not terminate the host.
          // Do not expose registry response bodies or credentials in logs.
          console.error('Update discovery failed; host remains running. Inspect ez updates check.');
        }
      }
      await sleep(500);
    }
  }finally {
    clearInterval(beat);await stopHost();
    for(const item of retirements){if(item.container){await execute('docker',['stop','--time','10',item.container]);await removeContainer(item.container);}else if(item.child.exitCode===null)item.child.kill('SIGTERM');}await fs.rm(lock,{force:true});
    if(!(await jobs(home)).some(j=>j.status==='applying'))await fs.rm(pause,{force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const abort=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>abort.abort());
  await supervise(process.argv[2],abort.signal);
}
