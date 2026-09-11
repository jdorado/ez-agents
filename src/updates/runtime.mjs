import { sharedIdentity } from '../plugins/shared.mjs';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, compose, snapshot, checkFolders } from '../plugins/manager.mjs';
import { read, state, eligibility, jobPath } from './control.mjs';
import { bindUpdates } from './binding.mjs';
import { extract, digest } from './artifact.mjs';

export function environment() {
  return Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','BUILDX_CONFIG'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
}
export function execute(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:environment(),stdio:['ignore','pipe','pipe']});let output='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),options.timeout||600000);
    const file=options.outputFile?createWriteStream(options.outputFile,{flags:'wx',mode:0o600}):null;
    const written=file?new Promise((resolve,reject)=>{file.once('finish',resolve);file.once('error',reject);}):Promise.resolve();
    if(file)child.stdout.pipe(file);else child.stdout.on('data',b=>{output=(output+b).slice(-16000);});
    child.stderr.on('data',b=>{output=(output+b).slice(-16000);});
    void written.catch(()=>child.kill('SIGKILL'));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',async code=>{clearTimeout(timer);try{await written;if(code!==0)throw Error(`${command} failed (${code}): ${output}`);resolve(output);}catch(error){reject(error);}});
  });
}
export async function textAtomic(file,text) {
  const tmp=file+'.update.tmp';await fs.writeFile(tmp,text,{mode:0o600});await fs.rename(tmp,file);
}
export const pluginArgs = record => ['compose','--project-name',record.project,'--file',record.compose];
export async function packageManager(root,run=execute) {
  const {packageManager:required}=await read(path.join(root,'package.json'));
  if(typeof required!=='string'||!/^pnpm@\d+\.\d+\.\d+$/.test(required))throw Error('Upgrade requires an exact pnpm version in package.json');
  const expected=required.slice(5),failures=[];
  // Corepack can run the pinned manager directly without a global pnpm shim.
  for(const [command,args] of [['pnpm',[]],['corepack',[required]]]) {
    try {
      const actual=(await run(command,[...args,'--version'],{cwd:root,timeout:120000})).trim();
      if(actual!==expected)throw Error(`expected ${expected}, received ${actual}`);
      return {command,args,version:actual};
    }catch(error){failures.push(`${command}: ${error.message}`);}
  }
  throw Error(`Upgrade prerequisite unavailable: ${required}. ${failures.join('; ')}. Check the host supervisor service PATH (shell aliases do not count). Reuse its installed pnpm or Corepack; expose the launcher directory to that service and restart it after the current turn. If neither exists, provision the pinned manager first. Do not substitute npm install or reinstall the agent. After repair, prepare/apply a new job when status is failed; recover is only for recovery-required.`);
}
export const relayArgs = config => ['compose','--env-file',path.join(config.deploymentDir,'docker.env')];
const healthCodes = new Set(['RELAY_UNREADABLE','RELAY_NOT_POLLING','RELAY_STALE','HOST_UNREADABLE','HOST_STALE']);
async function healthEvidence(config,run) {
  const id=(await run('docker',[...relayArgs(config),'ps','-q','relay'])).trim();
  if(!/^[a-f0-9]{12,64}$/i.test(id))return '';
  const raw=await run('docker',['inspect','--format','{{json .State.Health}}',id]);
  const health=JSON.parse(raw),entry=health?.Log?.at(-1),match=typeof entry?.Output==='string'&&entry.Output.match(/^EZ_HEALTH_([A-Z_]+)\s*$/);
  return match&&healthCodes.has(match[1])?` (health=${match[1].toLowerCase().replaceAll('_','-')})`:'';
}
function envValue(text,key,value) {
  if(/[\r\n\0']/.test(value))throw Error('Unsafe deployment value');
  const line=`${key}='${value}'`;
  return new RegExp(`^${key}=.*$`,'m').test(text)?text.replace(new RegExp(`^${key}=.*$`,'m'),()=>line):text+'\n'+line+'\n';
}
async function backupVolume(run,record,name,directory) {
  const services=Object.entries(record.deployment.services),service=services.find(([,s])=>s.volumes?.[name])?.[0];
  const c=compose({workspace:'/unused'},record),image=c.services[service].image;
  // No writable profile mount, network, Docker socket, provider command or secrets.
  const found=(await run('docker',['volume','ls','--format','{{.Name}}','--filter',`name=^${record.project}_${name}$`])).trim();
  if(!found)return; // Installed but never started: no profile exists yet.
  const actual=JSON.parse(await run('docker',['volume','inspect',`${record.project}_${name}`]))[0];
  if(actual.Name!==`${record.project}_${name}`)throw Error('Volume identity mismatch');
  await run('docker',['run','--rm','--network','none','--user','0:0','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges',
    '--mount',`type=volume,source=${actual.Name},target=/data,readonly`,
    '--entrypoint','tar',image,'-cf','-','-C','/data','.'],{outputFile:path.join(directory,name+'.tar')});

}
// Interruptible work is journaled before any running installation is touched.
// On restart, recovery restores code/config only, never provider journals.
export async function perform(home,job,hooks) {
  const run=hooks.execute||execute,{config}=await state(home),dir=jobPath(home,job.id),file=path.join(dir,'job.json');
  const save=()=>atomic(file,job);
  if(job.status==='applying'||job.recoveryRequested)return recover(home,job,hooks);
  if(job.status!=='queued')throw Error('Job is not queued');
  const archive=await fs.readFile(path.join(dir,'candidate.tgz'));
  if(digest(archive)!==job.sha256)throw Error('Candidate archive changed');
  // Re-extract from verified bytes, never execute a mutable preparation tree.
  const root=path.join(dir,'runtime');await fs.rm(root,{recursive:true,force:true});await extract(archive,root);
  const next=await eligibility(home,job.target,root,job.automatic);
  if(next.old.root!==job.previousRoot||next.old.pkg.version!==job.previousVersion)throw Error('Stale upgrade job');
  job.status='applying';job.root=root;job.startedAt=new Date().toISOString();await save();
  try {
    if(job.target==='main') {
      job.packageManager=await packageManager(root,run);await save();
      await fs.copyFile(path.join(root,'docker/pnpm-lock.yaml'),path.join(root,'pnpm-lock.yaml'));
      await run(job.packageManager.command,[...job.packageManager.args,'install','--frozen-lockfile','--ignore-scripts'],{cwd:root});
      await run(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'bin/ezenciel-agents.mjs'),'--version'],{cwd:root});
      const image=`ez-upgrade-${job.sha256.slice(0,24)}`;
      await run('docker',['build','--target','runtime','-t',image,root]);
      const envFile=path.join(config.deploymentDir,'docker.env'),oldEnv=await fs.readFile(envFile,'utf8');
      const cid=(await run('docker',[...relayArgs(config),'ps','-q','relay'])).trim();
      if(!cid||/\s/.test(cid))throw Error('Expected one running relay');
      const oldImage=(await run('docker',['inspect','--format','{{.Image}}',cid])).trim();
      if(!/^sha256:[a-f0-9]{64}$/.test(oldImage))throw Error('Cannot pin rollback image');
      job.rollback={env:envValue(oldEnv,'EZ_RELAY_IMAGE',oldImage),packageRoot:config.packageRoot};await save();
      await run('docker',[...relayArgs(config),'stop','relay']);await hooks.stopHost();
      const backup=path.join(dir,'backup');await fs.mkdir(backup,{mode:0o700});
      for(const name of ['mind','control'])await fs.cp(path.join(config.deploymentDir,name),path.join(backup,name),{recursive:true});
      for(const name of ['docker.env','host-executor.json','agent.json','purpose.md','relay.env'])await fs.copyFile(path.join(config.deploymentDir,name),path.join(backup,name));
      let env=oldEnv.split(job.previousRoot+path.sep).join(root+path.sep);env=envValue(env,'EZ_RELAY_IMAGE',image);
      await textAtomic(envFile,env);
      await bindUpdates(home,path.join(config.deploymentDir,'host-executor.json'),root);
      await hooks.startHost(root);
      await run('docker',[...relayArgs(config),'up','-d','--wait','--wait-timeout','90','--no-build','relay']);
    } else {
      const old=next.old.record,r=await read(path.join(home,'registry.json'));
      const secrets=await read(path.join(home,'packages',job.target,'secrets.json')).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
      const s=await snapshot(root),candidate={...old,source:root,revision:s.revision,manifest:s.manifest,deployment:s.deployment,sharedRevisions:s.sharedRevisions};
      for (const key of old.sharedEnabled || []) if (sharedIdentity(old, key).fingerprint !== sharedIdentity(candidate, key).fingerprint) throw Error('Shared worker changed; disable this client and coordinate an explicit shared worker upgrade before updating');
      await checkFolders(config,candidate);
      const stage={...candidate,compose:path.join(dir,'compose.json')};await atomic(stage.compose,compose(config,stage,secrets));
      for(const [service,spec] of Object.entries(stage.deployment.services))await run('docker',[...pluginArgs(stage),spec.image?'pull':'build',service]);
      const running=Boolean((await run('docker',[...pluginArgs(old),'ps','-q'])).trim());
      job.rollback={record:old,registry:r,compose:await read(old.compose),running};await save();
      await run('docker',[...pluginArgs(old),'stop']);
      const backup=path.join(dir,'backup');await fs.mkdir(backup,{mode:0o700});
      const volumes=new Set(Object.values(old.deployment.services).flatMap(s=>Object.keys(s.volumes||{})));
      for(const name of volumes)await backupVolume(run,old,name,backup);
      await atomic(old.compose,compose(config,candidate,secrets));
      if(running)await run('docker',[...pluginArgs(candidate),'up','-d','--wait','--wait-timeout','90','--no-build']);
      r.plugins[job.target]=candidate;await atomic(path.join(home,'registry.json'),r);
      job.runtimeVerified=running;
    }
    job.status='completed';job.endedAt=new Date().toISOString();await save();return job;
  }catch(error){
    let message=error.message;
    if(job.target==='main'&&job.rollback&&/is unhealthy/.test(message))message+=await healthEvidence(config,run).catch(()=> '');
    job.error=message;await save();return recover(home,job,hooks);
  }
}
export async function recover(home,job,hooks) {
  const run=hooks.execute||execute,{config}=await state(home);
  try {
    if(job.rollback) {
      if(job.target==='main') {
        await run('docker',[...relayArgs(config),'stop','relay']);await hooks.stopHost();
        await textAtomic(path.join(config.deploymentDir,'docker.env'),job.rollback.env);
        await bindUpdates(home,path.join(config.deploymentDir,'host-executor.json'),job.rollback.packageRoot);
        await hooks.startHost(job.rollback.packageRoot);
        await run('docker',[...relayArgs(config),'up','-d','--wait','--wait-timeout','90','--no-build','relay']);
      } else {
        const b=job.rollback;
        await run('docker',[...pluginArgs(b.record),'stop']);
        await atomic(b.record.compose,b.compose);await atomic(path.join(home,'registry.json'),b.registry);
        if(b.running)await run('docker',[...pluginArgs(b.record),'up','-d','--wait','--wait-timeout','90','--no-build']);
      }
      job.status='rolled-back';
    }else job.status='failed';
  }catch(error){job.status='recovery-required';job.recoveryError=error.message;}
  job.endedAt=new Date().toISOString();await atomic(path.join(jobPath(home,job.id),'job.json'),job);return job;
}
