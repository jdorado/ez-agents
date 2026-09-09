import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readlink,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {startExecutorJob} from '../src/executor.js'

test('Codex shares only auth through a link and keeps each agent runtime state separate',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-codex-context-'))
 const priorHome=process.env.HOME,priorPath=process.env.PATH
 try{
  await mkdir(path.join(root,'.codex'));await mkdir(path.join(root,'bin'))
  await writeFile(path.join(root,'.codex/auth.json'),'{}')
  await writeFile(path.join(root,'.codex/config.toml'),'# unrelated personal config')
  await writeFile(path.join(root,'bin/codex'),`#!${process.execPath}\nconsole.log(process.env.CODEX_HOME)`,{mode:0o700})
  process.env.HOME=root;process.env.PATH=path.join(root,'bin')+path.delimiter+priorPath
  for(const agent of ['one','two']){
   const controlDir=path.join(root,agent)
   const job=await startExecutorJob(['hello'],{workspace:root,controlDir,binDir:path.join(root,'bin'),cli:'codex',runId:'r_test',timeoutMs:5000})
   let output='';job.child.stdout?.on('data',chunk=>output+=chunk)
   assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0)
   await job.cleanup()
   const home=path.join(controlDir,'cli/codex')
   assert.equal(output.trim(),home)
   assert.deepEqual(await readdir(home),['auth.json'])
   assert.equal(await readlink(path.join(home,'auth.json')),path.join(root,'.codex/auth.json'))
  }
 }finally{
  if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome
  if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath
  await rm(root,{recursive:true,force:true})
 }
})

test('scheduled Codex sessions isolate native state and snapshot only agent configuration',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-codex-task-context-')),controlDir=path.join(root,'control'),bin=path.join(root,'bin')
 const priorHome=process.env.HOME,priorPath=process.env.PATH
 try{
  await mkdir(path.join(root,'.codex'));await mkdir(bin);await mkdir(path.join(controlDir,'cli/codex'),{recursive:true})
  await writeFile(path.join(root,'.codex/auth.json'),'{}');await writeFile(path.join(root,'.codex/config.toml'),'# personal configuration')
  await writeFile(path.join(controlDir,'cli/codex/config.toml'),'# agent configuration')
  await writeFile(path.join(bin,'codex'),`#!${process.execPath}
const fs=require('fs');fs.writeFileSync(process.env.CODEX_HOME+'/observed.json',JSON.stringify({home:process.env.CODEX_HOME,secret:process.env.TELEGRAM_BOT_TOKEN}));
const send=x=>console.log(JSON.stringify(x));require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!q.id)return;
if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:'native'}}});
if(q.method==='turn/start'){send({id:q.id,result:{turn:{id:'one'}}});send({method:'turn/started',params:{threadId:'native',turn:{id:'one'}}});send({method:'turn/completed',params:{threadId:'native',turn:{id:'one',status:'completed'}}});return;}
send({id:q.id,result:q.method==='thread/goal/get'?{goal:null}:{}});});setInterval(()=>{},1000);
`,{mode:0o700})
  process.env.HOME=root;process.env.PATH=bin+path.delimiter+priorPath
  await assert.rejects(startExecutorJob(['test'],{workspace:root,controlDir,binDir:bin,cli:'codex',runId:'r_schedule_/../../escape',timeoutMs:0}),/Invalid native task run ID/)
  await Promise.all(['r_schedule_one','r_schedule_two'].map(async runId=>{
   const job=await startExecutorJob(['test'],{workspace:root,controlDir,binDir:bin,cli:'codex',runId,timeoutMs:0})
   assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0);await job.cleanup()
   const home=path.join(controlDir,'cli/codex/tasks',runId)
   assert.equal(JSON.parse(await readFile(path.join(home,'observed.json'),'utf8')).home,home)
   assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),'# agent configuration')
   assert.equal(await readlink(path.join(home,'auth.json')),path.join(root,'.codex/auth.json'))
  }))
  assert.deepEqual((await readdir(path.join(controlDir,'cli/codex'))).sort(),['config.toml','tasks'])
 }finally{
  if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome
  if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath
  await rm(root,{recursive:true,force:true})
 }
})
