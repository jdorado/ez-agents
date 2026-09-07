// Explicit opt-in: node docker/plugin-smoke.mjs. Only synthetic provider data.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {snapshot,init} from '../src/plugins/manager.mjs';
const exec=promisify(execFile),bin=new URL('../bin/ezenciel-agents-tools.mjs',import.meta.url).pathname;
const root=await fs.mkdtemp(path.join(tmpdir(),'ez-plugin-docker-'));
const source=path.join(root,'source'),home=path.join(root,'tools'),mind=path.join(root,'mind');
const whatsappSource=path.resolve(process.env.EZ_WHATSAPP_SOURCE || new URL('../../ez_whatsapp',import.meta.url).pathname);
let record;
const call=async(...args)=>(await exec(process.execPath,[bin,'--home',home,...args],{maxBuffer:4*1024*1024})).stdout;
try {
 await fs.mkdir(source);await fs.mkdir(mind);
 const original=await snapshot(whatsappSource);
 for(const [name,f]of original.files) {await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.writeFile(path.join(source,name),f.data,{mode:f.mode});}
 await fs.copyFile(path.join(whatsappSource,'docker/fixture.mjs'),path.join(source,'src/transport.mjs'));
 const m=JSON.parse(await fs.readFile(path.join(source,'ez-plugin.json')));m.commands.probe={executable:'bin/ez-whatsapp.mjs',args:[]};await fs.writeFile(path.join(source,'ez-plugin.json'),JSON.stringify(m));
 const d=JSON.parse(await fs.readFile(path.join(source,'ez-deployment.json')));d.commands.probe={service:'whatsapp',argv:['node','-e',"console.log('ready');setInterval(()=>{},1000)"]};await fs.writeFile(path.join(source,'ez-deployment.json'),JSON.stringify(d));
 const p=await snapshot(source);await init(home,mind);
 console.log('Installing isolated WhatsApp snapshot with synthetic transport…');
 const installed=JSON.parse(await call('plugins','install','whatsapp','--source',source,'--revision',p.revision));assert.equal(installed.started,false);
 record=JSON.parse(await fs.readFile(path.join(home,'registry.json'))).plugins.whatsapp;
 await call('plugins','start','whatsapp');
 assert.equal(JSON.parse(await call('whatsapp','doctor','--json')).data.connected,true);
 const first=JSON.parse(await call('whatsapp','inbox')).data;
 assert.equal(first.messages.length,1);
 const text=path.join(await fs.realpath(mind),'literal $(no execution) message.txt');await fs.writeFile(text,'Synthetic registry test');
 const send=JSON.parse(await call('whatsapp','send','--to','+15551230000','--text-file',text,'--idempotency-key','registry:qa')).data;
 assert.equal(send.state,'accepted');
 const duplicate=JSON.parse(await call('whatsapp','send','--to','+15551230000','--text-file',text,'--idempotency-key','registry:qa')).data;assert.equal(duplicate.providerMessageId,send.providerMessageId);
 await call('plugins','stop','whatsapp');await call('plugins','start','whatsapp');
 assert.equal(JSON.parse(await call('whatsapp','operation','--idempotency-key','registry:qa')).data.providerMessageId,send.providerMessageId);
 assert.equal(JSON.parse(await call('whatsapp','inbox')).data.nextCursor,first.nextCursor);
 const probe=spawn(process.execPath,[bin,'--home',home,'probe'],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Probe never started')),20000);probe.stdout.once('data',()=>{clearTimeout(timeout);resolve();});});
 const closed=new Promise(resolve=>probe.once('close',resolve));probe.kill('SIGTERM');assert.equal(await closed,130);
 const clients=(await exec('docker',['ps','-a','--filter',`name=${record.project}-call-`,'--format','{{.Names}}'])).stdout.trim();assert.equal(clients,'');
 assert.equal(JSON.parse(await call('whatsapp','doctor')).data.connected,true);
 await call('plugins','uninstall','whatsapp');
 const volumes=(await exec('docker',['volume','ls','--filter',`label=com.docker.compose.project=${record.project}`,'--format','{{.Name}}'])).stdout.trim();assert(volumes);
 console.log('PASS: install without startup; registered CLI; synthetic account/read/send; literal file path; idempotency; stop/start persistence; data-preserving uninstall. No real provider calls.');
} catch(error) { if(record)console.error((await exec('docker',['compose','-p',record.project,'-f',record.compose,'logs','--tail','30']).catch(()=>({stdout:''}))).stdout);throw error; } finally {
 if(record){await exec('docker',['compose','-p',record.project,'-f',record.compose,'down','--volumes']).catch(()=>{});await exec('docker',['image','rm',`${record.project}-whatsapp:${record.revision.slice(7,23)}`]).catch(()=>{});}
 await fs.rm(root,{recursive:true,force:true});
}
