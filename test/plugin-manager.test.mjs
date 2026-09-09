import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {snapshot,init as initManager,validate,compose,locked} from '../src/plugins/manager.mjs';
// Synthetic manager tests explicitly opt out of the product's default packages.
async function init(home,workspace,catalog,hostConfig) {
 const file=path.join(path.dirname(home),'test-catalog.json');
 if(!catalog)await fs.writeFile(file,'{}');
 return initManager(home,workspace,catalog||file,hostConfig);
}
const exec=promisify(execFile),bin=new URL('../bin/ezenciel-agents-tools.mjs',import.meta.url).pathname;
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(tmpdir(),'ez-tools-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),home=path.join(root,'tools'),workspace=path.join(root,'mind'),fake=path.join(root,'fake');
 for(const d of [source,workspace,fake])await fs.mkdir(d);
 const manifest={schemaVersion:1,id:'sample',version:'0.1.0',description:'Synthetic',commands:{sample:{executable:'client.mjs',args:[]}},skills:['SKILL.md']};
 const deployment={schemaVersion:1,services:{sample:{buildTarget:'runtime',volumes:{data:'/data'},workspace:true,healthcheck:['node','--version']}},commands:{sample:{service:'sample',argv:['node','/app/client.mjs'],suffix:[]}}};
 for(const [name,value]of Object.entries({'package.json':JSON.stringify({files:['client.mjs','SKILL.md']}),'ez-plugin.json':JSON.stringify(manifest),'ez-deployment.json':JSON.stringify(deployment),'Dockerfile':'FROM scratch AS runtime','.dockerignore':'','client.mjs':'','SKILL.md':'Synthetic'}))await fs.writeFile(path.join(source,name),value);
 const log=path.join(root,'docker.log');
 await fs.writeFile(path.join(fake,'docker'),`#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),secret:process.env.TELEGRAM_BOT_TOKEN})+'\\n');\nif(process.argv.includes('run')){console.log(JSON.stringify(process.argv.slice(process.argv.indexOf('/app/client.mjs')+1)));process.exit(process.argv.includes('fail')?17:0)}\n`,{mode:0o700});
 const env={...process.env,PATH:fake+path.delimiter+process.env.PATH,TELEGRAM_BOT_TOKEN:'must-not-leak'};
 const call=(...args)=>exec(process.execPath,[bin,'--home',home,...args],{env});
 return {root,source,home,workspace,fake,log,manifest,deployment,env,call};
}
test('catalog paths resolve relative to the catalog and pin each new agent independently',async t=>{
 const f=await fixture(t),catalog=path.join(f.root,'defaults.json');
 await fs.writeFile(catalog,JSON.stringify({sample:'./source'}));
 await initManager(f.home,f.workspace,catalog);
 const first=JSON.parse((await f.call('plugins','available')).stdout);
 assert.equal(first.sample.source,await fs.realpath(f.source));
 await fs.writeFile(path.join(f.source,'SKILL.md'),'new release');
 const second=path.join(f.root,'second');await initManager(second,f.workspace,catalog);
 const next=JSON.parse(await fs.readFile(path.join(second,'config.json'),'utf8'));
 assert.notEqual(first.sample.revision,next.catalog.sample.revision);
 assert.deepEqual(JSON.parse((await f.call('plugins','available')).stdout),first);
});
test('initialization seeds tool guidance and preserves existing mind notes',async t=>{
 const f=await fixture(t);await init(f.home,f.workspace);
 const template=await fs.readFile(new URL('../templates/agent/TOOLS.md',import.meta.url),'utf8');
 const target=path.join(f.workspace,'TOOLS.md');
 assert.ok((await fs.readFile(target,'utf8')).startsWith(template));
 const existing='Owner-maintained tool notes\n';await fs.writeFile(target,existing);
 await init(path.join(f.root,'other-tools'),f.workspace);
 assert.ok((await fs.readFile(target,'utf8')).startsWith(existing));
});
test('bound launcher installs without startup; literal args and exit codes; scopes and secrets',async t=>{
 const f=await fixture(t);const p=await snapshot(f.source);await init(f.home,f.workspace);
 const install=['plugins','install','sample','--source',f.source,'--revision',p.revision];
 await f.call(...install);assert.equal(JSON.parse((await f.call(...install)).stdout).existing,true);
 let lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(lines.length,1);assert(lines[0].argv.includes('build'));assert(!lines[0].argv.includes('up'));assert.equal(lines[0].secret,undefined);
 const literal=['--home','/other','$(touch /tmp/nope)','a b','x;y','--text-file','has spaces.txt'];
 assert.deepEqual(JSON.parse((await exec(path.join(f.home,'bin','ez'),['sample',...literal],{env:f.env})).stdout),literal);
 await assert.rejects(f.call('sample','fail'),e=>e.code===17);
 await assert.rejects(f.call('plugins','start','../sample'));
 await assert.rejects(f.call('tools','install','sample'));
 await f.call('plugins','start','sample');await f.call('plugins','stop','sample');
 await f.call('plugins','uninstall','sample');await assert.rejects(f.call('sample','doctor'));
 await f.call(...install); // preserved snapshot is safe to reuse
 lines=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert(lines.every(x=>x.secret===undefined));assert(lines.every(x=>!x.argv.includes('-v')));
 const mode=(await fs.stat(path.join(f.home,'registry.json'))).mode&0o777;assert.equal(mode,0o600);
});
test('changed source, symlinks, reserved aliases, arbitrary Docker fields rejected',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);await init(f.home,f.workspace);
 await fs.writeFile(path.join(f.source,'client.mjs'),'changed');await assert.rejects(f.call('plugins','install','sample','--source',f.source,'--revision',p.revision));
 await fs.rm(path.join(f.source,'client.mjs'));await fs.symlink('/etc/passwd',path.join(f.source,'client.mjs'));await assert.rejects(snapshot(f.source),/symlink/);
 const d=structuredClone(f.deployment);d.services.sample.privileged=true;assert.throws(()=>validate(f.manifest,d,p.files),/unknown/);
 const m=structuredClone(f.manifest);m.commands={plugins:m.commands.sample};const bad=structuredClone(f.deployment);bad.commands={plugins:bad.commands.sample};assert.throws(()=>validate(m,bad,p.files),/Reserved/);
});
test('registry corruption, active writer lock and alias collision fail closed',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);await init(f.home,f.workspace);
 await locked(f.home,()=>assert.rejects(locked(f.home,()=>{}),/busy/));
 await f.call('plugins','install','sample','--source',f.source,'--revision',p.revision);
 const m={...f.manifest,id:'second'};await fs.writeFile(path.join(f.source,'ez-plugin.json'),JSON.stringify(m));const other=await snapshot(f.source);
 await assert.rejects(f.call('plugins','install','second','--source',f.source,'--revision',other.revision),/collision/);
 await fs.writeFile(path.join(f.home,'registry.json'),'{bad');await assert.rejects(f.call('sample','doctor'));
});
test('Compose resources are namespaced, private, and restricted to owning workspace',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);
 const c=compose({workspace:f.workspace},{source:f.source,project:'ezp-synthetic',revision:p.revision,deployment:p.deployment});
 assert.equal(c.name,'ezp-synthetic');assert.equal(c.services.sample.ports,undefined);assert.equal(c.services.sample.privileged,undefined);assert.equal(c.services.sample.volumes[1].read_only,true);assert.deepEqual(c.services.sample.cap_drop,['ALL']);
});
test('host onboarding binds local ez without replacing global commands',async t=>{
 const f=await fixture(t),native=path.join(f.root,'native'),config=path.join(f.root,'host.json');await fs.mkdir(native);await fs.writeFile(path.join(native,'native-tool'),'hello');
 await fs.writeFile(config,JSON.stringify({cli:'synthetic',agents:[{name:'demo',workspace:f.workspace,binDir:native}]}));
 await init(f.home,f.workspace,undefined,config);const host=JSON.parse(await fs.readFile(config));assert.equal(host.agents[0].binDir,path.join(await fs.realpath(f.home),'bin'));assert.equal(host.agents[0].toolsHome,await fs.realpath(f.home));assert.equal(await fs.readFile(path.join(host.agents[0].binDir,'native-tool'),'utf8'),'hello');
  await assert.rejects(init(f.home,f.workspace),/exists/);
});
test('host install exposes runnable public commands without source aliases',async t=>{
 const f=await fixture(t),native=path.join(f.root,'native'),config=path.join(f.root,'host.json');
 await fs.mkdir(native);
 await fs.symlink('ezenciel-agents-message',path.join(native,'ezenciel-agents-message'));
 await fs.writeFile(config,JSON.stringify({cli:'codex',agents:[{name:'demo',workspace:f.workspace,binDir:native}]}));
 await init(f.home,f.workspace,undefined,config);
 const manifest=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url)));
 for(const [name,entry] of Object.entries(manifest.bin)) assert.equal(await fs.realpath(path.join(f.home,'bin',name)),await fs.realpath(new URL('../'+entry,import.meta.url)));
 const result=await exec(path.join(f.home,'bin','ezenciel-agents-message'),['--help'],{env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH}});
 assert.match(result.stdout,/Usage: ezenciel-agents-message/);
});
test('copying another agent registry is rejected before any Docker operation',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other');await init(f.home,f.workspace);await init(other,f.workspace);
 await fs.copyFile(path.join(f.home,'registry.json'),path.join(other,'registry.json'));
 await assert.rejects(exec(process.execPath,[bin,'--home',other,'tools','list'],{env:f.env}),/Corrupt registry/);
 await assert.rejects(fs.stat(f.log),e=>e.code==='ENOENT');
});

test('v2 supports bounded dependency graphs and generated private secrets',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);
 const d=structuredClone(f.deployment);d.schemaVersion=2;d.secrets=['db-password'];
 d.services.database={image:'example/database@sha256:'+'a'.repeat(64),user:'999:999',healthcheck:['check'],memoryMiB:128,environment:{PASSWORD:{secret:'db-password'}}};
 d.services.sample.dependsOn=['database'];d.services.sample.environment={URL:{secret:'db-password',prefix:'db://',suffix:'@database'}};
 validate(f.manifest,d,p.files);
 const c=compose({workspace:f.workspace},{source:f.source,project:'ezp-synthetic',revision:p.revision,deployment:d},{'db-password':'b'.repeat(64)});
 assert.equal(c.services.database.user,'999:999');assert.equal(c.services.sample.depends_on.database.condition,'service_healthy');assert.equal(c.services.sample.environment.URL,'db://'+'b'.repeat(64)+'@database');
 assert.equal(c.services.database.mem_limit,'128m');assert.throws(()=>compose({workspace:f.workspace}, {source:f.source,project:'ezp-synthetic',revision:p.revision,deployment:d}),/Missing/);
 for(const change of [x=>x.services.database.user='0:0',x=>x.services.database.environment.PASSWORD={secret:'undeclared'},x=>x.services.database.environment.PASSWORD='${HOST_SECRET}',x=>x.services.database.dependsOn=['sample'],x=>x.services.sample.dependsOn=['missing'],x=>x.services.sample.ports=['9999:9999']]){const bad=structuredClone(d);change(bad);assert.throws(()=>validate(f.manifest,bad,p.files));}
 const old=structuredClone(d);old.schemaVersion=1;assert.throws(()=>validate(f.manifest,old,p.files));
});
test('catalog publication pins reviewed source without install or Docker calls',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);await init(f.home,f.workspace);
 await f.call('plugins','catalog-add','sample','--source',f.source,'--revision',p.revision);
 const available=JSON.parse((await f.call('plugins','available')).stdout);assert.equal(available.sample.revision,p.revision);
 assert.deepEqual(JSON.parse((await f.call('tools','list')).stdout),{});await assert.rejects(fs.stat(f.log),e=>e.code==='ENOENT');
 await assert.rejects(f.call('plugins','catalog-add','wrong','--source',f.source,'--revision',p.revision),/pin/);
});

test('plugin help documents data-preserving uninstall without a plugin identifier',async t=>{
 const f=await fixture(t);await init(f.home,f.workspace);
 const help=JSON.parse((await f.call('plugins','--help')).stdout);
 assert.ok(help.commands.includes('uninstall <id>'));assert.match(help.uninstall,/retains all volumes and secrets/);
 for(const action of ['install','uninstall','start'])assert.deepEqual(JSON.parse((await f.call('plugins',action,'--help')).stdout),help);
});

test('inspection reveals stale catalog pin without changing it; explicit repin permits install',async t=>{
 const f=await fixture(t);await init(f.home,f.workspace);
 const old=await snapshot(f.source);
 await f.call('plugins','catalog-add','sample','--source',f.source,'--revision',old.revision);
 await fs.writeFile(path.join(f.source,'SKILL.md'),'Reviewed updated instructions');
 const inspected=JSON.parse((await f.call('plugins','inspect','sample')).stdout);
 assert.equal(inspected.catalogMatches,false);assert.equal(inspected.catalogRevision,old.revision);
 assert.equal(inspected.source,await fs.realpath(f.source));assert.notEqual(inspected.revision,old.revision);
 await assert.rejects(f.call('plugins','install','sample'),/Inspection is read-only/);
 assert.equal(JSON.parse((await f.call('plugins','available')).stdout).sample.revision,old.revision);
 await f.call('plugins','catalog-add','sample','--source',inspected.source,'--revision',inspected.revision);
 assert.equal(JSON.parse((await f.call('plugins','inspect','sample')).stdout).catalogMatches,true);
 assert.equal(JSON.parse((await f.call('plugins','install','sample')).stdout).revision,inspected.revision);
});


test('plugin versions accept SemVer beta releases and reject malformed versions',async t=>{
 const f=await fixture(t),p=await snapshot(f.source);
 for(const version of ['0.1.0','0.1.0-beta.1','1.2.3-rc.0+build.12'])validate({...f.manifest,version},f.deployment,p.files);
 for(const version of ['01.2.3','1.2','1.2.3-beta.01','1.2.3-','1.2.3+','1.2.3/beta',null,{}])assert.throws(()=>validate({...f.manifest,version},f.deployment,p.files),/manifest version/);
});

test('standalone CLI has discoverable setup, independent guidance and status without Telegram',async t=>{
 const f=await fixture(t);
 const help=JSON.parse((await exec(process.execPath,[bin,'--help'])).stdout);
 assert.match(help.usage,/--standalone/);
 await exec(process.execPath,[bin,'init','--standalone','--home',f.home,'--workspace',f.workspace],{env:f.env});
 const notes=await fs.readFile(path.join(f.workspace,'TOOLS.md'),'utf8');
 assert.match(notes,/existing local CLI/);
 assert.doesNotMatch(notes,/Finish the main Telegram|ezenciel-agents-message/);
 const launcher=path.join(f.home,'bin','ez');
 const status=JSON.parse((await exec(launcher,['status'],{cwd:f.root,env:f.env})).stdout);
 assert.equal(status.main,null);assert.deepEqual(status.plugins,[]);
 assert.equal(status.workspace,await fs.realpath(f.workspace));
 await assert.rejects(fs.access(f.log)); // no Docker call during initialization/status
 await assert.rejects(exec(process.execPath,[bin,'init','--standalone','--home',f.home,'--workspace',f.workspace]),/Registry already exists/);
 await fs.writeFile(path.join(f.home,'registry.json'),'{');
 await assert.rejects(exec(launcher,['status']),/JSON/);
});

test('standalone rejects relay binding and preserves literal plugin arguments across callers',async t=>{
 const f=await fixture(t);
 await assert.rejects(initManager(f.home,f.workspace,undefined,'/missing/host.json',true),/cannot bind/);
 await initManager(f.home,f.workspace,undefined,undefined,true);
 const p=await snapshot(f.source);
 await f.call('plugins','install','sample','--source',f.source,'--revision',p.revision);
 const launcher=path.join(f.home,'bin','ez'),args=['sample','--home','/other','$(literal)','--json'];
 for(const cwd of [f.root,f.workspace,f.source]) {
  assert.deepEqual(JSON.parse((await exec(launcher,args,{cwd,env:f.env})).stdout),args.slice(1));
 }
 const log=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert(log.every(call=>call.secret===undefined));
 await fs.writeFile(path.join(f.home,'config.json'),JSON.stringify({schemaVersion:1,workspace:f.workspace,catalog:{},deploymentDir:'/missing'}));
 await assert.rejects(exec(launcher,['status']),/deployment-bound/); // never hide a broken relay binding
});
