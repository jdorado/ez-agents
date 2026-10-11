// Synthetic private binding and existing-volume acceptance; no provider access.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execute} from '../src/updates/runtime.mjs';
import {executorBindingArchive,executorVolumes} from '../src/updates/supervisor.mjs';
const root=await fs.mkdtemp(path.join(tmpdir(),'ez-executor-smoke-'));
const project='ez-executor-smoke-'+randomUUID().slice(0,8),volume=project+'-existing';
const file=path.join(root,'compose.json'),image=process.env.EZ_RELAY_IMAGE||'ezenciel-agents:local';
const binding={agents:[{workspace:'/synthetic',binDir:'/app/bin'}]};
const code=`const fs=require('fs'),assert=require('assert/strict');const p='/run/executor.json',s=fs.statSync(p),d=fs.statSync('/run');assert.equal(process.getuid(),1001);assert.equal(s.uid,0);assert.equal(s.gid,1000);assert.equal(s.mode&511,288);assert.equal(d.uid,0);assert.equal(d.mode&18,0);assert.deepEqual(JSON.parse(fs.readFileSync(p)),${JSON.stringify(binding)});for(const fn of [()=>fs.writeFileSync(p,'changed'),()=>fs.chmodSync(p,384),()=>fs.unlinkSync(p)])assert.throws(fn,e=>['EACCES','EPERM','EROFS'].includes(e.code));assert.equal(fs.readFileSync('/ipc/marker','utf8'),'retained');console.log('Private readonly binding and retained volume passed');`;
const worker={image,user:'1001:1000',network_mode:'none',cap_drop:['ALL'],security_opt:['no-new-privileges:true'],entrypoint:['node','-e',code],volumes:[{type:'volume',source:'ipc',target:'/ipc'}]};
const args=['compose','--project-name',project,'--file',file];
try {
 await execute('docker',['volume','create',volume]);
 await execute('docker',['run','--rm','--network','none','--user','0:0','--mount',`type=volume,source=${volume},target=/ipc`,'--entrypoint','node',image,'-e',"require('fs').writeFileSync('/ipc/marker','retained')"]);
 await fs.writeFile(file,JSON.stringify({services:{executor:worker},volumes:executorVolumes({volumes:{ipc:{name:volume}}},worker)}),{mode:0o600});
 await execute('docker',[...args,'create','--no-build','executor']);
 const cid=(await execute('docker',[...args,'ps','-aq','executor'],{stdoutOnly:true})).trim();
 await execute('docker',['cp','-',`${cid}:/run`],{input:executorBindingArchive(binding,1000)});
 console.log(await execute('docker',['start','-a',cid]));
 const exit=(await execute('docker',['inspect','--format','{{.State.ExitCode}}',cid],{stdoutOnly:true})).trim();
 if(exit!=='0')throw Error('Executor binding acceptance failed');
 await execute('docker',[...args,'down']);
 const retained=(await execute('docker',['volume','inspect','--format','{{.Name}}',volume],{stdoutOnly:true})).trim();
 if(retained!==volume)throw Error('External volume identity changed');
 // Rejected archive input must fail cleanly, with no uncaught stdin EPIPE.
 await execute('docker',['cp','-',`${project}-missing:/run`],{input:Buffer.alloc(1024*1024)}).then(()=>{throw Error('Missing container copy succeeded');},()=>{});
 console.log('PASS: unprivileged executor reads only its private binding; writes, chmod and unlink fail; external volume preserved.');
} finally {
 await execute('docker',[...args,'down']).catch(()=>{});
 await execute('docker',['volume','rm',volume]).catch(()=>{});
 await fs.rm(root,{recursive:true,force:true});
}
