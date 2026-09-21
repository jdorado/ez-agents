import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {preflight,installationStatus,build,hostEnvironment} from '../src/install-tools.mjs';
import {RunStore} from '../src/runs.js';
import {serveTestLedger} from './helpers/ledger.js';

async function fixture(t){const root=await fs.mkdtemp(path.join(tmpdir(),'ez-install-tools-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('preflight checks the selected executable and reports missing prerequisites without credentials',async t=>{
  const home=await fixture(t),binary=path.join(home,'codex');await fs.writeFile(binary,'#!/bin/sh\nexit 0',{mode:0o755});
  const invoke=async(cmd)=>{if(cmd==='pnpm')return '10.30.3';if(cmd==='docker')throw Error('Docker unavailable');return 'codex fixture';};
  const result=await preflight({home,executor:binary},invoke);assert.equal(result.ok,false);
  assert.equal(result.checks.find(c=>c.name==='executor').path,binary);assert.equal(result.checks.find(c=>c.name==='executor').sandboxVerified,false);
  assert.equal(result.checks.find(c=>c.name==='docker').ok,false);
  const absent=await preflight({home,executor:path.join(home,'missing')},invoke);assert.equal(absent.checks.find(c=>c.name==='executor').ok,false);
  const previous=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='must-not-leak';
  try{assert.equal(hostEnvironment().TELEGRAM_BOT_TOKEN,undefined);}finally{if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;}
});
test('installation status separates files, pairing and current-owner Telegram delivery evidence',async t=>{
  const root=await fixture(t),control=path.join(root,'control');
  assert.equal((await installationStatus(root)).stage,'not-configured');
  await fs.mkdir(path.join(control,'host-executor'),{recursive:true});
  for(const name of ['agent.json','host-executor.json','docker.env','relay.env'])await fs.writeFile(path.join(root,name),'private');
  const write=(name,obj)=>fs.writeFile(path.join(control,name),JSON.stringify(obj));
  await write('heartbeat.json',{at:Date.now(),polling:true});await write('host-executor/heartbeat.json',{at:Date.now()});
  // Delivery evidence comes from the running relay's memory ledger.
  const ledger=await serveTestLedger(control,()=>({polling:true,applicationOnly:false,telegramConfigured:true,version:'test'}));t.after(()=>ledger.stop());
  assert.equal((await installationStatus(root)).stage,'awaiting-owner');
  await fs.writeFile(path.join(root,'agent.json'),JSON.stringify({isolation:'isolated'}));
  await fs.rm(path.join(control,'host-executor/heartbeat.json'));
  assert.equal((await installationStatus(root)).stage,'awaiting-owner');
  await fs.writeFile(path.join(root,'agent.json'),'private');
  await write('host-executor/heartbeat.json',{at:Date.now()});
  assert.equal((await installationStatus(root)).stage,'awaiting-owner');
  const owner={telegramUserId:123,telegramChatId:123,pairedAt:new Date(Date.now()-10000).toISOString()};await write('control-state.json',{owner});
  assert.equal((await installationStatus(root)).stage,'awaiting-telegram-reply');
  const runs=new RunStore(control),deliver=async(id,text,chatId,telegramUserId,ids,status='completed')=>{
    const run=await runs.create({id,chatId,telegramUserId,texts:[text]});
    await runs.patch(run.id,{status:'running'});
    const item=await runs.enqueueMessage(run.id,text);
    await runs.claimOutbox(item.id);await runs.markOutboxSent(item.id,ids);
    await runs.patch(run.id,{status});
  };
  // Another chat member's completed delivery is not the owner's reply evidence.
  await deliver('tg_13','other member',123,999,[42]);
  assert.equal((await installationStatus(root)).telegramReplyVerified,false);
  // A failed run never counts, even with a receipt.
  await deliver('tg_14','failed',123,123,[43],'failed');
  assert.equal((await installationStatus(root)).telegramReplyVerified,false);
  await deliver('tg_12','hello',123,123,[42]);
  assert.equal((await installationStatus(root)).stage,'ready-for-telegram-plugin-request');
  // With the relay down, status falls back to the legacy heartbeat file.
  await ledger.stop();await write('heartbeat.json',{at:0,polling:true});assert.equal((await installationStatus(root)).stage,'runtime-offline');
  await fs.writeFile(path.join(control,'control-state.json'),'{');await assert.rejects(installationStatus(root));
});
test('same-artifact build retries do not spawn a second Docker build and reuse verified completed image',async t=>{
  const home=await fixture(t),source=path.join(home,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'package.json'),'{}');
  let started,finish,count=0;const running=new Promise(r=>started=r),held=new Promise(r=>finish=r);
  const invoke=async(cmd,args)=>{if(cmd==='npm')return JSON.stringify([{files:[{path:'package.json'}]}]);if(args[0]==='build'){count++;started();await held;}return 'sha256:fixture';};
  const first=build({home,source},invoke);await running;
  assert.equal((await build({home,source},invoke)).state,'busy-or-interrupted');assert.equal(count,1);
  finish();const result=await first;assert.equal(result.state,'completed');
  assert.equal((await build({home,source},invoke)).reused,true);assert.equal(count,1);
  await fs.writeFile(path.join(source,'package.json'),'{"changed":true}');await build({home,source},invoke);assert.equal(count,2);
});
test('source checkouts build RCs only: clean reviewed commit plus increasing label',async t=>{
  const home=await fixture(t),source=path.join(home,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'package.json'),'{}');
  let inside=true,status='',built=[];const sha='a'.repeat(40);
  const invoke=async(cmd,args)=>{
    if(cmd==='npm')return JSON.stringify([{files:[{path:'package.json'}]}]);
    if(cmd==='git'){
      if(!inside)throw Error('not a git repository');
      if(args[2]==='rev-parse'&&args[3]==='--is-inside-work-tree')return 'true';
      if(args[2]==='status')return status;
      if(args[2]==='rev-parse'&&args[3]==='HEAD')return sha;
      return '';
    }
    if(args[0]==='build'){built.push(args);return 'image';}
    return 'sha256:fixture';
  };
  await assert.rejects(build({home,source},invoke),/requires --label/);
  await assert.rejects(build({home,source,label:'0.1.0-beta.36'},invoke),/RC label/);
  status=' M src/executor.ts';
  await assert.rejects(build({home,source,label:'0.1.0-beta.36.rc.2'},invoke),/Commit the reviewed source/);
  status='';
  const result=await build({home,source,label:'0.1.0-beta.36.rc.2'},invoke);
  assert.equal(result.label,'0.1.0-beta.36.rc.2');assert.equal(result.sha,sha);
  const args=built.at(-1);
  assert.ok(args.includes('BUILD_TAG=0.1.0-beta.36.rc.2'));assert.ok(args.includes(`BUILD_SHA=${sha}`));
  assert.ok(args.includes('ezenciel-agents:0.1.0-beta.36.rc.2'));
  inside=false;
  await assert.rejects(build({home,source,label:'0.1.0-beta.36.rc.2'},invoke),/--label requires a git checkout/);
});
test('a failed build releases its own lock and leaves a failure receipt for diagnosis',async t=>{
  const home=await fixture(t),source=path.join(home,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'package.json'),'{}');
  const invoke=async(cmd)=>{if(cmd==='npm')return JSON.stringify([{files:[{path:'package.json'}]}]);throw Error('Synthetic build failed');};
  await assert.rejects(build({home,source},invoke),/Synthetic/);
  const [id]=await fs.readdir(path.join(home,'builds'));const dir=path.join(home,'builds',id);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'status.json'))).state,'failed');await assert.rejects(fs.access(path.join(dir,'lock')));
});
test('source changes during a build cannot produce a reusable success receipt',async t=>{
  const home=await fixture(t),source=path.join(home,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'package.json'),'{}');
  const invoke=async(cmd,args)=>{if(cmd==='npm')return JSON.stringify([{files:[{path:'package.json'}]}]);if(args[0]==='build')await fs.writeFile(path.join(source,'package.json'),'{"changed":true}');return 'image';};
  await assert.rejects(build({home,source},invoke),/changed during build/);
});
