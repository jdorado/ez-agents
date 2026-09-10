import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { runCodexSession } from '../src/codex-session.js'

for(const mode of ['goal','plain','tool-goal','blocked','disconnect','approval','late-limit','early-limit','early-clear','missing-goal'])test(`native Codex session: ${mode}`,async()=>{
  const requests:string[]=[],output:string[]=[]
  const program=`
const rl=require('readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(method,params)=>send({method,params:{threadId:'native-test',...params}});
const start=id=>event('turn/started',{turn:{id,status:'inProgress'}});
const end=id=>event('turn/completed',{turn:{id,status:'completed'}});
let reads=0;
rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;
if(q.method==='initialize')return send({id:q.id,result:{}});
if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:'native-test'}}});
if(q.method==='thread/goal/set'||q.method==='turn/start'){
 send({id:q.id,result:{turn:{id:'one'}}});
 if(${JSON.stringify(mode)}==='early-limit')return event('thread/goal/updated',{goal:{status:'usageLimited'}});
 if(${JSON.stringify(mode)}==='early-clear')return event('thread/goal/cleared',{});
 send({method:'turn/completed',params:{threadId:'unrelated',turn:{id:'unrelated',status:'completed'}}});start('one');
 if(${JSON.stringify(mode)}==='disconnect')return process.exit(0);
 if(${JSON.stringify(mode)}==='approval')return send({id:999,method:'item/commandExecution/requestApproval',params:{threadId:'native-test'}});
 end('one');return;
}
if(q.method==='thread/goal/get'){
 reads++;let status=['plain','missing-goal'].includes(${JSON.stringify(mode)})?null:${JSON.stringify(mode)}==='blocked'?'blocked':reads===1?'active':'complete';
 send({id:q.id,result:{goal:status?{status}:null}});
 if(status==='active'){
  if(${JSON.stringify(mode)}==='late-limit')return setTimeout(()=>event('thread/goal/updated',{goal:{status:'usageLimited'}}),20);
  setTimeout(()=>{start('two');event('thread/goal/updated',{goal:{status:'complete'}});setTimeout(()=>end('two'),30)},20);
 }
}
});setInterval(()=>{},1000);`
  let threadConfig:any
  const launch=()=>{
    const child=spawn(process.execPath,['-e',program],{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'})
    const write=child.stdin.write.bind(child.stdin)
    child.stdin.write=((chunk:any,...args:any[])=>{try{requests.push(JSON.parse(String(chunk)).method);if(JSON.parse(String(chunk)).method==='thread/start')threadConfig=JSON.parse(String(chunk)).params.config}catch{};return (write as any)(chunk,...args)}) as typeof child.stdin.write
    return child
  }
  const plain=['plain','tool-goal'].includes(mode)
  const result=await runCodexSession({workspace:'/tmp',controlDir:'/tmp/control',sharedWorkspace:'/canonical',prompt:'test',goal:!plain},{launch,emit:line=>output.push(line)})
  assert.ok(threadConfig['sandbox_workspace_write.writable_roots'].includes('/canonical'))
  assert.equal(result,['plain','goal','tool-goal'].includes(mode)?0:1)
  assert.equal(requests.filter(x=>x==='turn/start').length,plain?1:0,'transport must not send goal continuation prompts')
  assert.equal(requests.filter(x=>x==='thread/goal/set').length,plain?0:1)
  if(mode==='goal')assert.equal(requests.filter(x=>x==='thread/goal/get').length,2,'must wait for the second turn to complete')
  assert.equal(JSON.parse(output[0]).thread_id,'native-test')
})
