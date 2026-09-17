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

// Called only after host startup checked/recovered all previous native processes.
export async function recoverNativeLease(home) {
  const file=path.join(home,'workspace-writer.lock');let prior;
  try {prior=await leaseOwner(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(prior.alive)return;
  if(prior.owner.kind!=='native')throw Error('Stale plugin workspace-writer.lock: verify command containers stopped, then remove the lock and restart');
  if(await fs.readFile(file,'utf8')!==prior.raw)throw Error('Workspace lease changed during recovery');
  await fs.rm(file);
}

export async function workspaceLease(home,owner={kind:'plugin'}) {
  const file=path.join(home,'workspace-writer.lock'),temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify({...owner,pid:process.pid}),{flag:'wx',mode:0o600});
  try {await fs.link(temp,file);}catch(error){if(error.code!=='EEXIST')throw error;const prior=await leaseOwner(file);if(!prior.alive)throw Error('Stale workspace-writer.lock: inspect stopped owner and command containers, then restart for recovery');return undefined;}
  finally {await fs.rm(temp);}
  return async()=>{await fs.rm(file);};
}

export async function invokeLease(home) {
  const release=await workspaceLease(home);if(!release)throw Error('Agent workspace is busy');
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
