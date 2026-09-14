import * as fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { registry, prepareCommand, run } from './manager.mjs';
import { invokeLease } from './workspace-lease.mjs';
import { nativeTasks,nativeTaskBinding,nativeCommands } from './native-tasks.mjs';
import {captureDeliveryContext} from '../delivery-context.mjs';
import {commandArtifact} from './connection-artifacts.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const reserved = ['coreRequest','coreResponse','coreApprove','coreApproval','coreApprovalResolved','coreCancel'];
const maxFrame = 1048576;
function requestId(value) {if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw Error('Invalid request id');return value;}

// The local owning connection uses the same installed authority as its bound CLI.
export function connectionProtocol({readRegistry,execute,executeNative,listNative=nativeCommands,sendClient,sendPlugin,excludedPlugin}) {
  const active=new Map(),consumed=new Set();let closed=false;
  async function record(alias) {
    const r=await readRegistry(),plugin=r.commands[alias],value=r.plugins[plugin];
    if(!value||plugin===excludedPlugin)throw Error('Unknown or unavailable registered CLI');
    return value;
  }
  async function perform(req,state) {
    const p=req.params??{};
    if(!object(p))throw Error('Invalid request params');
    if(req.method==='tools.native.list') {await readRegistry();return listNative();}
    if(req.method==='tools.native') {
      if(Object.keys(p).some(k=>!['command','args'].includes(k)))throw Error('Unknown native request parameter');
      await readRegistry();
      if(closed||state.abort.signal.aborted)throw Error('Request cancelled');
      if(!executeNative)throw Error('Native task access is unavailable');
      return executeNative(p.args,{signal:state.abort.signal,command:p.command??'schedule'});
    }
    if(req.method==='tools.list') {
      const r=await readRegistry();return Object.entries(r.commands).filter(([,owner])=>owner!==excludedPlugin).map(([alias,owner])=>{
        const v=r.plugins[owner];return {alias,plugin:owner,description:String(v.manifest.description??'').slice(0,200),skillCount:v.manifest.skills.length,revision:v.revision};
      });
    }
    const v=await record(p.alias);
    if(req.method==='tools.skill') {
      const index=p.index,line=p.line??1;
      if(!Number.isInteger(index)||index<0||index>=v.manifest.skills.length||!Number.isInteger(line)||line<1)throw Error('Invalid skill index or line');
      const root=await fs.realpath(v.source),file=await fs.realpath(path.resolve(root,v.manifest.skills[index]));
      if(!file.startsWith(root+path.sep))throw Error('Skill escapes plugin source');
      const handle=await fs.open(file,'r');let text;
      try {const stat=await handle.stat();if(!stat.isFile()||stat.size>maxFrame)throw Error('Skill exceeds read limit');text=await handle.readFile('utf8');}finally{await handle.close();}
      const lines=text.split('\n'),selected=lines.slice(line-1,line+99).join('\n');
      if(Buffer.byteLength(selected)>32768)throw Error('Skill page exceeds read limit');
      return {text:selected,nextLine:line+100<=lines.length?line+100:null};
    }
    let args;
    if(req.method==='tools.help')args=['--help'];
    else if(req.method==='tools.invoke') {
      args=p.args;
      if(!Array.isArray(args)||args.length>100||args.some(a=>typeof a!=='string'||a.includes('\0')||a.length>8192)||p.stdin!==undefined&&(typeof p.stdin!=='string'||Buffer.byteLength(p.stdin)>65536))throw Error('Invalid literal command arguments');
    } else throw Error('Unknown core method');
    if(closed||state.abort.signal.aborted)throw Error('Request cancelled');
    const current=await record(p.alias);
    if(current.revision!==v.revision)throw Error('Plugin changed; discover again');
    return execute(p.alias,args,{revision:v.revision,stdin:req.method==='tools.invoke'?p.stdin:undefined,output:req.method==='tools.invoke'?p.output:undefined,signal:state.abort.signal,invocation:req.method==='tools.invoke'});
  }
  return {
    plugin(frame) {
      if(closed)return;
      if(!object(frame))throw Error('Expected JSON object');
      if(frame.coreCancel){if(reserved.some(k=>k!=='coreCancel'&&k in frame))throw Error('Plugin forged core control frame');const id=requestId(frame.coreCancel.id),state=active.get(id);state?.abort.abort();return;}
      if(reserved.some(k=>k!=='coreRequest'&&k in frame))throw Error('Plugin forged core control frame');
      if(!('coreRequest' in frame)){sendClient(frame);return;}
      const req=frame.coreRequest;if(!object(req))throw Error('Invalid core request');requestId(req.id);
      if(consumed.has(req.id)||active.size>=8||consumed.size>=10000)throw Error('Duplicate or excessive core request');
      consumed.add(req.id);
      const state={abort:new AbortController()};active.set(req.id,state);
      return perform(req,state).then(result=>{if(!closed)sendPlugin({coreResponse:{id:req.id,result}});},error=>{if(!closed)sendPlugin({coreResponse:{id:req.id,error:error.message}});}).finally(()=>{active.delete(req.id);});
    },
    client(frame) {
      if(closed)return;
      if(!object(frame))throw Error('Expected JSON object');
      if(reserved.some(k=>k in frame))throw Error('Client forged core control frame');
      sendPlugin(frame);
    },
    close() {closed=true;for(const state of active.values())state.abort.abort();active.clear();},
  };
}

export function jsonLines(onFrame,onError) {
  let buffer='';const decoder=new StringDecoder('utf8');
  return chunk=>{try {buffer+=decoder.write(chunk);if(Buffer.byteLength(buffer)>maxFrame)throw Error('Connection frame limit exceeded');let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)onFrame(JSON.parse(line));}}catch(error){onError(error);}};
}

export async function connect(home,alias,args,{input=process.stdin,output=process.stdout}={}) {
  const command=await prepareCommand(home,alias,args),abort=new AbortController();let child,protocol,failure;
  const config=JSON.parse(await fs.readFile(path.join(home,'config.json'),'utf8'));
  const nativeBinding=config.hostConfig?await nativeTaskBinding(home):undefined;
  const deliveryContext=nativeBinding?await captureDeliveryContext(nativeBinding.env.EZ_CONTROL_DIR,command.plugin,command.revision):undefined;
  const send=(stream,frame)=>{try {const text=JSON.stringify(frame)+'\n';if(stream?.writableLength>maxFrame||Buffer.byteLength(text)>maxFrame)throw Error('Connection backpressure limit exceeded');stream?.write(text);}catch(error){fail(error);}};
  const fail=error=>{failure??=error;abort.abort();protocol?.close();};
  protocol=connectionProtocol({excludedPlugin:command.plugin,readRegistry:async()=>{const r=await registry(home);if(r.commands[alias]!==command.plugin||r.plugins[command.plugin]?.revision!==command.revision)throw Error('Connected plugin changed; reconnect');return r;},
    listNative:()=>nativeCommands().map(item=>({...item,available:!!nativeBinding&&(item.command!=='message'||!!deliveryContext)})),
    executeNative:(args,options)=>nativeTasks(home,args,{...options,deliveryContext}),
    execute:async(a,argv,options)=>{const release=options.invocation?await invokeLease(home):undefined;try {const c=await prepareCommand(home,a,argv,{revision:options.revision,exclude:command.plugin});if(options.signal.aborted)throw Error('Request cancelled');const execute=overrides=>run(c.argv,{...options,...overrides,container:c.container,capture:true,timeoutMs:30000,maxBytes:262144});return options.output===undefined?await execute({}):await commandArtifact(config.workspace,options.output,execute,{signal:options.signal});}finally{await release?.();}},
    sendClient:frame=>send(output,frame),sendPlugin:frame=>send(child?.stdin,frame)});
  const onInput=jsonLines(frame=>protocol.client(frame),fail),onEnd=()=>{protocol.close();abort.abort();};
  try {
    const result=await run(command.argv,{container:command.container,capture:true,maxBytes:262144,signal:abort.signal,onStdout:jsonLines(frame=>protocol.plugin(frame),fail),onStart:c=>{child=c;input.on('data',onInput);input.once('end',onEnd);input.resume();}});
    if(failure)throw failure;process.exitCode=result.code;
  } finally {input.off('data',onInput);input.off('end',onEnd);input.pause();protocol.close();}
}
