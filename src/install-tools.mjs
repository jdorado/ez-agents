import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { callDeliverySocket } from './delivery-socket-client.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const absent=e=>{if(e.code!=='ENOENT')throw e;return null;};
export const hostEnvironment=()=>Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','BUILDX_CONFIG'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
async function atomic(file,value) {
  const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await fs.rename(tmp,file);
}
export function run(command,args,{cwd,log,timeout=15000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:hostEnvironment(),stdio:['ignore',log??'pipe',log??'pipe']});let output='';
    for(const stream of [child.stdout,child.stderr])stream?.on('data',b=>output=(output+b).slice(-200000));
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(`${command} failed (${code})${log===undefined?': '+output.trim():''}`));else resolve(output.trim());});
  });
}
export const defaultHome=()=>path.join(process.env.XDG_DATA_HOME||path.join(homedir(),'.local/share'),'ez');
export async function executable(value) {
  if(!value||value.includes('\0'))throw Error('Supply the selected executor name or absolute path');
  const candidates=path.isAbsolute(value)?[value]:value.includes('/')?[]:(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,value));
  for(const candidate of candidates)try{await fs.access(candidate,fs.constants.X_OK);if((await fs.stat(candidate)).isFile())return path.resolve(candidate);}catch(e){if(!['ENOENT','EACCES'].includes(e.code))throw e;}
  throw Error('Selected executor is not executable');
}
export async function preflight({home=defaultHome(),executor},invoke=run) {
  const checks=[];
  const check=async(name,fn)=>{try{checks.push({name,ok:true,...await fn()});}catch(e){checks.push({name,ok:false,error:e.message});}};
  await check('node',async()=>{if(Number(process.versions.node.split('.')[0])<22)throw Error('Provision Node 22+ on the host');return {version:process.versions.node};});
  const pkg=await read(path.join(root,'package.json'));
  await check('pnpm',async()=>{const expected=pkg.packageManager.split('@').at(-1),actual=await invoke('pnpm',['--version']);if(actual!==expected)throw Error(`Provision pnpm ${expected}; found ${actual}`);return {version:actual};});
  await check('docker',async()=>({version:await invoke('docker',['version','--format','{{.Server.Version}}'])}));
  await check('compose',async()=>({version:await invoke('docker',['compose','version','--short'])}));
  await check('disk',async()=>{let parent=path.resolve(home);while(!(await fs.stat(parent).catch(absent))){const next=path.dirname(parent);if(next===parent)throw Error('No existing installation parent');parent=next;}const s=await fs.statfs(parent),freeBytes=s.bavail*s.bsize;return {path:parent,freeBytes,note:'Host filesystem only; inspect Docker storage separately. Required space depends on image cache and plugins.'};});
  await check('executor',async()=>{const binary=await executable(executor);return {path:binary,command:path.basename(binary),version:await invoke(binary,['--version']),sandboxVerified:false,note:'Validate identity and a harmless tool call under the actual service environment before registering the supported executor key.'};});
  return {ok:checks.every(c=>c.ok),home:path.resolve(home),packages:path.join(path.resolve(home),'packages'),agents:path.join(path.resolve(home),'agents'),checks};
}
export async function installationStatus(deployment) {
  if(!path.isAbsolute(deployment||''))throw Error('Supply --deployment with an absolute path');
  const control=path.join(deployment,'control');
  const exists=async f=>Boolean(await fs.stat(path.join(deployment,f)).catch(absent));
  const configured=(await Promise.all(['agent.json','host-executor.json','docker.env','relay.env'].map(exists))).every(Boolean);
  const owner=(await read(path.join(control,'control-state.json')).catch(absent))?.owner;
  const paired=Boolean(owner&&Number.isSafeInteger(owner.telegramUserId)&&owner.telegramUserId>0&&Number.isSafeInteger(owner.telegramChatId)&&(owner.kind==='group'?owner.telegramChatId<0:owner.kind===undefined&&owner.telegramChatId>0)&&Number.isFinite(Date.parse(owner.pairedAt)));
  const relay=await read(path.join(control,'heartbeat.json')).catch(absent),host=await read(path.join(control,'host-executor/heartbeat.json')).catch(absent);
  const fresh=(h,ms)=>Boolean(h&&Number.isFinite(h.at)&&h.at<=Date.now()+1000&&Date.now()-h.at<ms);
  let isolated=false;
  try { isolated=(await read(path.join(deployment,'agent.json'))).isolation==='isolated'; } catch { isolated=false; }
  const runtimeReady=Boolean(relay?.polling&&fresh(relay,20000)&&(isolated||fresh(host,15000)));
  // Delivery receipts live in relay memory and are re-authorized server-side;
  // ask the running relay. A restart drops receipts by design.
  let reply=null;
  if(paired)reply=(await callDeliverySocket(path.join(control,'delivery.sock'),{op:'latestReply'},2000).catch(()=>null))?.reply??null;
  return {deployment,configured,runtimeReady,ownerPaired:paired,telegramReplyVerified:Boolean(reply),reply,
    stage:!configured?'not-configured':!runtimeReady?'runtime-offline':!paired?'awaiting-owner':!reply?'awaiting-telegram-reply':'ready-for-telegram-plugin-request',
    note:'Read-only: a live receipt from the running relay is delivery evidence; it is not retained across a relay restart. Request plugins through the working Telegram conversation.'};
}
async function fingerprintOf(source,invoke) {
  const listing=JSON.parse(await invoke('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:source}));
  const hash=createHash('sha256');
  for(const f of listing[0].files){const file=path.resolve(source,f.path);if(!file.startsWith(source+path.sep))throw Error('Invalid package path');const data=await fs.readFile(file);hash.update(JSON.stringify([f.path,f.mode,data.length]));hash.update(data);}
  return hash.digest('hex');
}
// Source-checkout builds are RCs. The reviewed commit is the only SHA that may
// label an installable image, so a dirty tree can never become one and /status
// never falls back to the bare package version on a deployment.
export const rcLabel = /^\d+\.\d+\.\d+-beta\.\d+\.rc\.[1-9]\d*$/;
async function buildIdentity(source,label,invoke) {
  const git=async args=>{try{return await invoke('git',['-C',source,...args]);}catch{return undefined;}};
  if(await git(['rev-parse','--is-inside-work-tree'])!=='true') {
    if(label!==undefined)throw Error('--label requires a git checkout so the RC pins the reviewed commit');
    return {};
  }
  if(label===undefined)throw Error('A source checkout requires --label X.Y.Z-beta.N.rc.M; commit, push and open the PR first');
  if(!rcLabel.test(label))throw Error('RC label must look like X.Y.Z-beta.N.rc.M');
  if((await git(['status','--porcelain']))!=='')throw Error('Commit the reviewed source before an RC build; uncommitted work cannot be installed as an RC');
  const sha=await git(['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('RC builds require the reviewed commit SHA');
  return {label,sha};
}
export async function build({home=defaultHome(),source=root,label},invoke=run) {
  source=await fs.realpath(source);
  const identity=await buildIdentity(source,label,invoke);
  const fingerprint=await fingerprintOf(source,invoke);
  const artifact=createHash('sha256').update(JSON.stringify([fingerprint,identity.label??'',identity.sha??''])).digest('hex');
  const image='ezenciel-agents:install-'+artifact.slice(0,24);
  const dir=path.join(path.resolve(home),'builds',artifact);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,'lock'),receipt=path.join(dir,'status.json'),log=path.join(dir,'build.log');
  let handle;
  try{handle=await fs.open(lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;return {state:'busy-or-interrupted',image,log,note:'An existing build owns this artifact. Inspect its status/log and owning process; do not start another build or remove a live lock.'};}
  try {
    await handle.writeFile(JSON.stringify({pid:process.pid,source,image,...identity}));
    const prior=await read(receipt).catch(absent);
    if(prior?.state==='completed')try{if(await invoke('docker',['image','inspect','--format','{{.Id}}',image])===prior.imageId)return {...prior,reused:true};}catch{/* Image was removed; rebuild under the same exclusive lock. */}
    await atomic(receipt,{state:'building',pid:process.pid,source,image,log,...identity});
    console.error(JSON.stringify({state:'building',image,log,...identity}));
    const buildArgs=identity.label?['--build-arg',`BUILD_TAG=${identity.label}`,'--build-arg',`BUILD_SHA=${identity.sha}`]:[];
    const tags=[image,...(identity.label?[`ezenciel-agents:${identity.label}`]:[])];
    const output=await fs.open(log,'a',0o600);
    try{await invoke('docker',['build','--progress','plain','--target','runtime',...buildArgs,...tags.flatMap(t=>['-t',t]),source],{log:output.fd,timeout:3600000});}finally{await output.close();}
    if(await fingerprintOf(source,invoke)!==fingerprint)throw Error('Package changed during build; keep the source stable and retry');
    const result={state:'completed',source,image,imageId:await invoke('docker',['image','inspect','--format','{{.Id}}',image]),log,...identity};await atomic(receipt,result);return result;
  }catch(e){await atomic(receipt,{state:'failed',source,image,log,error:e.message,...identity});throw e;}
  finally{await handle.close();await fs.rm(lock);}
}
export async function main(args) {
  const [action,...rest]=args;const options={};
  if(!action||action==='--help'){console.log(JSON.stringify({commands:['preflight --executor <name-or-absolute-path> [--home PATH]','build [--home PATH] [--label X.Y.Z-beta.N.rc.M]','status --deployment PATH'],note:'Source checkouts build RCs only: commit and open the PR first, then pass the next --label. Host prerequisites and main-agent diagnostics only; initialize an empty registry and verify Telegram before asking the installed agent to add plugins.'}));return;}
  for(let i=0;i<rest.length;i+=2){if(!['--home','--executor','--deployment','--label'].includes(rest[i])||!rest[i+1]||Object.hasOwn(options,rest[i].slice(2)))throw Error('Invalid arguments');options[rest[i].slice(2)]=rest[i+1];}
  const allowed={preflight:['home','executor'],build:['home','label'],status:['deployment']};if(!allowed[action]||Object.keys(options).some(k=>!allowed[action].includes(k)))throw Error('Invalid action/options');
  const result=action==='preflight'?await preflight(options):action==='build'?await build(options):await installationStatus(options.deployment);console.log(JSON.stringify(result));if(result.ok===false)process.exitCode=1;
}
