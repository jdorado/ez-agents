// Real Docker replacement using WhatsApp's synthetic transport. No provider calls.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {snapshot,init,atomic} from '../src/plugins/manager.mjs';
import {bindUpdates} from '../src/updates/binding.mjs';
import {prepare,submit,jobPath,read} from '../src/updates/control.mjs';
import {perform} from '../src/updates/runtime.mjs';
const exec=promisify(execFile),root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'ez-upgrade-docker-')));
const source=path.join(root,'source'),home=path.join(root,'tools'),mind=path.join(root,'mind'),control=path.join(root,'control');
const input=path.resolve(process.env.EZ_WHATSAPP_SOURCE||new URL('../../ez_whatsapp',import.meta.url).pathname);
const bin=new URL('../bin/ezenciel-agents-tools.mjs',import.meta.url).pathname;
const call=async(...args)=>JSON.parse((await exec(process.execPath,[bin,'--home',home,...args],{maxBuffer:4*1024*1024})).stdout);
let record;
try {
 for(const dir of [source,mind,control])await fs.mkdir(dir);
 const original=await snapshot(input);
 for(const [name,f]of original.files){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),f.data,{mode:f.mode});}
 await fs.copyFile(path.join(input,'docker/fixture.mjs'),path.join(source,'src/transport.mjs'));
 await init(home,mind);await atomic(path.join(root,'host-executor.json'),{cli:'grok',agents:[{name:'qa',workspace:mind,controlDir:control,toolsHome:home,binDir:path.join(home,'bin')}]});
 await bindUpdates(home,path.join(root,'host-executor.json'));
 const initial=await snapshot(source);await call('plugins','install','whatsapp','--source',source,'--revision',initial.revision);
 record=(await read(path.join(home,'registry.json'))).plugins.whatsapp;
 await call('plugins','start','whatsapp');
 const identity=await call('whatsapp','doctor');const before=await call('whatsapp','inbox');
 const message=path.join(mind,'test-message.txt');await fs.writeFile(message,'Synthetic upgrade fixture');
 const sent=await call('whatsapp','send','--to','+15551230000','--text-file',message,'--idempotency-key','upgrade:fixture');
 const build=async(version,broken=false)=>{
  const pkg=await read(path.join(source,'package.json'));pkg.version=version;await atomic(path.join(source,'package.json'),pkg);
  const manifest=await read(path.join(source,'ez-plugin.json'));manifest.version=version;await atomic(path.join(source,'ez-plugin.json'),manifest);
  if(broken)await fs.writeFile(path.join(source,'src/transport.mjs'),'throw Error("Synthetic broken candidate")');
  const [pack]=JSON.parse((await exec('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:source})).stdout);
  const job=await prepare(home,'whatsapp',{file:path.join(root,pack.filename)});
  await atomic(path.join(home,'updates/supervisor.json'),{at:Date.now()});await submit(home,job.id,false);
  return perform(home,await read(path.join(jobPath(home,job.id),'job.json')),{startHost:()=>{throw Error('Plugin touched host');},stopHost:()=>{throw Error('Plugin touched host');}});
 };
 assert.equal((await build('0.1.0-beta.4')).status,'completed');
 assert.equal((await call('whatsapp','doctor')).data.connected,identity.data.connected);
 assert.equal((await call('whatsapp','inbox')).data.nextCursor,before.data.nextCursor);
 assert.equal((await call('whatsapp','operation','--idempotency-key','upgrade:fixture')).data.providerMessageId,sent.data.providerMessageId);
 assert.equal((await build('0.1.0-beta.5',true)).status,'rolled-back');
 assert.equal((await call('whatsapp','doctor')).data.connected,true);
 assert.equal((await call('whatsapp','operation','--idempotency-key','upgrade:fixture')).data.providerMessageId,sent.data.providerMessageId);
 const current=(await read(path.join(home,'registry.json'))).plugins.whatsapp;
 assert.equal(current.project,record.project);assert.equal(current.manifest.version,'0.1.0-beta.4');
 console.log('PASS: Docker plugin upgrade, private volume backup, retained identity/cursor/operation receipt, failed-health rollback. Synthetic provider only.');
} finally {
 if(record)await exec('docker',['compose','-p',record.project,'-f',record.compose,'down','--volumes']).catch(()=>{});
 // Delete only fixture-owned images and state.
 if(record){const images=(await exec('docker',['image','ls','--filter',`reference=${record.project}-*`,'-q'])).stdout.trim().split('\n').filter(Boolean);if(images.length)await exec('docker',['image','rm',...images]).catch(()=>{});}
 await fs.rm(root,{recursive:true,force:true});
}
