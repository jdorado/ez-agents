import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startExecutorJob } from '../src/executor.js'
import { ownerRun } from './helpers/owner-run.js'
import { initializeWorkspace } from '../src/workspace.js'
import { RunStore } from '../src/runs.js'

// Capture the actual subprocess input, not a prompt-building helper.
test('owner, resumed and native scheduled subprocesses receive literal input and isolated run bindings', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'ez-literal-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const bin=path.join(root,'bin'),workspace=path.join(root,'mind'),controlDir=path.join(root,'control')
 await mkdir(bin);await initializeWorkspace(workspace)
 const fixture=`#!${process.execPath}
const fs=require('fs'), args=process.argv.slice(2);
const capture=prompt=>fs.writeFileSync('capture.json',JSON.stringify({prompt,args,env:{run:process.env.EZ_RUN_ID,control:process.env.EZ_CONTROL_DIR,repair:process.env.EZ_REPAIR_ENABLED,secret:process.env.TELEGRAM_BOT_TOKEN}}));
if(args[0]==='app-server'){
 const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(!q.id)return;
 if(q.method==='initialize')send({id:q.id,result:{}});
 if(q.method==='thread/start')send({id:q.id,result:{thread:{id:'fixture-thread'}}});
 if(q.method==='turn/start'){
  capture(q.params.input[0].text);send({id:q.id,result:{turn:{id:'one'}}});
  send({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'one'}}});
  send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'one',status:'completed'}}});
 }
 if(q.method==='thread/goal/get')send({id:q.id,result:{goal:null}});
 });
}else capture(args.includes('--prompt-file')?fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8'):args.some(a=>a.startsWith('--print='))?args.find(a=>a.startsWith('--print=')).slice(8):args.includes('--print')||(args[0]==='exec'&&args.at(-1)==='-')?fs.readFileSync(0,'utf8'):args.at(-1));
`
 for(const name of ['codex','grok','agy','claude','opencode'])await writeFile(path.join(bin,name),fixture,{mode:0o700})
 const previous={PATH:process.env.PATH,TELEGRAM_BOT_TOKEN:process.env.TELEGRAM_BOT_TOKEN,EZ_EXECUTOR_TRANSPORT:process.env.EZ_EXECUTOR_TRANSPORT}
 process.env.PATH=bin+path.delimiter+process.env.PATH;process.env.TELEGRAM_BOT_TOKEN='do-not-inherit';delete process.env.EZ_EXECUTOR_TRANSPORT
 try {
  for(const cli of ['codex','grok','agy','claude','opencode'])for(const isResume of [false,true])for(const text of ['  /goal audit list of files and give me a simple list with filenames\n','--help','-','resume']) {
   const runId='r_'+cli+'_'+String(isResume)+'_'+Buffer.from(text).toString('hex').slice(0,20)
   await ownerRun(controlDir,runId)
   const job=await startExecutorJob([text],{workspace,controlDir,binDir:bin,cli,runId,timeoutMs:5000,isResume,sessionId:'native-existing',repairEnabled:false})
   const code=await new Promise(resolve=>job.child.once('close',resolve));await job.cleanup();assert.equal(code,0)
   const captured=JSON.parse(await readFile(path.join(workspace,'capture.json'),'utf8'))
   assert.equal(captured.prompt,text)
   assert.deepEqual(captured.env,{run:runId,control:controlDir,repair:'false'})
   if(cli==='codex')assert.equal(captured.args.at(-1),'-')
   if(['codex','claude'].includes(cli))assert.ok(!captured.args.includes('--help'))
   if(cli==='opencode')assert.equal(captured.args.at(-2),'--')
   if(cli==='agy')assert.ok(captured.args.includes('--print='+text))
   if(cli==='claude')assert.ok(!captured.args.includes('--append-system-prompt-file'))
  }
  for(const [runId,texts] of [['r_schedule_literal',['/goal audit list of files and give me a simple list with filenames']],['r_batch',['first\nline','  second  ']]] as const) {
   await ownerRun(controlDir,runId)
   const job=await startExecutorJob([...texts],{workspace,controlDir,binDir:bin,cli:'codex',runId,timeoutMs:5000})
   const code=await new Promise(resolve=>job.child.once('close',resolve));await job.cleanup();assert.equal(code,0)
   assert.equal(JSON.parse(await readFile(path.join(workspace,'capture.json'),'utf8')).prompt,texts.join('\n\n'))
  }
  for(const isResume of [false,true]) {
   const runId='tg_chat_'+String(isResume)
   await new RunStore(controlDir).create({id:runId,chatId:101,telegramUserId:101,texts:['hi'],messageId:42})
   await new RunStore(controlDir).patch(runId,{status:'running'})
   const job=await startExecutorJob(['hi'],{workspace,controlDir,binDir:bin,cli:'codex',runId,timeoutMs:5000,isResume,sessionId:'native-existing'})
   const code=await new Promise(resolve=>job.child.once('close',resolve));await job.cleanup();assert.equal(code,0)
   const {prompt}=JSON.parse(await readFile(path.join(workspace,'capture.json'),'utf8'))
   assert.ok(prompt.startsWith('hi\n\n[Chat context]'))
   assert.equal(prompt.split('[Chat context]').length,2)
   assert.match(prompt,/ezenciel-agents-message/)
   assert.match(prompt,/ezenciel-agents-schedule/)
   assert.match(prompt,/native subagents/)
  }
 }finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value}
})
