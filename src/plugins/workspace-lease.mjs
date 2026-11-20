import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function leaseOwner(file) {
  const raw=await fs.readFile(file,'utf8');let owner;
  try {owner=JSON.parse(raw);}catch{throw Error('Invalid workspace-writer.lock; inspect and recover before restarting');}
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid workspace-writer.lock owner; inspect before restarting');
  let alive=true;try {process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  return {owner,raw,alive};
}

// A plugin lease names its command container. Its owner process can die while
// the container still writes the workspace, so the lease is stale only once
// Docker no longer knows that container (`run --rm` removes it on exit), and
// only after the window in which an orphaned `compose run` may still create it.
const createWindowMs=20000;
async function pluginContainerGone(owner,file) {
  if(owner.kind!=='plugin'||typeof owner.container!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(owner.container))return false;
  const info=await fs.stat(file).catch(()=>null);
  if(!info)return false;
  if(Date.now()-info.mtimeMs<createWindowMs)return 'young';
  const {run}=await import('./manager.mjs');
  const state=await run(['container','inspect','--format','{{.State.Running}}',owner.container],{capture:true});
  return state.code!==0&&/No such (?:object|container)/i.test(state.stderr+state.stdout)?'gone':false;
}

// Called only after host startup checked/recovered all previous native processes.
export async function recoverNativeLease(home) {
  const file=path.join(home,'workspace-writer.lock');let prior;
  try {prior=await leaseOwner(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(prior.alive)return;
  if(prior.owner.kind!=='native') {
    const container=await pluginContainerGone(prior.owner,file);
    // Inside the create window the claim pass reclaims it later; the lease stays meanwhile.
    if(container==='young')return;
    if(container!=='gone')throw Error('Stale plugin workspace-writer.lock: verify command containers stopped, then remove the lock and restart');
  }
  if(await fs.readFile(file,'utf8')!==prior.raw)throw Error('Workspace lease changed during recovery');
  await fs.rm(file);
}

export async function workspaceLease(home,owner={kind:'plugin'}) {
  const file=path.join(home,'workspace-writer.lock'),temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify({...owner,pid:process.pid}),{flag:'wx',mode:0o600});
  try {
    for(let attempt=0;;attempt++) {
      try {await fs.link(temp,file);break;}catch(error){if(error.code!=='EEXIST')throw error;let prior;try {prior=await leaseOwner(file);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}
        const container=!prior.alive&&attempt===0?await pluginContainerGone(prior.owner,file):false;
        if(container==='gone'&&await fs.readFile(file,'utf8').catch(()=>null)===prior.raw){await fs.rm(file,{force:true});continue;}
        // A dead holder's command container may still be created: busy for now, reclaimable after the window.
        if(container==='young')return undefined;
        if(!prior.alive)throw Error('Stale workspace-writer.lock: inspect stopped owner and command containers, then restart for recovery');if(owner.kind==='native'&&prior.owner.kind==='native')return async()=>{};return undefined;}
    }
  }
  finally {await fs.rm(temp);}
  return async()=>{await fs.rm(file);};
}

export async function invokeLease(home,container) {
  const release=await workspaceLease(home,{kind:'plugin',container});if(!release)throw Error('Agent workspace is busy');
  try {
    const config=JSON.parse(await fs.readFile(path.join(home,'config.json'),'utf8'));
    if(config.hostConfig){
      const host=JSON.parse(await fs.readFile(config.hostConfig,'utf8'));
      const agents=host.agents.filter(a=>a.toolsHome===home&&a.workspace===config.workspace);
      if(agents.length!==1)throw Error('Invalid agent workspace binding');
      const files=await fs.readdir(path.join(agents[0].controlDir,'host-executor'));
      if(files.some(f=>f.endsWith('.request.json')||f.endsWith('.running.json')))throw Error('Agent has pending or running work');
    }
    return release;
  }catch(error){await release();throw error;}
}
