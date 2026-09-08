import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extract, digest, version, newer, compatible } from '../src/updates/artifact.mjs';
import { prepare, submit, command, read, jobPath, eligibility } from '../src/updates/control.mjs';
import { perform, environment, packageManager } from '../src/updates/runtime.mjs';
import { atomic, snapshot, compose } from '../src/plugins/manager.mjs';
import { bindUpdates } from '../src/updates/binding.mjs';
import { status as runtimeStatus } from '../src/updates/status.mjs';
const exec=promisify(execFile);
const contract=kind=>({protocol:1,kind,stateSchema:1,mainProtocol:1});
function tar(entries) {
 const chunks=[];
 for(const [name,body='',type='0'] of entries) {
  const data=Buffer.from(body),h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);
  const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));
 }
 return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
async function fixture(t,kind='main') {
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'ez-update-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const deployment=path.join(root,'agent'),home=path.join(deployment,'tools'),old=path.join(root,'old'),source=path.join(root,'candidate');
 for(const d of [home,old,source,path.join(home,'bin'),path.join(home,'updates'),path.join(deployment,'mind'),path.join(deployment,'control')])await fs.mkdir(d,{recursive:true});
 const pkg={name:'@ez-test/example',version:'0.1.0',packageManager:'pnpm@10.30.3',type:'module',files:['bin','src','docker','compose.yaml','compose.whatsapp.yaml','.dockerignore','Dockerfile'],bin:{example:'bin/example.mjs'},ezRelease:contract(kind)};
 const files={'package.json':JSON.stringify(pkg),'compose.yaml':'services: {}\n','compose.whatsapp.yaml':'services: {}\n','.dockerignore':'','Dockerfile':'FROM scratch AS runtime','docker/pnpm-lock.yaml':'lockfileVersion: 9.0\n','src/host-executor.ts':'','bin/example.mjs':'#!/usr/bin/env node\nconsole.log("example")','bin/ezenciel-agents.mjs':'console.log("0.1.1")'};
 let record,target='main';
 if(kind==='plugin') {
  target='sample';files['ez-plugin.json']=JSON.stringify({schemaVersion:1,id:'sample',version:pkg.version,commands:{sample:{executable:'bin/example.mjs',args:[]}},skills:[]});
  files['ez-deployment.json']=JSON.stringify({schemaVersion:1,services:{sample:{buildTarget:'runtime',volumes:{profile:'/state'},healthcheck:['node','--version']}},commands:{sample:{service:'sample',argv:['node','/app/bin/example.mjs']}},exports:{}});
  pkg.files.push('ez-plugin.json','ez-deployment.json');files['package.json']=JSON.stringify(pkg);
 }
 for(const [name,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(old,name)),{recursive:true});await fs.writeFile(path.join(old,name),text,{mode:name.startsWith('bin/')?0o755:0o644});}
 const agent={name:'agent',workspace:path.join(deployment,'mind'),controlDir:path.join(deployment,'control'),binDir:path.join(home,'bin'),toolsHome:home};
 await atomic(path.join(deployment,'host-executor.json'),{cli:'grok',agents:[agent]});
 const config={schemaVersion:1,workspace:agent.workspace,catalog:{},deploymentDir:deployment,packageRoot:old};await atomic(path.join(home,'config.json'),config);
 for(const name of ['agent.json','purpose.md','relay.env'])await fs.writeFile(path.join(deployment,name),name==='relay.env'?'TELEGRAM_BOT_TOKEN=private-test-token':'{}',{mode:0o600});
 await fs.writeFile(path.join(deployment,'docker.env'),`COMPOSE_FILE='${old}/compose.yaml'\nCOMPOSE_PROJECT_NAME='ez-agent-fixture'\n`);
 await fs.writeFile(path.join(agent.workspace,'TOOLS.md'),'My notes\n');
 if(kind==='plugin') {
  const s=await snapshot(old),base=path.join(home,'packages',target);await fs.mkdir(base,{recursive:true});
  record={revision:s.revision,source:old,project:`ezp-${digest(home).slice(0,16)}-${target}`,manifest:s.manifest,deployment:s.deployment,compose:path.join(base,'compose.json')};
  await atomic(record.compose,compose(config,record));
 }
 await atomic(path.join(home,'registry.json'),{schemaVersion:1,owner:home,plugins:record?{sample:record}:{},commands:record?{sample:'sample'}:{}});
 await fs.cp(old,source,{recursive:true});pkg.version='0.1.1';await atomic(path.join(source,'package.json'),pkg);
 if(kind==='plugin'){const m=await read(path.join(source,'ez-plugin.json'));m.version=pkg.version;await atomic(path.join(source,'ez-plugin.json'),m);}
 const pack=async()=>{const entries=[];async function walk(dir,prefix=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())await walk(path.join(dir,e.name),rel+'/');else entries.push(['package/'+rel,await fs.readFile(path.join(dir,e.name))]);}}await walk(source);const file=path.join(root,'candidate.tgz');await fs.writeFile(file,tar(entries));return file;};
 return {root,home,old,source,agent,config,record,target,pack};
}
function runtime(f,{fail,stopped=false}={}) {
 const calls=[];let failed=false;
 const execute=async(command,args,opts)=>{
  calls.push([command,...args]);if(fail&&!failed&&fail(command,args)){failed=true;throw Error('Synthetic failure');}
  if(args.at(-1)==='--version')return '10.30.3';
  if(args.includes('ps'))return stopped?'':'container-id';
  if(args[0]==='inspect')return 'sha256:'+'a'.repeat(64);
  if(args[0]==='volume'&&args[1]==='ls')return 'existing';
  if(args[0]==='volume')return JSON.stringify([{Name:args[2]}]);
  if(args[0]==='run')await fs.writeFile(opts.outputFile,'retained-private-state',{mode:0o600});
  return '';
 };
 return {calls,execute,stopHost:async()=>calls.push(['stopHost']),startHost:async root=>calls.push(['startHost',root])};
}
async function queued(f) {
 const job=await prepare(f.home,f.target,{file:await f.pack()});await atomic(path.join(f.home,'updates/supervisor.json'),{at:Date.now()});
 return submit(f.home,job.id,false);
}

test('status distinguishes installed, running, legacy and stale main versions without update jobs',async t=>{
 const f=await fixture(t),relay=path.join(f.agent.controlDir,'heartbeat.json'),host=path.join(f.agent.controlDir,'host-executor/heartbeat.json');
 await fs.mkdir(path.dirname(host),{recursive:true});
 await atomic(relay,{at:Date.now(),polling:true,version:'0.0.9'});await atomic(host,{at:Date.now(),version:'0.0.8'});
 let s=await command(f.home,['status']);
 assert.equal(s.main.installedVersion,'0.1.0');assert.equal(s.main.runningVersion,'0.0.9');assert.equal(s.main.host.runningVersion,'0.0.8');
 assert.deepEqual(s.plugins,[]);assert.deepEqual(s.jobs,[]);
 for(const value of [{at:Date.now()-60000,polling:true,version:'0.0.9'},{at:Date.now()+60000,polling:true,version:'0.0.9'},{at:Date.now(),polling:false,version:'0.0.9'},{at:Date.now(),polling:true}]) {
  await atomic(relay,value);s=await command(f.home,['status']);assert.equal(s.main.runningVersion,null);
 }
 await fs.writeFile(relay,'broken');s=await command(f.home,['status']);assert.equal(s.main.state,'unknown');
 await fs.rm(relay);s=await command(f.home,['status']);assert.equal(s.main.state,'offline');
 const result=await exec(process.execPath,[new URL('../bin/ezenciel-agents-tools.mjs',import.meta.url).pathname,'--home',f.home,'status']);
 assert.equal(JSON.parse(result.stdout).main.installedVersion,'0.1.0');
});
test('plugin status verifies images and reports stopped, mismatched and unreachable runtimes honestly',async t=>{
 const f=await fixture(t,'plugin'),id='a'.repeat(64),image='sha256:'+'b'.repeat(64);
 for(const mode of ['running','ndjson','stopped','missing','mismatched','offline']) {
  const calls=[];
  const run=async(c,args)=>{
   calls.push([c,...args]);assert.equal(c,'docker');
   if(mode==='offline')throw Error('synthetic secret must not escape');
   if(args.includes('ps')) {const rows=mode==='missing'?[]:[{Service:'sample',State:mode==='stopped'?'exited':'running',Health:'healthy',ID:id}];return mode==='ndjson'?rows.map(r=>JSON.stringify(r)).join('\n'):JSON.stringify(rows);}
   assert(args.includes('inspect'));return mode==='mismatched'&&args[0]==='image'?'sha256:'+'c'.repeat(64):image;
  };
  const s=await runtimeStatus(f.home,run),p=s.plugins[0];
  assert.equal(p.installedVersion,'0.1.0');assert.equal(p.runningVersion,['running','ndjson'].includes(mode)?'0.1.0':null);
  assert.equal(p.state,mode==='offline'?'unknown':['stopped','missing'].includes(mode)?'stopped':'running');
  assert(!JSON.stringify(s).includes('synthetic secret'));assert(calls.every(c=>!c.includes('exec')&&!c.includes('start')&&!c.includes('up')));
 }
});
test('SemVer ordering and compatibility reject ranges, malformed values and downgrades',()=>{
 for(const s of ['latest','../1','1.0','01.0.0','1.0.0-01'])assert.throws(()=>version(s));
 assert(newer('0.1.0-beta.10','0.1.0-beta.2'));assert(newer('0.1.0','0.1.0-beta.10'));assert(!newer('0.1.0-beta.2','0.1.0'));assert(!newer('1.0.0','1.0.0'));
 assert(compatible('0.1.9','0.1.0'));assert(!compatible('0.2.0','0.1.0'));assert(compatible('1.9.0','1.0.0'));assert(!compatible('2.0.0','1.0.0'));
});
test('archive admission rejects traversal, links, special files, duplicates and corrupt bytes before writes',async t=>{
 const f=await fixture(t);
 for(const entries of [[['package/../escape','x']],[['/tmp/escape','x']],[['package/link','','2']],[['package/node_modules/x','x']],[['package/package.json','{}'],['package/package.json','{}']],[['package/x','','3']]])await assert.rejects(extract(tar(entries),path.join(f.root,'bad')));
 await assert.rejects(extract(Buffer.from('not gzip'),path.join(f.root,'bad')));
 await assert.rejects(fs.access(path.join(f.root,'bad')));
});
test('policy defaults stable; prepared local candidates need explicit authority and a live supervisor',async t=>{
 const f=await fixture(t),job=await prepare(f.home,'main',{file:await f.pack()});
 assert.deepEqual(await command(f.home,['policy','main']),{automatic:true,channel:'stable'});
 await assert.rejects(submit(f.home,job.id,false));
 await atomic(path.join(f.home,'updates/supervisor.json'),{at:Date.now()});
 await assert.rejects(submit(f.home,job.id,true),/Local/);
 await command(f.home,['policy','main','manual']);await assert.rejects(eligibility(f.home,'main',f.source,true),/policy/);
 await submit(f.home,job.id,false);await assert.rejects(submit(f.home,job.id,false),/not prepared/);
 await assert.rejects(command(f.home,['status','extra']));await assert.rejects(command(f.home,['policy','../escape']));
});
test('identity, state migration, deployment changes and stale candidates fail before replacement',async t=>{
 const f=await fixture(t);
 const mutate=async change=>{const p=await read(path.join(f.source,'package.json'));await atomic(path.join(f.source,'package.json'),{...p,...change});};
 await mutate({name:'@attacker/package'});await assert.rejects(prepare(f.home,'main',{file:await f.pack()}),/identity/);
 await mutate({name:'@ez-test/example',ezRelease:{...contract('main'),stateSchema:2}});await assert.rejects(prepare(f.home,'main',{file:await f.pack()}),/migration/);
 await mutate({ezRelease:contract('main'),version:'0.0.1'});await assert.rejects(prepare(f.home,'main',{file:await f.pack()}),/newer/);
 await mutate({version:'0.1.1'});await fs.writeFile(path.join(f.source,'compose.yaml'),'privileged: true');await assert.rejects(prepare(f.home,'main',{file:await f.pack()}),/deployment/);
});
test('main transaction stages before stopping, pins rollback image, preserves state and rebinds root',async t=>{
 const f=await fixture(t),job=await queued(f),r=runtime(f);
 await fs.writeFile(path.join(f.agent.workspace,'memory.md'),'retain me');
 // Mutable preparation files cannot alter the verified archive executed later.
 await fs.writeFile(path.join(jobPath(f.home,job.id),'package/bin/example.mjs'),'tampered');
 const result=await perform(f.home,job,r);assert.equal(result.status,'completed');
 assert.equal(await fs.readFile(path.join(f.agent.workspace,'memory.md'),'utf8'),'retain me');
 const active=(await read(path.join(f.home,'config.json'))).packageRoot;assert(active.endsWith('/runtime'));
 assert.notEqual(await fs.readFile(path.join(active,'bin/example.mjs'),'utf8'),'tampered');
 assert(r.calls.findIndex(c=>c.includes('build'))<r.calls.findIndex(c=>c[0]==='stopHost'));
 const status=await command(f.home,['status']);assert(!JSON.stringify(status).includes('private-test-token'));assert(!('rollback'in status.jobs[0]));
 assert.equal((await fs.stat(path.join(jobPath(f.home,job.id),'job.json'))).mode&0o777,0o600);
});
test('failed preparation never stops runtime; failed activation rolls back code without rewinding state',async t=>{
 for(const stage of ['build','health']) {
  const f=await fixture(t),job=await queued(f),r=runtime(f,{fail:(_c,a)=>stage==='build'?a[0]==='build':a.includes('up')});
  const result=await perform(f.home,job,r);assert.equal(result.status,stage==='build'?'failed':'rolled-back');
  assert.equal((await read(path.join(f.home,'config.json'))).packageRoot,f.old);
  if(stage==='build')assert(!r.calls.some(c=>c[0]==='stopHost'));
  else assert((await fs.readFile(path.join(f.config.deploymentDir,'docker.env'),'utf8')).includes('sha256:'+'a'.repeat(64)));
 }
});
test('plugin transaction preserves named volumes, backs up stopped data and rolls back failed health',async t=>{
 for(const failed of [false,true]) {
  const f=await fixture(t,'plugin'),job=await queued(f),r=runtime(f,{fail:(_c,a)=>failed&&a.includes('up')});
  const result=await perform(f.home,job,r);assert.equal(result.status,failed?'rolled-back':'completed');
  const installed=(await read(path.join(f.home,'registry.json'))).plugins.sample;
  assert.equal(installed.project,f.record.project);assert.equal(installed.manifest.version,failed?'0.1.0':'0.1.1');
  assert(r.calls.some(c=>c.includes('readonly')||c.some(a=>a.includes?.('target=/data,readonly'))));
  assert(!r.calls.some(c=>c.includes('down')||c.includes('-v')||c[0]==='stopHost'));
  assert.equal(await fs.readFile(path.join(jobPath(f.home,job.id),'backup/profile.tar'),'utf8'),'retained-private-state');
 }
});
test('stopped plugins remain stopped; removed plugins and expanded mounts reject updates',async t=>{
 const f=await fixture(t,'plugin'),job=await queued(f),r=runtime(f,{stopped:true});
 const result=await perform(f.home,job,r);assert.equal(result.status,'completed');assert.equal(result.runtimeVerified,false);assert(!r.calls.some(c=>c.includes('up')));
 const d=await read(path.join(f.source,'ez-deployment.json'));d.services.sample.volumes.other='/more';await atomic(path.join(f.source,'ez-deployment.json'),d);
 await assert.rejects(eligibility(f.home,'sample',f.source,false));
 const reg=await read(path.join(f.home,'registry.json'));delete reg.plugins.sample;await atomic(path.join(f.home,'registry.json'),reg);
 await assert.rejects(prepare(f.home,'sample',{file:await f.pack()}),/not installed/);
});
test('interrupted activation recovers previous code; rollback failure is explicit and blocks further jobs',async t=>{
 const f=await fixture(t),job=await queued(f),r=runtime(f);await perform(f.home,job,r);
 const interrupted=await read(path.join(jobPath(f.home,job.id),'job.json'));interrupted.status='applying';
 const result=await perform(f.home,interrupted,r);assert.equal(result.status,'rolled-back');assert.equal((await read(path.join(f.home,'config.json'))).packageRoot,f.old);
 interrupted.status='applying';const broken={...r,execute:async()=>{throw Error('Docker offline');}};
 assert.equal((await perform(f.home,interrupted,broken)).status,'recovery-required');
 const another=await prepare(f.home,'main',{file:await f.pack()});await assert.rejects(submit(f.home,another.id,false),/pending/);
 await command(f.home,['recover',interrupted.id]);
 const retried=await read(path.join(jobPath(f.home,interrupted.id),'job.json'));assert.equal((await perform(f.home,retried,r)).status,'rolled-back');
});
test('bound dispatch follows active package root and retains private scope',async t=>{
 const f=await fixture(t);await bindUpdates(f.home,path.join(f.config.deploymentDir,'host-executor.json'));
 const config=await read(path.join(f.home,'config.json'));config.packageRoot=f.source;await atomic(path.join(f.home,'config.json'),config);
 // A native launcher from the real package looks up its entry point in the active root.
 await fs.writeFile(path.join(f.source,'bin/ezenciel-agents.mjs'),'#!/usr/bin/env node\nconsole.log(process.env.EZ_DEPLOYMENT_DIR)',{mode:0o755});
 const result=await exec(path.join(f.home,'bin/ezenciel-agents'),['--version']);assert.equal(result.stdout.trim(),f.config.deploymentDir);
 assert((await fs.readFile(path.join(f.agent.workspace,'TOOLS.md'),'utf8')).startsWith('My notes'));
});
test('upgrade subprocess environment never inherits relay/provider secrets',()=>{
 process.env.TELEGRAM_BOT_TOKEN='synthetic';process.env.OPENAI_API_KEY='synthetic';
 try {assert.equal(environment().TELEGRAM_BOT_TOKEN,undefined);assert.equal(environment().OPENAI_API_KEY,undefined);}finally{delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.OPENAI_API_KEY;}
});

test('package manager selection reuses pnpm, then exact Corepack; never substitutes npm',async t=>{
 const f=await fixture(t);
 for(const unavailable of ['none','missing','wrong-version']) {
  const calls=[];
  const chosen=await packageManager(f.source,async(c,a)=>{
   calls.push([c,...a]);
   if(c==='pnpm'&&unavailable==='missing')throw Object.assign(Error('spawn pnpm ENOENT'),{code:'ENOENT'});
   return c==='pnpm'&&unavailable==='wrong-version'?'9.0.0':'10.30.3';
  });
  assert.equal(chosen.command,unavailable==='none'?'pnpm':'corepack');
  assert.deepEqual(calls,unavailable==='none'?[['pnpm','--version']]:[['pnpm','--version'],['corepack','pnpm@10.30.3','--version']]);
 }
 const p=await read(path.join(f.source,'package.json'));
 for(const value of ['npm@10.0.0','pnpm@latest','pnpm@https://example.invalid/x',undefined]) {
  await atomic(path.join(f.source,'package.json'),{...p,packageManager:value});
  await assert.rejects(packageManager(f.source,async()=>assert.fail('must not execute')),/exact pnpm/);
 }
});
test('missing or broken managers fail with repair guidance before installing or stopping anything',async t=>{
 for(const reason of ['ENOENT','signature verification failed','wrong-version']) {
  const f=await fixture(t),job=await queued(f),r=runtime(f);
  r.execute=async(c,a)=>{r.calls.push([c,...a]);assert(['pnpm','corepack'].includes(c));assert.equal(a.at(-1),'--version');if(reason==='wrong-version')return '9.0.0';throw Error(reason);};
  const result=await perform(f.home,job,r);
  assert.equal(result.status,'failed');assert.equal(result.rollback,undefined);
  assert.match(result.error,/service PATH/);assert.match(result.error,/prepare\/apply a new job/);
  assert.equal((await read(path.join(f.home,'config.json'))).packageRoot,f.old);
  assert.equal(r.calls.length,2);assert(!r.calls.some(c=>c.includes('install')||c[0]==='stopHost'));
 }
});

for(const provider of ['pnpm','corepack']) test(`supervisor with only ${provider} drains work, replaces host PID and recovers after restart`,async t=>{
 const f=await fixture(t),fake=path.join(f.root,'fake');await fs.mkdir(fake);
 const hostCode=`import fs from 'node:fs';import path from 'node:path';const c=JSON.parse(fs.readFileSync(process.argv[2])).agents[0];const d=path.join(c.controlDir,'host-executor');fs.mkdirSync(d,{recursive:true});const beat=()=>{fs.writeFileSync(path.join(d,'heartbeat.json'),JSON.stringify({pid:process.pid,at:Date.now()}));};beat();const timer=setInterval(()=>{try{process.kill(Number(process.env.EZ_HOST_SUPERVISOR_PID),0)}catch{process.exit(0)}beat()},100);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});`;
 for(const dir of [f.old,f.source]) {
  await fs.mkdir(path.join(dir,'node_modules/tsx/dist'),{recursive:true});await fs.writeFile(path.join(dir,'node_modules/tsx/dist/loader.mjs'),'');
  await fs.writeFile(path.join(dir,'src/host-executor.ts'),hostCode);
 }
 // Package archives never contain node_modules; the fake pnpm below provisions the fixture loader.
 await fs.rm(path.join(f.source,'node_modules'),{recursive:true});
 const log=path.join(f.root,'commands.jsonl');
 await fs.writeFile(path.join(fake,provider),`#!${process.execPath}\nif(${JSON.stringify(provider)}==='corepack'&&process.argv[2]!=='pnpm@10.30.3')throw Error('Unpinned manager');if(process.argv.includes('--version')){console.log('10.30.3');process.exit(0)}const fs=require('fs');fs.mkdirSync('node_modules/tsx/dist',{recursive:true});fs.writeFileSync('node_modules/tsx/dist/loader.mjs','');`,{mode:0o755});
 await fs.writeFile(path.join(fake,'docker'),`#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('ps'))console.log('cid');if(a[0]==='inspect')console.log('sha256:'+'a'.repeat(64));`,{mode:0o755});
 const wrapper=path.join(f.root,'supervisor.mjs'),module=new URL('../src/updates/supervisor.mjs',import.meta.url).href;
 await fs.writeFile(wrapper,`import {supervise} from ${JSON.stringify(module)};const a=new AbortController();process.on('SIGTERM',()=>a.abort());await supervise(${JSON.stringify(f.config.deploymentDir)},a.signal,{discover:async()=>[]});`);
 const start=()=>{const p=spawn(process.execPath,[wrapper],{env:{...process.env,PATH:fake},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);return {p,output:()=>output};};
 const wait=async fn=>{for(let i=0;i<150;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');};
 const first=start();t.after(()=>{first.p.kill('SIGTERM');});
 const heartbeat=()=>read(path.join(f.agent.controlDir,'host-executor/heartbeat.json')).catch(()=>null);
 const oldBeat=await wait(heartbeat);
 const running=path.join(f.agent.controlDir,'host-executor/r_request.running.json');await fs.writeFile(running,'{}');
 const job=await prepare(f.home,'main',{file:await f.pack()});
 const requester=await exec(process.execPath,['--input-type=module','-e',`import {submit} from ${JSON.stringify(new URL('../src/updates/control.mjs',import.meta.url).href)};console.log(JSON.stringify(await submit(${JSON.stringify(f.home)},${JSON.stringify(job.id)},false)));`]);
 assert.equal(JSON.parse(requester.stdout).status,'queued');
 await new Promise(r=>setTimeout(r,1800));assert.equal((await read(path.join(jobPath(f.home,job.id),'job.json'))).status,'queued');
 await fs.rm(running);
 await wait(async()=>{const j=await read(path.join(jobPath(f.home,job.id),'job.json'));if(j.status==='failed'||j.status==='rolled-back')throw Error(JSON.stringify(j)+first.output());return j.status==='completed';});
 const newBeat=await heartbeat();assert.notEqual(newBeat.pid,oldBeat.pid);assert(first.p.exitCode===null);
 assert((await read(path.join(f.agent.controlDir,'update-attention.json'))).id);
 const closed=new Promise(r=>first.p.once('close',r));first.p.kill('SIGTERM');await closed;
 const active=(await read(path.join(f.home,'config.json'))).packageRoot;assert(active.endsWith('/runtime'));
 assert.equal((await read(path.join(jobPath(f.home,job.id),'job.json'))).packageManager.command,provider);
 const second=start();t.after(()=>second.p.kill('SIGTERM'));
 await wait(async()=>{const h=await heartbeat();return h?.pid!==newBeat.pid&&h?.at>newBeat.at;});
 const interrupted=await read(path.join(jobPath(f.home,job.id),'job.json'));interrupted.status='applying';await atomic(path.join(jobPath(f.home,job.id),'job.json'),interrupted);
 await atomic(path.join(f.home,'registry.lock'),{pid:second.p.pid});
 const closed2=new Promise(r=>second.p.once('close',r));second.p.kill('SIGKILL');await closed2;
 const third=start();t.after(()=>third.p.kill('SIGTERM'));
 await wait(async()=>{const j=await read(path.join(jobPath(f.home,job.id),'job.json'));return j.status==='rolled-back';});
 assert.equal((await read(path.join(f.home,'config.json'))).packageRoot,f.old);
 const closed3=new Promise(r=>third.p.once('close',r));third.p.kill('SIGTERM');assert.equal(await closed3,0,third.output());
});

test('npm candidates verify exact version and integrity; automatic policy is enforced again at execution',async t=>{
 const f=await fixture(t),data=await fs.readFile(await f.pack()),original=globalThis.fetch;
 const {createHash}=await import('node:crypto');
 const pkg={name:'@ez-test/example',version:'0.1.1',dist:{tarball:'https://registry.npmjs.org/@ez-test/example/-/example-0.1.1.tgz',integrity:'sha512-'+createHash('sha512').update(data).digest('base64')}};
 globalThis.fetch=async url=>new Response(String(url).endsWith('.tgz')?data:JSON.stringify(pkg));t.after(()=>globalThis.fetch=original);
 const job=await prepare(f.home,'main',{release:'0.1.1'});assert.equal(job.origin.type,'npm');
 await atomic(path.join(f.home,'updates/supervisor.json'),{});await assert.rejects(submit(f.home,job.id,true),/heartbeat/);
 await atomic(path.join(f.home,'updates/supervisor.json'),{at:Date.now()});await submit(f.home,job.id,true);
 await command(f.home,['policy','main','manual']);const r=runtime(f);
 await assert.rejects(perform(f.home,await read(path.join(jobPath(f.home,job.id),'job.json')),r),/policy/);assert.equal(r.calls.length,0);
 pkg.dist.integrity='sha512-bad';await assert.rejects(prepare(f.home,'main',{release:'0.1.1'}),/integrity/);
 pkg.version='0.1.2';await assert.rejects(prepare(f.home,'main',{release:'0.1.1'}),/version mismatch/);
});
