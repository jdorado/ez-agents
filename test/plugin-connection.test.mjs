import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectionProtocol,jsonLines } from '../src/plugins/connection.mjs';
import { workspaceLease,invokeLease,recoverNativeLease } from '../src/plugins/workspace-lease.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
  const r={commands:{voice:'voice',notes:'notes'},plugins:{voice:{},notes:{revision:'one',manifest:{description:'Notes',skills:[]}}}};
  const client=[],plugin=[],calls=[];
  const protocol=connectionProtocol({readRegistry:async()=>r,excludedPlugin:'voice',sendClient:x=>client.push(x),sendPlugin:x=>plugin.push(x),execute:async(...args)=>{calls.push(args);return {code:0,stdout:'ok',stderr:''};},...options});
  const request=(method,params={},id='r1')=>protocol.plugin({coreRequest:{id,method,params}});
  return {r,client,plugin,calls,protocol,request};
}
test('discovery follows installed registry; self and missing aliases are unavailable',async()=>{
  const f=fixture();f.request('tools.list');await tick();assert.equal(f.plugin[0].coreResponse.result[0].alias,'notes');
  delete f.r.commands.notes;f.request('tools.list',{},'r2');await tick();assert.deepEqual(f.plugin[1].coreResponse.result,[]);
  for(const alias of ['voice','missing','notes']){f.request('tools.help',{alias},alias);await tick();assert.match(f.plugin.at(-1).coreResponse.error,/unavailable/);}
  assert.equal(f.calls.length,0);
});
test('trusted connection invokes literal command once without a permission exchange',async()=>{
  const f=fixture();await f.request('tools.invoke',{alias:'notes',args:['read','a; $(x)'],stdin:'literal input'});
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].slice(0,2),['notes',['read','a; $(x)']]);assert.equal(f.calls[0][2].stdin,'literal input');assert.deepEqual(f.client,[]);assert.equal(f.plugin[0].coreResponse.result.code,0);
  assert.throws(()=>f.request('tools.invoke',{alias:'notes',args:[]}),/Duplicate/);assert.equal(f.calls.length,1);
  await f.request('tools.invoke',{alias:'notes',args:[{}]},'invalid');assert.match(f.plugin.at(-1).coreResponse.error,/literal/);assert.equal(f.calls.length,1);
});
test('native task access uses the separate fixed scheduler adapter',async()=>{
  const native=[];const f=fixture({executeNative:async(args)=>{native.push(args);return {code:0,stdout:'help',stderr:''};}});
  await f.request('tools.native',{args:['--help']});assert.deepEqual(native,[['--help']]);assert.equal(f.calls.length,0);assert.equal(f.plugin[0].coreResponse.result.stdout,'help');
  const unavailable=fixture();await unavailable.request('tools.native',{args:['--help']});assert.match(unavailable.plugin[0].coreResponse.error,/unavailable/);
  await f.request('tools.native',{args:['--help'],deliveryContext:{owner:'forged'}},'forged');assert.match(f.plugin.at(-1).coreResponse.error,/parameter/);assert.equal(native.length,1);
});
test('registry revision change during admission prevents invocation',async()=>{
  let reads=0;const f=fixture({readRegistry:async()=>({commands:{notes:'notes'},plugins:{notes:{revision:++reads===1?'one':'two'}}})});
  await f.request('tools.invoke',{alias:'notes',args:[]});assert.match(f.plugin[0].coreResponse.error,/changed/);assert.equal(f.calls.length,0);
});
test('reserved frames cannot cross authority directions; cancellation aborts running call',async()=>{
  let signal;const f=fixture({execute:async(a,args,opts)=>{signal=opts.signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({code:130})));}});
  for(const key of ['coreRequest','coreResponse','coreApprove','coreApproval','coreApprovalResolved'])assert.throws(()=>f.protocol.client({[key]:{}}),/forged/);
  for(const key of ['coreResponse','coreApprove','coreApproval','coreApprovalResolved'])assert.throws(()=>f.protocol.plugin({[key]:{}}),/forged/);
  const first=f.request('tools.invoke',{alias:'notes',args:[]});await tick();assert.equal(signal.aborted,false);f.protocol.plugin({coreCancel:{id:'r1'}});assert.equal(signal.aborted,true);await first;assert.equal(f.plugin[0].coreResponse.result.code,130);assert.deepEqual(f.client,[]);
  const second=f.request('tools.invoke',{alias:'notes',args:[]},'r2');await tick();f.protocol.close();assert.equal(signal.aborted,true);await second;
});
test('declared skill reads are bounded and reject traversal and escaping symlinks',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ez-skill-'));
  try {await fs.mkdir(path.join(dir,'plugin'));await fs.writeFile(path.join(dir,'private'),'secret');await fs.writeFile(path.join(dir,'plugin','SKILL.md'),'hello');await fs.symlink(path.join(dir,'private'),path.join(dir,'plugin','link'));
    const f=fixture();f.r.plugins.notes.source=path.join(dir,'plugin');f.r.plugins.notes.manifest.skills=['SKILL.md','../private','link'];
    await f.request('tools.skill',{alias:'notes',index:0});assert.equal(f.plugin[0].coreResponse.result.text,'hello');
    for(const index of [1,2]){await f.request('tools.skill',{alias:'notes',index},'escape'+index);assert.match(f.plugin.at(-1).coreResponse.error,/escapes/);}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('JSONL rejects malformed and oversized input',()=>{
  const frames=[],errors=[];const parse=jsonLines(f=>frames.push(f),e=>errors.push(e));parse(Buffer.from('{"ok":true}\n'));assert.equal(frames.length,1);parse(Buffer.from('bad\n'));assert.equal(errors.length,1);parse(Buffer.alloc(1048577,97));assert.equal(errors.length,2);
});
test('completed request IDs cannot replay and early cancellation prevents execution',async()=>{
  const f=fixture();f.request('tools.list');await tick();assert.throws(()=>f.request('tools.list'),/Duplicate/);
  f.request('tools.invoke',{alias:'notes',args:[]},'early');f.protocol.plugin({coreCancel:{id:'early'}});await tick();assert.match(f.plugin.at(-1).coreResponse.error,/cancelled/);assert.equal(f.client.length,0);assert.equal(f.calls.length,0);
});
test('shared workspace lease excludes concurrent writers and refuses queued native work',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ez-lease-'));
  try {
    await fs.writeFile(path.join(dir,'config.json'),'{}');const release=await workspaceLease(dir);assert.equal(await workspaceLease(dir),undefined);await assert.rejects(invokeLease(dir),/busy/);await release();
    await fs.mkdir(path.join(dir,'host-executor'));await fs.writeFile(path.join(dir,'host.json'),JSON.stringify({agents:[{toolsHome:dir,workspace:dir,controlDir:dir}]}));await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({hostConfig:path.join(dir,'host.json'),workspace:dir}));await fs.writeFile(path.join(dir,'host-executor','r.request.json'),'{}');await assert.rejects(invokeLease(dir),/pending/);await fs.rm(path.join(dir,'host-executor','r.request.json'));const unlock=await invokeLease(dir);await unlock();
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('command output bound and timeout remove exact containers without leaking daemon secrets',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ez-bound-'));
  try {
    await fs.writeFile(path.join(dir,'docker'),`#!${process.execPath}\nif(process.env.TELEGRAM_BOT_TOKEN)process.exit(99);if(process.argv[2]==='container')process.exit(0);if(process.argv[2]==='loud')process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);`,{mode:0o700});
    const url=new URL('../src/plugins/manager.mjs',import.meta.url).href;
    for(const [arg,options,expected] of [['loud',{maxBytes:100},'output limit'],['wait',{timeoutMs:25},'timed out']]){
      const script=`import {run} from ${JSON.stringify(url)};try{await run([${JSON.stringify(arg)}],{capture:true,container:'bound-test',...${JSON.stringify(options)}});process.exitCode=9}catch(e){console.log(e.message)}`;
      const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,TELEGRAM_BOT_TOKEN:'private'},timeout:10000});assert.match(result.stdout,new RegExp(expected));
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('startup recovers dead native leases but preserves live owners and surfaces dead plugin leases',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ez-recover-')),file=path.join(dir,'workspace-writer.lock');
  try {
    const result=await promisify(execFile)(process.execPath,['-e','console.log(process.pid)']);const deadPid=Number(result.stdout.trim());
    await fs.writeFile(file,JSON.stringify({pid:process.pid,kind:'native'}));await recoverNativeLease(dir);await fs.access(file);
    await fs.writeFile(file,JSON.stringify({pid:deadPid,kind:'native',runId:'r_test'}));await recoverNativeLease(dir);await assert.rejects(fs.access(file),{code:'ENOENT'});
    await fs.writeFile(file,JSON.stringify({pid:deadPid,kind:'plugin'}));await assert.rejects(recoverNativeLease(dir),/verify command containers stopped/);await fs.access(file);await assert.rejects(workspaceLease(dir),/Stale/);
    await fs.writeFile(file,'{}');await assert.rejects(recoverNativeLease(dir),/Invalid/);await fs.access(file);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
