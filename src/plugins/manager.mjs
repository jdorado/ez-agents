import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const reserved = new Set(['updates','plugins','tools','message','owner','approval','react','setup','help','version']);
const id = value => { if(typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw Error('Invalid identifier'); return value; };
const hash = data => createHash('sha256').update(data).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file,'utf8'));
const emit = value => console.log(JSON.stringify(value));
const keys = (object, allowed) => { if(!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(k=>!allowed.includes(k))) throw Error('Invalid or unknown descriptor fields'); };
const strings = value => { if(!Array.isArray(value) || value.some(x=>typeof x!=='string' || x.includes('\0'))) throw Error('Expected literal string arguments'); return value; };
const containerPath = value => { if(typeof value!=='string' || !value.startsWith('/') || value.includes('..') || /[\0\n\r:$]/.test(value) || value.startsWith('/var/run') || value.startsWith('/proc') || value.startsWith('/sys')) throw Error('Invalid container path'); return value; };
const privateDir = async dir => fs.mkdir(dir,{recursive:true,mode:0o700});
export async function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.rename(tmp,file);
}
export async function locked(home, fn) {
  const lock = path.join(home,'registry.lock');
  let handle;
  try { handle=await fs.open(lock,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST') throw Error('Registry busy; inspect registry.lock before recovering an interrupted manager'); throw error; }
  try { await handle.writeFile(JSON.stringify({pid:process.pid})); return await fn(); }
  finally { await handle.close(); await fs.rm(lock); }
}
// Snapshot only explicitly packaged files. No symlinks, credentials inferred from cwd, or install scripts.
export async function snapshot(source) {
  source=await fs.realpath(source);
  const pkg=await json(path.join(source,'package.json'));
  const files=new Map();
  async function add(relative) {
    if(typeof relative!=='string' || path.isAbsolute(relative) || relative.split('/').some(p=>p==='..'||p===''||p==='node_modules'||p==='.git') || /[\0\r\n]/.test(relative)) throw Error('Unsafe package file path');
    const absolute=path.join(source,relative);
    let ancestor=source;for(const part of relative.split('/')) {ancestor=path.join(ancestor,part);if((await fs.lstat(ancestor)).isSymbolicLink())throw Error('Package symlinks are not supported');}
    const stat=await fs.lstat(absolute);
    if(stat.isSymbolicLink()) throw Error('Package symlinks are not supported');
    if(stat.isDirectory()) { for(const child of (await fs.readdir(absolute)).sort()) await add(`${relative}/${child}`); }
    else if(stat.isFile()) { if(stat.size>20*1024*1024) throw Error('Package file too large'); files.set(relative,{data:await fs.readFile(absolute),mode:stat.mode&0o111?0o755:0o644}); }
    else throw Error('Unsupported package file');
  }
  strings(pkg.files);
  for(const file of new Set(['package.json','ez-plugin.json','ez-deployment.json','Dockerfile','.dockerignore',...pkg.files])) await add(file);
  if([...files.values()].reduce((sum,f)=>sum+f.data.length,0)>100*1024*1024) throw Error('Package too large');
  const digest=createHash('sha256');
  for(const [name,file] of [...files].sort(([a],[b])=>a.localeCompare(b))) digest.update(JSON.stringify([name,file.mode,file.data.length])).update(file.data);
  const manifest=JSON.parse(files.get('ez-plugin.json').data), deployment=JSON.parse(files.get('ez-deployment.json').data);
  validate(manifest,deployment,files);
  return {source,files,manifest,deployment,revision:`sha256:${digest.digest('hex')}`};
}
export function validate(m,d,files) {
  keys(m,['schemaVersion','id','version','description','commands','skills']);
  if(m.schemaVersion!==1 || (typeof m.version!=='string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(m.version))) throw Error('Unsupported manifest version');
  id(m.id); strings(m.skills);
  keys(d,['schemaVersion','services','commands','exports',...(d.schemaVersion===2?['secrets']:[])]);
  if(![1,2].includes(d.schemaVersion) || !d.services || !d.commands) throw Error('Unsupported deployment descriptor');
  for(const [name,s] of Object.entries(d.services)) {
    id(name); keys(s,['buildTarget','image','volumes','workspace','healthcheck','command',...(d.schemaVersion===2?['environment','dependsOn','user','memoryMiB']:[])]);
    if(s.user!==undefined && !/^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/.test(s.user)) throw Error('Only explicit non-root UID:GID is supported');
    if(s.memoryMiB!==undefined && (!Number.isInteger(s.memoryMiB)||s.memoryMiB<32||s.memoryMiB>8192)) throw Error('Invalid memory bound');
    if(s.dependsOn) for(const dependency of strings(s.dependsOn)) if(!d.services[dependency]||dependency===name) throw Error('Invalid service dependency');
    for(const [key,value] of Object.entries(s.environment||{})) {
      if(!/^[A-Z][A-Z0-9_]*$/.test(key)) throw Error('Invalid environment name');
      if(typeof value==='string') {if(/[\0$]/.test(value))throw Error('Environment interpolation is unsupported');}
      else {keys(value,['secret','prefix','suffix']);id(value.secret);if(!d.secrets?.includes(value.secret))throw Error('Undeclared secret');for(const part of [value.prefix??'',value.suffix??''])if(typeof part!=='string'||/[\0$]/.test(part))throw Error('Invalid secret interpolation');}
    }
    if(Boolean(s.buildTarget)===Boolean(s.image)) throw Error('Service needs one build target or digest-pinned image');
    if(s.buildTarget) id(s.buildTarget);
    if(s.image && !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(s.image)) throw Error('Image must be digest-pinned');
    if(s.workspace!==undefined && typeof s.workspace!=='boolean') throw Error('workspace must be boolean');
    if(s.command) strings(s.command);
    if(!strings(s.healthcheck).length) throw Error('Health check required');
    const targets=new Set();
    for(const [volume,target] of Object.entries(s.volumes||{})) { id(volume);containerPath(target); if(target==='/'||targets.has(target)) throw Error('Duplicate/root mount');targets.add(target); }
  }
  for(const secret of strings(d.secrets||[])) id(secret);
  const visiting=new Set(),visited=new Set();
  function visit(name) {if(visiting.has(name))throw Error('Cyclic service dependency');if(visited.has(name))return;visiting.add(name);for(const dependency of d.services[name].dependsOn||[])visit(dependency);visiting.delete(name);visited.add(name);}
  for(const name of Object.keys(d.services))visit(name);
  if(!Object.keys(d.services).length) throw Error('No services');
  if(JSON.stringify(Object.keys(m.commands).sort())!==JSON.stringify(Object.keys(d.commands).sort())) throw Error('Command bindings must match manifest');
  for(const [alias,c] of Object.entries(m.commands)) {
    id(alias); if(reserved.has(alias)) throw Error('Reserved alias');
    keys(c,['executable','args']); strings(c.args);
    if(!files.has(c.executable)) throw Error('Missing package executable');
    const b=d.commands[alias];keys(b,['service','argv','suffix']);
    if(!d.services[b.service] || !strings(b.argv).length) throw Error('Invalid command service'); strings(b.suffix||[]);
  }
  for(const skill of m.skills) if(!files.has(skill)) throw Error('Missing skill');
  for(const [name,e] of Object.entries(d.exports||{})) {
    id(name);keys(e,['service','path']);if(!d.services[e.service]) throw Error('Invalid export service');containerPath(e.path);
  }
}
export function compose(config, record, secrets={}) {
  const services={}, volumes={};
  for(const [name,s] of Object.entries(record.deployment.services)) {
    const mounts=[];
    for(const [volume,target] of Object.entries(s.volumes||{})) { volumes[volume]={};mounts.push({type:'volume',source:volume,target}); }
    if(s.workspace) mounts.push({type:'bind',source:config.workspace,target:config.workspace,read_only:true});
    services[name]={...(s.image?{image:s.image}:{image:`${record.project}-${name}:${record.revision.slice(7,23)}`,build:{context:record.source,target:s.buildTarget}}),
      init:true,user:s.user||'1000:1000',restart:'unless-stopped',cap_drop:['ALL'],security_opt:['no-new-privileges:true'],tmpfs:['/tmp'],volumes:mounts,
      healthcheck:{test:['CMD',...s.healthcheck],interval:'2s',timeout:'5s',retries:30,...(record.deployment.schemaVersion===2?{start_period:'60s'}:{})},
      ...(s.dependsOn?{depends_on:Object.fromEntries(s.dependsOn.map(dep=>[dep,{condition:'service_healthy'}]))}:{}),
      ...(s.memoryMiB?{mem_limit:`${s.memoryMiB}m`}:{}),
      ...(s.environment?{environment:Object.fromEntries(Object.entries(s.environment).map(([key,value])=>{
        if(typeof value==='string')return [key,value];
        if(!/^[a-f0-9]{64}$/.test(secrets[value.secret]||''))throw Error('Missing or invalid private deployment secret');
        return [key,(value.prefix||'')+secrets[value.secret]+(value.suffix||'')];
      }))}:{}),...(s.command?{command:s.command}:{})};
  }
  return {name:record.project,services,volumes};
}
function dockerEnv() {
  return Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','BUILDX_CONFIG'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
}
export function run(argv,{capture=false,container}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',argv,{env:dockerEnv(),stdio:capture?['ignore','pipe','pipe']:['inherit','inherit','inherit']});
    let stdout='',stderr='',cancelled=false;
    if(capture) {child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);}
    const cancel=signal=>{cancelled=true;child.kill(signal);};
    const term=()=>cancel('SIGTERM'),int=()=>cancel('SIGINT');
    process.on('SIGTERM',term);process.on('SIGINT',int);
    child.once('error',reject);
    child.once('close',async(code,signal)=>{process.off('SIGTERM',term);process.off('SIGINT',int);
      if(cancelled&&container) await run(['rm','-f',container],{capture:true});
      resolve({code:cancelled?130:code??(signal?130:1),stdout,stderr});});
  });
}
async function checked(args) {
  const r=await run(args,{capture:true});if(r.code) throw Error(r.stderr||r.stdout||`Docker failed (${r.code})`);return r.stdout;
}
const composeArgs = record => ['compose','--project-name',record.project,'--file',record.compose];
async function registry(home) {
  const r=await json(path.join(home,'registry.json'));
  if(r.schemaVersion!==1 || r.owner!==home || !r.plugins || !r.commands) throw Error('Corrupt registry');
  for(const [name,record] of Object.entries(r.plugins)) {
    id(name);if(record.project!==`ezp-${hash(home).slice(0,16)}-${name}` || record.compose!==path.join(home,'packages',name,'compose.json')) throw Error('Wrong-agent deployment binding');
  }
  for(const [alias,plugin] of Object.entries(r.commands)) if(!r.plugins[plugin]?.deployment?.commands?.[alias]) throw Error('Corrupt command registry');
  return r;
}
export async function init(home,workspace,catalogFile,hostConfig) {
  if(typeof home!=='string'||typeof workspace!=='string'||!path.isAbsolute(home)||!path.isAbsolute(workspace)||/[\r\n\0$:,]/.test(home+workspace)) throw Error('Explicit absolute home/workspace required');
  workspace=await fs.realpath(workspace);await privateDir(home);home=await fs.realpath(home);
  if(await fs.lstat(path.join(home,'registry.json')).catch(()=>null)) throw Error('Registry already exists; refusing replacement');
  catalogFile=path.resolve(catalogFile||fileURLToPath(new URL('../../default-plugins.json',import.meta.url)));
  const sources=await json(catalogFile);
  const catalog={};
  for(const [name,source] of Object.entries(sources)) {id(name);if(typeof source!=='string'||!source)throw Error('Catalog source must be a nonempty path');const resolved=path.resolve(path.dirname(catalogFile),source);const p=await snapshot(resolved).catch(error=>{throw Error(`Cannot load reviewed plugin ${name} from ${resolved}: ${error.message}. Supply its checkout or an explicit --catalog file.`)});if(p.manifest.id!==name) throw Error('Catalog ID mismatch');catalog[name]={source:p.source,revision:p.revision};}
  await locked(home,async()=>{
    await atomic(path.join(home,'config.json'),{schemaVersion:1,workspace,catalog});
    await atomic(path.join(home,'registry.json'),{schemaVersion:1,owner:home,plugins:{},commands:{}});
    const bin=path.join(home,'bin');await privateDir(bin);
    await fs.writeFile(path.join(bin,'ez'),`#!${process.execPath}\nimport(${JSON.stringify(new URL('./manager.mjs',import.meta.url).href)}).then(m=>m.main(['--home',${JSON.stringify(home)},...process.argv.slice(2)])).catch(e=>{console.error(e.message);process.exitCode=1});\n`,{mode:0o700,flag:'wx'});
    if(hostConfig) {
      const host=await json(hostConfig);let agent;for(const candidate of host.agents) if(await fs.realpath(candidate.workspace)===workspace) agent=candidate;
      if(!agent) throw Error('Host config does not bind this workspace');
      // npm archives need not include source-tree aliases: use public names
      // and actual entry points from this package's manifest.
      const manifest=await json(new URL('../../package.json',import.meta.url));
      for(const [name,entry] of Object.entries(manifest.bin)) {
        const target=new URL('../../'+entry,import.meta.url);
        await fs.access(target,fs.constants.X_OK);
        await fs.symlink(target,path.join(bin,name));
      }
      for(const file of await fs.readdir(agent.binDir)) {if(file==='ez') throw Error('Existing ez binding collision');if(Object.hasOwn(manifest.bin,file))continue;await fs.symlink(path.join(agent.binDir,file),path.join(bin,file));}
      agent.binDir=bin;agent.toolsHome=home;await atomic(hostConfig,host);
    }
  });
  const index=path.join(workspace,'TOOLS.md');
  const prior=await fs.readFile(index,'utf8').catch(e=>{if(e.code==='ENOENT')return fs.readFile(new URL('../../templates/agent/TOOLS.md',import.meta.url),'utf8');throw e;});
  await fs.writeFile(index,prior+'\n## Registered plugins\n\nUse `'+path.join(home,'bin','ez')+'` for this agent only.\nDiscover reviewed packages with `ez plugins available`; inspect with `ez plugins inspect <id>`.\nOn an authorized installation request, run `ez plugins install <id>`, then `ez plugins start <id>`.\nRead the installed skill paths from `ez plugins list` before onboarding or provider operations.\nUse `ez tools list` for aliases and `ez <alias> --help` for native commands.\nInstallation does not grant send authority. The registry is the only plugin installation, command and lifecycle authority. Do not create standalone provider launchers or deployments.\n',{mode:0o600});
  if(hostConfig && path.basename(hostConfig)==='host-executor.json') await (await import('../updates/binding.mjs')).bindUpdates(home,hostConfig);
  return {ok:true,launcher:path.join(home,'bin','ez'),workspace};
}
export async function install(home,config,name,source,revision) {
  id(name);
  const p=await snapshot(source);
  if(p.manifest.id!==name) throw Error('Plugin identity mismatch: requested '+name+', source declares '+p.manifest.id);
  if(p.revision!==revision) throw Error('Source revision mismatch: expected '+revision+', current '+p.revision+'. Inspection is read-only; review its result, then use install --revision HASH or catalog-add with --source PATH --revision HASH to update the reviewed pin.');
  return locked(home,async()=>{
    const r=await registry(home),existing=r.plugins[name];
    if(existing) {if(existing.revision!==revision) throw Error('Different release already installed; uninstall preserves data before replacement');return {ok:true,existing:true,plugin:name};}
    for(const alias of Object.keys(p.manifest.commands)) if(r.commands[alias]) throw Error('CLI alias collision');
    const base=path.join(home,'packages',name),target=path.join(base,revision.slice(7));await privateDir(base);
    const stage=path.join(base,`.stage-${randomUUID()}`);await privateDir(stage);
    try {
      for(const [relative,file] of p.files) {const dest=path.join(stage,relative);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o755});await fs.writeFile(dest,file.data,{mode:file.mode,flag:'wx'});}
      await fs.chmod(stage,0o755);
      // A previously interrupted install may leave a snapshot. Never silently replace it.
      try { await fs.rename(stage,target); } catch(error) {
        if(!['EEXIST','ENOTEMPTY'].includes(error.code)) throw error;
        if((await snapshot(target)).revision!==revision) throw Error('Interrupted package snapshot differs; inspect before recovery');
      }
    } finally {await fs.rm(stage,{recursive:true,force:true});}
    const record={revision,source:target,project:`ezp-${hash(home).slice(0,16)}-${name}`,manifest:p.manifest,deployment:p.deployment,compose:path.join(base,'compose.json')};
    const secretsFile=path.join(base,'secrets.json');
    let secrets;try{secrets=await json(secretsFile);}catch(error){if(error.code!=='ENOENT')throw error;secrets={};}
    for(const name of p.deployment.secrets||[])if(secrets[name]===undefined)secrets[name]=randomBytes(32).toString('hex');
    if(p.deployment.secrets?.length)await atomic(secretsFile,secrets);
    await atomic(record.compose,compose(config,record,secrets));
    // Build/pull is explicit installation mechanics. No services start and no onboarding is executed.
    for(const [service,s] of Object.entries(record.deployment.services)) await checked([...composeArgs(record),s.image?'pull':'build',service]);
    r.plugins[name]=record;for(const alias of Object.keys(p.manifest.commands)) r.commands[alias]=name;
    await atomic(path.join(home,'registry.json'),r);
    return {ok:true,plugin:name,revision,started:false,skills:p.manifest.skills.map(s=>path.join(target,s))};
  });
}
export async function main(args) {
  const take=flag=>{const n=args.indexOf(flag);if(n<0)return undefined;if(!args[n+1])throw Error(`Missing ${flag}`);return args.splice(n,2)[1];};
  // Only the fixed launcher may supply the leading home binding. Never consume plugin arguments here.
  let home;if(args[0]==='--home') {home=args[1];args=args.slice(2);}
  if(args[0]==='enable-updates') {args.shift();const h=take('--home'),host=take('--host-config');if(args.length||!h||!host)throw Error('Supply --home and --host-config');return emit(await (await import('../updates/binding.mjs')).bindUpdates(h,host));}
  if(args[0]==='init') {args.shift();const options=[take('--home'),take('--workspace'),take('--catalog'),take('--host-config')];if(args.length)throw Error('Unknown init arguments');return emit(await init(...options));}
  if(!home || !path.isAbsolute(home)) throw Error('Use the agent-bound launcher, or init --home /absolute/tools --workspace /absolute/mind --catalog /absolute/catalog.json');
  home=await fs.realpath(home);
  const config=await json(path.join(home,'config.json'));
  if(config.schemaVersion!==1 || !path.isAbsolute(config.workspace)) throw Error('Invalid binding');
  const [group,action,...rest]=args;
  if(group==='updates')return emit(await (await import('../updates/control.mjs')).command(home,args.slice(1)));
  if(group==='--help'||!group) return emit({commands:['updates check|policy|prepare|apply|status','plugins available|catalog-add|list|inspect|install|start|stop|status|logs|uninstall|export','tools list','<registered CLI> ...'],scope:home});
  if(group==='plugins'&&(!action||args.includes('--help'))) return emit({commands:['available','list','inspect <id>','install <id>','start <id>','stop <id>','status <id>','logs <id>','uninstall <id>','catalog-add <id> --source PATH --revision HASH','export <id> <artifact> --output PATH'],uninstall:'Stops and removes containers/network and unregisters aliases; retains all volumes and secrets. No data deletion flag.',scope:home});
  if(group==='plugins'||group==='tools') {
    args=rest;args=args.filter(a=>a!=='--json');
    if(action==='available'&&group==='plugins') return emit(config.catalog);
    const r=await registry(home);
    if(action==='list') return emit(group==='tools'?r.commands:r.plugins);
    if(group==='tools') throw Error('Only tools list is supported; installation registers CLI bindings');
    const name=args.shift();id(name);
    if(action==='inspect'||action==='install'||action==='catalog-add') {
      const source=take('--source')||config.catalog[name]?.source,revision=take('--revision')||config.catalog[name]?.revision;
      if(args.length||!source)throw Error('Supply a known catalog name or --source');
      if(action==='catalog-add') {
        const p=await snapshot(source);if(p.manifest.id!==name||p.revision!==revision)throw Error('Inspect and pin the exact catalog package first');
        return locked(home,async()=>{const latest=await json(path.join(home,'config.json'));latest.catalog[name]={source:p.source,revision:p.revision};await atomic(path.join(home,'config.json'),latest);emit({ok:true,plugin:name,revision:p.revision,installed:false});});
      }
      if(action==='inspect') {const p=await snapshot(source);return emit({id:p.manifest.id,source:p.source,revision:p.revision,catalogRevision:config.catalog[name]?.revision??null,catalogMatches:config.catalog[name]?.source===p.source&&config.catalog[name]?.revision===p.revision,inspection:'Read-only; does not update the catalog pin. After review, pass --revision to install or use catalog-add --source --revision.',manifest:p.manifest,deployment:p.deployment});}
      return emit(await install(home,config,name,source,revision));
    }
    const record=r.plugins[name];if(!record)throw Error('Plugin not installed');
    if(action==='export') {
      const artifact=args.shift(),output=take('--output'),e=record.deployment.exports?.[artifact];
      if(!e||!output||args.length)throw Error('Supply a declared export and --output workspace/file');
      const dest=path.resolve(output),parent=await fs.realpath(path.dirname(dest));
      if(!parent.startsWith(config.workspace+path.sep)&&parent!==config.workspace)throw Error('Export must stay inside the bound workspace');
      const handle=await fs.open(dest,'wx',0o600);await handle.close();
      try {await checked([...composeArgs(record),'cp',`${e.service}:${e.path}`,dest]);await fs.chmod(dest,0o600);}catch(error){await fs.rm(dest,{force:true});throw error;}
      return emit({ok:true,path:dest});
    }
    if(args.length)throw Error('Unknown lifecycle arguments');
    if(action==='logs') return emit({plugin:name,logs:await checked([...composeArgs(record),'logs','--tail','100','--no-color'])});
    if(action==='status') {const output=await checked([...composeArgs(record),'ps','--all','--format','json']);return emit({plugin:name,containers:output});}
    if(!['start','stop','uninstall'].includes(action))throw Error('Unknown lifecycle command');
    return locked(home,async()=>{
      const current=await registry(home);if(current.plugins[name]?.revision!==record.revision)throw Error('Plugin changed during lifecycle request');
      await checked([...composeArgs(record),...(action==='start'?['up','-d','--wait']:action==='stop'?['stop']:['down'])]);
      if(action==='uninstall') {delete current.plugins[name];for(const [alias,owner] of Object.entries(current.commands))if(owner===name)delete current.commands[alias];await atomic(path.join(home,'registry.json'),current);}
      emit({ok:true,plugin:name,action,dataPreserved:true});
    });
  }
  const r=await registry(home),record=r.plugins[r.commands[group]],binding=record?.deployment.commands[group];
  if(!binding)throw Error('Unknown registered CLI');
  // Docker exec does not reliably forward cancellation to the in-container process.
  // Run each client as a one-shot Compose container; docker compose run forwards signals.
  const name=`${record.project}-call-${randomUUID()}`;
  const result=await run([...composeArgs(record),'run','--rm','--no-deps','-T','--name',name,'--entrypoint',binding.argv[0],binding.service,...binding.argv.slice(1),...record.manifest.commands[group].args,...args.slice(1),...(binding.suffix||[])],{container:name});
  process.exitCode=result.code;
}
