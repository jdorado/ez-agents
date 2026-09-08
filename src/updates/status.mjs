import path from 'node:path';
import { read, state, jobs } from './control.mjs';
import { execute, pluginArgs } from './runtime.mjs';

async function heartbeat(file,maxAge,polling=false) {
  try {
    const h=await read(file),fresh=Number.isFinite(h.at)&&h.at<=Date.now()+5000&&Date.now()-h.at<maxAge;
    const running=fresh&&(!polling||h.polling===true);
    return {state:running?'running':'offline',runningVersion:running&&typeof h.version==='string'?h.version:null};
  }catch(error){return {state:error.code==='ENOENT'?'offline':'unknown',runningVersion:null};}
}

async function plugin(record,run) {
  const result={id:record.manifest.id,installedVersion:record.manifest.version,runningVersion:null,state:'unknown',services:[]};
  try {
    const output=(await run('docker',[...pluginArgs(record),'ps','--all','--format','json'],{timeout:15000})).trim();
    const rows=output?output.startsWith('[')?JSON.parse(output):output.split('\n').map(line=>JSON.parse(line)):[];
    for(const [service,spec] of Object.entries(record.deployment.services)) {
      const containers=rows.filter(row=>row.Service===service);
      if(!containers.length){result.services.push({service,state:'not-created',health:null,imageMatches:false});continue;}
      for(const row of containers) {
        const item={service,state:row.State,health:row.Health||null,imageMatches:false};
        result.services.push(item);
        if(row.State!=='running')continue;
        if(!/^[a-f0-9]{12,64}$/.test(row.ID))throw Error('Invalid container identity');
        const expected=spec.image||`${record.project}-${service}:${record.revision.slice(7,23)}`;
        const actual=(await run('docker',['inspect','--format','{{.Image}}',row.ID],{timeout:15000})).trim();
        const desired=(await run('docker',['image','inspect','--format','{{.Id}}',expected],{timeout:15000})).trim();
        item.imageMatches=/^sha256:[a-f0-9]{64}$/.test(actual)&&actual===desired;
      }
    }
    const allRunning=result.services.length>0&&result.services.every(s=>s.state==='running');
    result.state=allRunning?'running':result.services.some(s=>s.state==='running')?'partial':'stopped';
    if(allRunning&&result.services.every(s=>s.imageMatches))result.runningVersion=result.installedVersion;
  }catch {result.state='unknown';result.error='Unable to verify plugin containers/images; check Docker access and the registered Compose project.';}
  return result;
}

export async function status(home,run=execute) {
  const {config,agent}=await state(home),registry=await read(path.join(home,'registry.json'));
  let installedVersion=null;
  try {installedVersion=(await read(path.join(config.packageRoot,'package.json'))).version;}catch {}
  return {
    main:{installedVersion,...await heartbeat(path.join(agent.controlDir,'heartbeat.json'),20000,true),
      host:await heartbeat(path.join(agent.controlDir,'host-executor/heartbeat.json'),15000)},
    plugins:await Promise.all(Object.values(registry.plugins).map(record=>plugin(record,run))),
    jobs:(await jobs(home)).map(({rollback,...job})=>job)
  };
}
