import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomic, locked } from '../plugins/manager.mjs';
import { state, read, jobs, jobPath, check, missing } from './control.mjs';
import { perform, environment } from './runtime.mjs';
import { digest } from './artifact.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function idle(control) {
  const host=await fs.readdir(path.join(control,'host-executor')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  if(host.some(f=>f.endsWith('.running.json')||f.endsWith('.request.json')))return false;
  for(const file of await fs.readdir(path.join(control,'runs')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
    if(file.endsWith('.json')&&(await read(path.join(control,'runs',file))).status==='running')return false;
  }
  return true;
}
export async function notice(control,key) {
  await atomic(path.join(control,'update-attention.json'),{id:digest(key)});
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
  let child;
  const stopHost=async()=>{
    if(!child)return;const running=child;child=undefined;
    if(running.exitCode!==null)return;
    const closed=new Promise(resolve=>running.once('close',resolve));running.kill('SIGTERM');
    const timer=setTimeout(()=>running.kill('SIGKILL'),10000);await closed;clearTimeout(timer);
  };
  const startHost=async root=>{
    child=spawn(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'src/host-executor.ts'),path.join(deployment,'host-executor.json')],
      {env:{...environment(),EZ_HOST_SUPERVISOR_PID:String(process.pid)},stdio:['ignore','inherit','inherit']});
    let error;child.once('error',e=>{error=e;});
    for(let n=0;n<100;n++) {
      if(error||child.exitCode!==null)throw error||Error('Host transport failed to start');
      const beat=await read(path.join(agent.controlDir,'host-executor/heartbeat.json')).catch(missing);
      if(beat?.pid===child.pid&&Date.now()-beat.at<10000)return;
      await sleep(100);
    }
    throw Error('Host transport heartbeat timeout');
  };
  const pause=path.join(agent.controlDir,'upgrade-pause.json');
  const beat=setInterval(()=>{void atomic(path.join(directory,'supervisor.json'),{pid:process.pid,at:Date.now()}).catch(()=>{});},1000);
  try {
    await atomic(path.join(directory,'supervisor.json'),{pid:process.pid,at:Date.now()});
    // Reclaim only a lock left by this deployment's dead supervisor, including
    // a crash between queue claim and the first transaction journal write.
    const registryLock=path.join(home,'registry.lock'),owner=await read(registryLock).catch(missing);
    if(owner&&prior&&owner.pid===prior.pid)await fs.rm(registryLock);
    // Wait for an orphaned transport's parent-watch to terminate it first.
    await sleep(1200);
    const interrupted=(await jobs(home)).find(j=>j.status==='applying');
    if(interrupted){
      await atomic(pause,{id:interrupted.id});await locked(home,()=>perform(home,interrupted,{stopHost,startHost}));await fs.rm(pause,{force:true});await notice(agent.controlDir,interrupted.id);}
    if(!child)await startHost((await state(home)).config.packageRoot);
    let nextCheck=0;
    while(!signal.aborted) {
      if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Host transport exited; supervisor service should restart');
      const pending=(await jobs(home)).find(j=>j.status==='queued');
      if(pending) {
        await atomic(pause,{id:pending.id});
        // Relay admission is paused; drain the requesting turn and any already-claimed job.
        let quiet=0;
        while(!signal.aborted&&quiet<3){quiet=await idle(agent.controlDir)?quiet+1:0;await sleep(500);}
        if(signal.aborted)break;
        try {
          await locked(home,async()=>{const latest=await read(path.join(jobPath(home,pending.id),'job.json'));await perform(home,latest,{stopHost,startHost});});
        } catch(error) {
          // A pre-switch rejection is terminal. Applying jobs keep their journal for recovery.
          const latest=await read(path.join(jobPath(home,pending.id),'job.json'));
          if(latest.status==='queued'){latest.status='failed';latest.error=error.message;await atomic(path.join(jobPath(home,pending.id),'job.json'),latest);}else throw error;
        } finally {await fs.rm(pause,{force:true});}
        await notice(agent.controlDir,pending.id);
      }
      if(Date.now()>=nextCheck) {
        nextCheck=Date.now()+6*60*60*1000;
        const results=await discover(home);await atomic(path.join(directory,'available.json'),results);
        const available=results.filter(r=>r.newer&&r.policy.automatic);
        const key=digest(JSON.stringify(available)),saved=await read(path.join(directory,'discovery.json')).catch(missing);
        if(available.length&&saved?.key!==key){await notice(agent.controlDir,key);await atomic(path.join(directory,'discovery.json'),{key});}
      }
      await sleep(500);
    }
  }finally {
    clearInterval(beat);await stopHost();await fs.rm(lock,{force:true});
    if(!(await jobs(home)).some(j=>j.status==='applying'))await fs.rm(pause,{force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const abort=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>abort.abort());
  await supervise(process.argv[2],abort.signal);
}
