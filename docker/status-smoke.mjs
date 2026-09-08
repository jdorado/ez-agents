import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {status} from '../src/updates/status.mjs';
import {execute} from '../src/updates/runtime.mjs';

const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'ez-status-smoke-')));
const home=path.join(root,'tools'),workspace=path.join(root,'mind'),controlDir=path.join(root,'control');
const project='ez-status-'+randomUUID().slice(0,8),compose=path.join(root,'compose.json');
const image=process.env.EZ_RELAY_IMAGE||'ezenciel-agents:local';
const docker=args=>execute('docker',['compose','--project-name',project,'--file',compose,...args]);
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value),{mode:0o600});
try {
  for(const dir of [home,workspace,controlDir])await fs.mkdir(dir,{mode:0o700});
  await write(path.join(home,'config.json'),{schemaVersion:1,workspace,deploymentDir:root,packageRoot:fileURLToPath(new URL('../',import.meta.url))});
  await write(path.join(root,'host-executor.json'),{agents:[{workspace,controlDir,toolsHome:home}]});
  await write(path.join(home,'registry.json'),{plugins:{sample:{manifest:{id:'sample',version:'0.1.2'},project,compose,deployment:{services:{sample:{image}}}}}});
  await write(compose,{services:{sample:{image,entrypoint:['node','-e','setInterval(()=>{},1000)'],user:'1000:1000',network_mode:'none',cap_drop:['ALL']}}});
  await docker(['up','-d']);
  let p=(await status(home)).plugins[0];
  assert.equal(p.state,'running');assert.equal(p.runningVersion,'0.1.2');assert.equal(p.services[0].imageMatches,true);
  await docker(['stop']);p=(await status(home)).plugins[0];
  assert.equal(p.state,'stopped');assert.equal(p.installedVersion,'0.1.2');assert.equal(p.runningVersion,null);
  console.log('Status Docker smoke passed: running image identity and stopped plugin versions.');
} finally {
  try {await docker(['down']);}finally{await fs.rm(root,{recursive:true,force:true});}
}
