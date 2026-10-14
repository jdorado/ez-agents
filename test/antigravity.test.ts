import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXECUTOR_REGISTRY, nativeSessionId, startExecutorJob, terminateJob } from '../src/executor.js'
import { ControlStore } from '../src/control-state.js'
import { initialPreset, isPreset, readAntigravityModels, readModels, validateSelection } from '../src/ai.js'
import { discoverDefaults } from '../src/client-defaults.js'
import { ownerRun } from './helpers/owner-run.js'

const fixture = `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const prompt=JSON.parse(input).message.content;
 const prior=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:undefined;
 const id=prior||require('crypto').randomUUID();
 fs.writeFileSync('capture.json',JSON.stringify({prompt,args,id,secret:process.env.TELEGRAM_BOT_TOKEN,otherSecret:process.env.GEMINI_API_KEY,run:process.env.EZ_RUN_ID}));
 process.stdout.write(JSON.stringify({event:'init',conversation_id:id,init:{cwd:process.cwd()}})+'\\n');
 if(prompt==='wait')setInterval(()=>{},1000);
 else process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'fixture'}})+'\\n');
});`

test('Antigravity uses exact native IDs, literal stdin and the same headless approval flag as Claude', () => {
 const build=EXECUTOR_REGISTRY.agy.buildArgs
 const args=build({workspace:'/mind',controlDir:'/control',toolsHome:'/tools',isResume:true,sessionId:'native-first',model:'native-model',effort:'high'},'', '--help')
 assert.deepEqual(args,['--input-format','stream-json','--output-format','stream-json','--print-timeout','0','--dangerously-skip-permissions','--conversation','native-first','--add-dir','/control','--add-dir','/tools','--model','native-model','--effort','high'])
 assert.ok(!args.includes('--continue') && !args.includes('--help'))
 assert.ok(EXECUTOR_REGISTRY.claude.buildArgs({workspace:'/mind'},'','hi').includes('--dangerously-skip-permissions'))
 assert.throws(()=>build({workspace:'/mind',isResume:true},'','hi'),/native conversation ID/)
 assert.throws(()=>build({workspace:'/mind',isResume:true,sessionId:'../other'},'','hi'),/native conversation ID/)
 assert.throws(()=>build({workspace:'/mind',effort:'ultra'},'','hi'),/reasoning effort/)
 assert.equal(nativeSessionId('agy',JSON.stringify({event:'init',conversation_id:'native-first'})),'native-first')
 assert.equal(nativeSessionId('agy',JSON.stringify({event:'step_update',conversation_id:'other'})),undefined)
 assert.equal(nativeSessionId('agy',JSON.stringify({event:'init',conversation_id:'../other'})),undefined)
 assert.equal(nativeSessionId('agy','resume native-first'),undefined)
})

test('native Antigravity catalog admits only its advertised models and retains client defaults', async () => {
 const run=async(args:string[])=>{
  assert.deepEqual(args,['models'])
  return 'Available models:\nModel    Name\ngemini-native-high     Native High\ngemini-native-high     Duplicate\nbad$id     Invalid\n'
 }
 assert.deepEqual(await readAntigravityModels(run),[{cli:'agy',model:'gemini-native-high',name:'Native High',efforts:['low','medium','high','xhigh','max']}])
 const catalog=await readModels(undefined,async cli=>cli==='agy',undefined,undefined,undefined,undefined,undefined,undefined,undefined,run)
 assert.equal(catalog.length,2)
 await validateSelection({id:'test',name:'Test',cli:'agy',model:'gemini-native-high',effort:'high'},catalog,async()=>true)
 await assert.rejects(validateSelection({id:'bad',name:'Bad',cli:'agy',model:'invented'},catalog,async()=>true),/installed client catalog/)
 assert.equal(isPreset(initialPreset('agy')),true)
 assert.equal((await discoverDefaults('/tmp',{available:async cli=>cli==='agy'}))[0].model,undefined)
 assert.deepEqual(await readAntigravityModels(async()=>{throw new Error('unauthenticated')}),[])
})

test('Antigravity discovery accepts the actual native single-tab model table', async () => {
 const nativeOutput = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
 ].join('\n')
 const rows=await readAntigravityModels(async()=>nativeOutput)
 assert.equal(rows.length,10)
 assert.deepEqual(rows.map(row=>[row.model,row.name]),nativeOutput.split('\n').map(line=>line.split('\t')))
 assert.deepEqual(await readAntigravityModels(async()=>'warning single-space diagnostic\n'),[])
})

test('interleaved application scopes capture and resume their own Antigravity subprocesses; cancellation and secrets remain isolated', async t => {
 const root=await mkdtemp(path.join(tmpdir(),'ez-agy-'))
 const bin=path.join(root,'bin'),workspace=path.join(root,'mind'),controlDir=path.join(root,'control')
 await mkdir(bin);await mkdir(workspace);await writeFile(path.join(bin,'agy'),fixture,{mode:0o700})
 const previous={PATH:process.env.PATH,EZ_EXECUTOR_TRANSPORT:process.env.EZ_EXECUTOR_TRANSPORT,TELEGRAM_BOT_TOKEN:process.env.TELEGRAM_BOT_TOKEN,GEMINI_API_KEY:process.env.GEMINI_API_KEY}
 process.env.PATH=bin+path.delimiter+process.env.PATH;delete process.env.EZ_EXECUTOR_TRANSPORT
 process.env.TELEGRAM_BOT_TOKEN='relay-secret';process.env.GEMINI_API_KEY='unrelated-provider-secret'
 t.after(async()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(root,{recursive:true,force:true})})
 const store=new ControlStore(controlDir,1000),initial=initialPreset('codex'),agy=initialPreset('agy')
 const one=await store.captureApplicationChoice(initial,'a'.repeat(64),false,agy)
 const two=await store.captureApplicationChoice(initial,'b'.repeat(64),false,agy)
 const turn=async(choice:typeof one,prompt:string,runId:string)=>{
  await ownerRun(controlDir,runId)
  const session=await store.executionSession(choice)
  const job=await startExecutorJob([prompt],{workspace,controlDir,binDir:bin,cli:'agy',runId,timeoutMs:5000,isResume:session.hasStarted,sessionId:session.nativeSessionId,onSession:id=>store.saveNativeSession(choice.sessionId,id)})
  const code=await new Promise(resolve=>job.child.once('close',resolve));await job.cleanup();assert.equal(code,0)
  const capture=JSON.parse(await readFile(path.join(workspace,'capture.json'),'utf8'))
  assert.equal(capture.prompt,prompt);assert.equal(capture.secret,undefined);assert.equal(capture.otherSecret,undefined);assert.equal(capture.run,runId)
  return capture
 }
 const first=await turn(one,'--help\n/goal literal input','tg_agy_one')
 const second=await turn(two,'independent scope','tg_agy_two')
 assert.notEqual(first.id,second.id)
 const resumed=await turn(one,'resume first only','tg_agy_resume')
 assert.equal(resumed.id,first.id);assert.equal(resumed.args[resumed.args.indexOf('--conversation')+1],first.id)
 assert.equal((await store.executionSession(two)).nativeSessionId,second.id)
 assert.equal((await store.aiState(initial)).defaultId,initial.id)
 assert.equal((await store.aiState(initial)).selectedId,initial.id)
 const third=await store.captureApplicationChoice(initial,'c'.repeat(64),false,agy)
 await store.markSessionStarted(third.sessionId)
 await assert.rejects(store.executionSession(third),/Native session ID missing/)
 await ownerRun(controlDir,'tg_agy_cancel')
 const job=await startExecutorJob(['wait'],{workspace,controlDir,binDir:bin,cli:'agy',runId:'tg_agy_cancel',timeoutMs:0})
 const closed=new Promise(resolve=>job.child.once('close',resolve))
 await terminateJob(job.child);await closed;await job.cleanup()
 assert.notEqual(job.child.exitCode,0)
})
