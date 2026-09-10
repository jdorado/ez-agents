import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, locked, snapshot } from '../plugins/manager.mjs';
import { digest, extract, newer, compatible, version, releaseContract, registryVersion, download } from './artifact.mjs';

export const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
export const missing = error => {if(error.code!=='ENOENT')throw error;return null;};
export const targetId = value => {if(value!=='main'&&!/^[a-z][a-z0-9-]{0,39}$/.test(value))throw Error('Invalid update target');return value;};
export const updateHome = home => path.join(home,'updates');
export async function state(home) {
  const config=await read(path.join(home,'config.json'));
  if(!config.deploymentDir||!path.isAbsolute(config.deploymentDir)||!path.isAbsolute(config.packageRoot||''))throw Error('Updates require a deployment-bound registry initialized by this release');
  const host=await read(path.join(config.deploymentDir,'host-executor.json'));
  if(host.agents.length!==1||host.agents[0].toolsHome!==home||host.agents[0].workspace!==config.workspace)throw Error('Update binding mismatch (one deployment per supervisor required)');
  return {config,agent:host.agents[0],directory:updateHome(home)};
}
export async function installed(home,target) {
  targetId(target);const {config}=await state(home);
  const record=target==='main'?null:(await read(path.join(home,'registry.json'))).plugins[target];
  if(target!=='main'&&!record)throw Error('Plugin is not installed; updates never reinstall removed plugins');
  const root=record?.source||config.packageRoot,pkg=await read(path.join(root,'package.json'));
  return {root,pkg,record};
}
export async function policy(home,target) {
  targetId(target);const all=await read(path.join(updateHome(home),'policy.json')).catch(missing)||{};
  const p=all[target]||{automatic:true,channel:'beta'};
  if(typeof p.automatic!=='boolean'||!['stable','beta'].includes(p.channel))throw Error('Invalid update policy');
  return p;
}
export async function check(home) {
  await state(home);const registry=await read(path.join(home,'registry.json')),results=[];
  for(const target of ['main',...Object.keys(registry.plugins)]) {
    try {
      const old=await installed(home,target),p=await policy(home,target);
      const candidate=await registryVersion(old.pkg.name,p.channel==='stable'?'latest':'beta');
      results.push({target,installed:old.pkg.version,available:candidate.version,newer:newer(candidate.version,old.pkg.version),policy:p,package:candidate.name});
    }catch(error){results.push({target,error:error.message});}
  }
  return results;
}
export async function eligibility(home,target,root,automatic) {
  const old=await installed(home,target),pkg=await read(path.join(root,'package.json')),kind=target==='main'?'main':'plugin';
  if(pkg.name!==old.pkg.name)throw Error('Package identity mismatch');
  const next=releaseContract(pkg,kind),prior=releaseContract(old.pkg,kind);
  if(next.stateSchema!==prior.stateSchema)throw Error('State migration is unsupported by this updater; do not replace the installation');
  if(!newer(pkg.version,old.pkg.version))throw Error('Candidate must be newer than the installed version');
  let revision;
  if(kind==='plugin') {
    const s=await snapshot(root);revision=s.revision;
    if(s.manifest.id!==target||s.manifest.version!==pkg.version)throw Error('Plugin identity/version mismatch');
    if(JSON.stringify(s.deployment)!==JSON.stringify(old.record.deployment))throw Error('Deployment permissions/layout changed; a separately reviewed migration is required');
  }else {
    for(const file of ['compose.yaml','compose.whatsapp.yaml'])if(!Buffer.from(await fs.readFile(path.join(root,file))).equals(await fs.readFile(path.join(old.root,file))))throw Error('Runtime deployment changed; a separately reviewed migration is required');
  }
  if(automatic) {
    const p=await policy(home,target);
    if(!p.automatic||!compatible(pkg.version,old.pkg.version)||(p.channel==='stable'&&version(pkg.version).pre))throw Error('Candidate is outside automatic update policy');
  }
  return {old,pkg,revision};
}
export async function prepare(home,target,{file,release}) {
  targetId(target);if(Boolean(file)===Boolean(release))throw Error('Supply one --file tarball or --version exact-version');
  const {directory}=await state(home);await fs.mkdir(directory,{recursive:true,mode:0o700});
  const old=await installed(home,target);
  let data,origin;
  if(file){data=await fs.readFile(file);origin={type:'local'};}
  else {version(release);const pkg=await registryVersion(old.pkg.name,release);data=await download(pkg);origin={type:'npm',name:pkg.name,version:pkg.version,integrity:pkg.dist.integrity};}
  const id=randomUUID(),dir=path.join(directory,id),root=path.join(dir,'package');await fs.mkdir(dir,{mode:0o700});
  try {
    await extract(data,root);
    const next=await eligibility(home,target,root,false);
    if(origin.type==='npm'&&next.pkg.version!==origin.version)throw Error('Artifact version differs from registry metadata');
    await fs.writeFile(path.join(dir,'candidate.tgz'),data,{mode:0o600,flag:'wx'});
    const job={id,target,source:root,releaseNotes:path.join(root,'CHANGELOG.md'),status:'prepared',version:next.pkg.version,previousVersion:next.old.pkg.version,previousRoot:next.old.root,sha256:digest(data),origin,createdAt:new Date().toISOString()};
    await atomic(path.join(dir,'job.json'),job);return job;
  } catch(error){await fs.rm(dir,{recursive:true,force:true});throw error;}
}
export function jobPath(home,id) {
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('Invalid upgrade job ID');
  return path.join(updateHome(home),id);
}
export async function jobs(home) {
  const entries=await fs.readdir(updateHome(home),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return Promise.all(entries.filter(e=>e.isDirectory()&&/^[a-f0-9-]{36}$/.test(e.name)).map(e=>read(path.join(jobPath(home,e.name),'job.json'))));
}
async function requireSupervisor(directory) {
  const h=await read(path.join(directory,'supervisor.json'));
  if(!Number.isFinite(h.at)||Date.now()-h.at>10000||h.at>Date.now()+5000)throw Error('Upgrade supervisor is offline or heartbeat is invalid');
}
export async function submit(home,id,automatic) {
  const {directory}=await state(home),dir=jobPath(home,id);
  return locked(home,async()=>{
    const job=await read(path.join(dir,'job.json'));
    if(job.status!=='prepared')throw Error('Job is not prepared');
    if((await jobs(home)).some(j=>['queued','applying','recovery-required'].includes(j.status)))throw Error('An upgrade is already pending');
    await requireSupervisor(directory);
    if(automatic&&job.origin.type!=='npm')throw Error('Local candidates require an explicit upgrade request');
    const next=await eligibility(home,job.target,path.join(dir,'package'),automatic);
    if(next.old.root!==job.previousRoot||next.old.pkg.version!==job.previousVersion)throw Error('Installation changed since preparation');
    if(digest(await fs.readFile(path.join(dir,'candidate.tgz')))!==job.sha256)throw Error('Candidate changed');
    job.status='queued';job.automatic=automatic;await atomic(path.join(dir,'job.json'),job);return job;
  });
}
export async function retryRecovery(home,id) {
  const {directory}=await state(home),dir=jobPath(home,id);
  return locked(home,async()=>{
    const job=await read(path.join(dir,'job.json'));
    if(job.status!=='recovery-required'||!job.rollback)throw Error('Job has no pending recovery');
    if((await jobs(home)).some(j=>['queued','applying'].includes(j.status)))throw Error('An upgrade is already pending');
    await requireSupervisor(directory);
    job.status='queued';job.recoveryRequested=true;await atomic(path.join(dir,'job.json'),job);return {id,status:job.status,recoveryRequested:true};
  });
}
export async function command(home,args) {
  const [action,...rest]=args;
  if(!action||action==='--help')return {commands:['check','policy [main|plugin-id] [stable|beta|manual]','prepare <target> --file /absolute/candidate.tgz | --version X.Y.Z','apply <job-id> [--automatic]','recover <job-id>','status'],note:'apply queues a durable job. Finish this turn; the host performs replacement after work drains. Do not wait in the requesting turn.'};
  if(action==='recover'&&rest.length===1)return retryRecovery(home,rest[0]);
  if(action==='check'&&!rest.length)return check(home);
  if(action==='status'&&!rest.length)return (await import('./status.mjs')).status(home);
  if(action==='policy') {
    const [target='main',choice]=rest;targetId(target);await state(home);
    if(rest.length>2)throw Error('Unknown policy arguments');
    if(!choice)return policy(home,target);
    if(!['stable','beta','manual'].includes(choice))throw Error('Use stable, beta or manual');
    return locked(home,async()=>{const file=path.join(updateHome(home),'policy.json'),all=await read(file).catch(missing)||{};all[target]={automatic:choice!=='manual',channel:choice==='beta'?'beta':'stable'};await atomic(file,all);return all[target];});
  }
  if(action==='prepare'&&rest.length===3&&['--file','--version'].includes(rest[1]))return prepare(home,rest[0],{file:rest[1]==='--file'?rest[2]:undefined,release:rest[1]==='--version'?rest[2]:undefined});
  if(action==='apply'&&(rest.length===1||rest.length===2&&rest[1]==='--automatic'))return submit(home,rest[0],rest[1]==='--automatic');
  throw Error('Unknown updates arguments; use updates --help');
}
