import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export async function nativeTaskBinding(home,environment=process.env) {
  home=await fs.realpath(home);
  const config=JSON.parse(await fs.readFile(path.join(home,'config.json'),'utf8'));
  if(typeof config.hostConfig!=='string'||!path.isAbsolute(config.hostConfig))throw Error('Native tasks require an owning host binding; standalone plugins cannot schedule');
  const hostFile=await fs.realpath(config.hostConfig),workspace=await fs.realpath(config.workspace);
  if(hostFile!==config.hostConfig||[home,workspace].some(root=>hostFile===root||hostFile.startsWith(root+path.sep)))throw Error('Native tasks require an external host binding');
  const host=JSON.parse(await fs.readFile(hostFile,'utf8'));
  if(!Array.isArray(host.agents)||typeof host.cli!=='string'||!host.cli)throw Error('Invalid native host binding');
  const matches=host.agents.filter(a=>a.toolsHome===home&&a.workspace===workspace);
  if(matches.length!==1||typeof matches[0].controlDir!=='string'||!path.isAbsolute(matches[0].controlDir))throw Error('Native task binding does not match owning agent');
  const controlDir=await fs.realpath(matches[0].controlDir);
  const env=Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR'].filter(k=>environment[k]!==undefined).map(k=>[k,environment[k]]));
  return {cwd:workspace,env:{...env,EZ_CONTROL_DIR:controlDir,EZ_AGENT_WORKSPACE:workspace,EZ_EXECUTOR_CLI:host.cli}};
}

export async function nativeTasks(home,args,{signal}={}) {
  if(!Array.isArray(args)||args.length>100||args.some(a=>typeof a!=='string'||a.includes('\0')||a.length>8192))throw Error('Invalid literal scheduler arguments');
  const binding=await nativeTaskBinding(home);
  if(signal?.aborted)throw Error('Request cancelled');
  const entry=fileURLToPath(new URL('../../bin/ezenciel-agents-schedule.mjs',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...args],{...binding,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let stdout='',stderr='',size=0,failure,killTimer;
    const kill=s=>{try {if(process.platform==='win32')child.kill(s);else if(child.pid)process.kill(-child.pid,s);}catch(error){if(error.code!=='ESRCH')failure??=error;}};
    const stop=()=>{failure??=Error('Request cancelled');kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),2000);};
    const timer=setTimeout(()=>{failure=Error('Native scheduler command timed out');stop();},30000);
    const collect=(bytes,isError)=>{size+=bytes.length;if(size>262144){failure=Error('Native scheduler output limit exceeded');stop();return;}if(isError)stderr+=bytes;else stdout+=bytes;};
    child.stdout.on('data',b=>collect(b,false));child.stderr.on('data',b=>collect(b,true));
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);};
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',code=>{cleanup();if(failure)reject(failure);else resolve({code:code??1,stdout,stderr});});
  });
}
