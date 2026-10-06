// Explicit synthetic Linux mount regression. No credentials, native identities,
// provider calls or existing deployments. Run against the exact reviewed image:
// EZ_RELAY_IMAGE=<immutable image ID> node docker/broker-update-smoke.mjs
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomic, snapshot } from '../src/plugins/manager.mjs';
import { execute, refreshBroker } from '../src/updates/runtime.mjs';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000}).trim();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(process.argv[2]!=='--inside') {
 const image=process.env.EZ_RELAY_IMAGE;
 if(!/^sha256:[a-f0-9]{64}$/.test(image||''))throw Error('Supply the exact reviewed runtime image ID');
 const volume=`e245-${process.pid}`;
 try {
  docker('volume','create',volume);
  const root=JSON.parse(docker('volume','inspect',volume))[0].Mountpoint;
  const output=docker('run','--rm','--network','none','--mount',`type=volume,source=${volume},target=${root}`,
   '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
   '--env','EZ_DOCKER_COMPOSE=standalone','--entrypoint','node',image,'--import','/app/node_modules/tsx/dist/loader.mjs',
   '/app/docker/broker-update-smoke.mjs','--inside',root,image);
  console.log(output);
 }finally {docker('volume','rm',volume);}
} else {
 const root=process.argv[3],image=process.argv[4],home=path.join(root,'tools'),workspace=path.join(root,'mind'),controlDir=path.join(root,'control');
 const hostConfig=path.join(root,'host-executor.json'),socket=path.join(controlDir,'b.sock'),project=`e245-${hash(root).slice(0,12)}`;
 const config={schemaVersion:1,workspace,hostConfig,deploymentDir:root};
 const args=['compose','--env-file',path.join(root,'docker.env')];
 const call=(tail)=>execute('docker',[...args,...tail],{stdoutOnly:true,timeout:120000});
 const container=async name=>(await call(['ps','-q',name])).trim();
 const inside=async script=>call(['exec','-T','plugin-broker','node','--input-type=module','-e',script]);
 const prepare=()=>inside(`import {prepareCommand} from '/app/src/plugins/manager.mjs'; await prepareCommand(${JSON.stringify(home)},'sample',[]); console.log('prepared');`);
 const mounted=()=>inside(`import fs from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(fs.readFileSync(${JSON.stringify(hostConfig)})).digest('hex'));`);
 const fingerprints=async()=>Promise.all([hostConfig,path.join(home,'registry.json'),path.join(home,'config.json')].map(async f=>hash(await fs.readFile(f))));
 const probe=async()=>call(['exec','-T','plugin-broker','node','--import','/app/node_modules/tsx/dist/loader.mjs','/app/docker/broker-readiness.mjs',...await fingerprints()]);
 const agent={name:'synthetic',toolsHome:home,workspace,controlDir};
 const host=(revisions)=>({isolation:'isolated',agents:[{...agent,pluginNetworkBindings:{sample:{revisions,bindings:[{service:'sample',network:'synthetic-reviewed-network'}]}}}]});
 const records=[];
 for(const directory of [home,workspace,controlDir])await fs.mkdir(directory,{recursive:true});
 for(const version of ['1.0.0','1.0.1']) {
  const source=path.join(home,'packages','sample',version);
  await fs.mkdir(path.join(source,'bin'),{recursive:true});
  const manifest={schemaVersion:1,id:'sample',version,commands:{sample:{executable:'bin/example.mjs',args:[]}},skills:[]};
  const deployment={schemaVersion:1,services:{sample:{buildTarget:'runtime',volumes:{},healthcheck:['node','--version']}},commands:{sample:{service:'sample',argv:['node','/app/bin/example.mjs']}},exports:{}};
  for(const [name,body] of Object.entries({'package.json':JSON.stringify({name:'synthetic-plugin',version,files:['bin']}),'ez-plugin.json':JSON.stringify(manifest),'ez-deployment.json':JSON.stringify(deployment),'Dockerfile':'FROM scratch AS runtime','.dockerignore':'','bin/example.mjs':'console.log("synthetic")'}))await fs.writeFile(path.join(source,name),body);
  const s=await snapshot(source);
  records.push({source,revision:s.revision,manifest:s.manifest,deployment:s.deployment,sharedRevisions:s.sharedRevisions,project:`ezp-${hash(home).slice(0,16)}-sample`,compose:path.join(home,'packages','sample','compose.json')});
 }
 const [a,b]=records;
 const publish=record=>atomic(path.join(home,'registry.json'),{schemaVersion:1,owner:home,plugins:{sample:record},commands:{sample:'sample'}});
 await atomic(path.join(home,'config.json'),config);await atomic(hostConfig,host([a.revision]));await publish(a);
 const brokerEnv={EZ_PLUGIN_BROKER_HOME:home,EZ_PLUGIN_BROKER_WORKSPACE:workspace,EZ_PLUGIN_BROKER_CONTROL_DIR:controlDir,EZ_PLUGIN_BROKER_HOST_CONFIG:hostConfig,EZ_PLUGIN_BROKER_SOCKET:socket,EZ_DOCKER_COMPOSE:'standalone'};
 const sleep=['node','-e','setInterval(()=>{},1000)'];
 const compose={services:{relay:{image,network_mode:'none',entrypoint:sleep},'plugin-broker':{image,network_mode:'none',entrypoint:['node','--import','/app/node_modules/tsx/dist/loader.mjs','/app/src/plugin-broker.mjs'],environment:brokerEnv,volumes:[`${home}:${home}`,`${workspace}:${workspace}:ro`,`${controlDir}:${controlDir}`,`${hostConfig}:${hostConfig}:ro`,'/var/run/docker.sock:/var/run/docker.sock'],healthcheck:{test:['CMD','node','-e',`process.exit(require('fs').statSync(${JSON.stringify(socket)}).isSocket()?0:1)`],interval:'1s',timeout:'5s',retries:15}}}};
 await atomic(path.join(root,'compose.json'),compose);
 await fs.writeFile(path.join(root,'docker.env'),`COMPOSE_PROJECT_NAME=${project}\nCOMPOSE_FILE=${path.join(root,'compose.json')}\nEZ_EXECUTOR_TRANSPORT=local\n`);
 try {
  await call(['up','-d','--no-build','--pull','never','--wait','--wait-timeout','30']);
  const relay=await container('relay'),oldBroker=await container('plugin-broker'),oldHash=(await mounted()).trim();
  assert.equal(JSON.parse(await probe()).ready,true);assert.equal((await prepare()).trim(),'prepared');
  await atomic(hostConfig,host([a.revision,b.revision]));await publish(b);
  assert.equal((await mounted()).trim(),oldHash);assert.notEqual(oldHash,(await fingerprints())[0]);
  await assert.rejects(prepare(),/not pinned/);await assert.rejects(probe(),/STRUCTURAL_READINESS_FAILED/);
  console.log('PASS stale inode: live socket; mounted A; registry B rejected; structural probe rejected');
  const ready=await refreshBroker(config);
  const newBroker=await container('plugin-broker');assert.notEqual(newBroker,oldBroker);assert.equal(await container('relay'),relay);
  assert.equal((await mounted()).trim(),ready.hostSha256);assert.equal((await prepare()).trim(),'prepared');
  assert.equal(ready.plugins[0].revision,b.revision);
  console.log(JSON.stringify({stage:'activation',oldBroker,newBroker,relay,hostSha256:ready.hostSha256,registrySha256:ready.registrySha256,revision:b.revision}));
  await atomic(hostConfig,host([a.revision]));
  await assert.rejects(refreshBroker(config),/STRUCTURAL_READINESS_FAILED/);await assert.rejects(prepare(),/not pinned/);
  console.log('PASS unapproved B remains rejected after recreation');
  await publish(a);const rolledBack=await refreshBroker(config);
  assert.equal((await mounted()).trim(),rolledBack.hostSha256);assert.equal(rolledBack.plugins[0].revision,a.revision);assert.equal((await prepare()).trim(),'prepared');assert.equal(await container('relay'),relay);
  console.log(JSON.stringify({stage:'rollback',broker:await container('plugin-broker'),relay,hostSha256:rolledBack.hostSha256,registrySha256:rolledBack.registrySha256,revision:a.revision}));
  // Read-only probe must neither repair a tampered snapshot nor create leases.
  await fs.appendFile(path.join(a.source,'bin/example.mjs'),'\n// unreviewed');await assert.rejects(probe(),/STRUCTURAL_READINESS_FAILED/);
  await fs.writeFile(path.join(a.source,'bin/example.mjs'),'console.log("synthetic")');
  await assert.rejects(call(['exec','-T','--env',`EZ_PLUGIN_BROKER_HOST_CONFIG=${root}/missing.json`,'plugin-broker','node','--import','/app/node_modules/tsx/dist/loader.mjs','/app/docker/broker-readiness.mjs',...await fingerprints()]),/STRUCTURAL_READINESS_FAILED/);
  await fs.rm(hostConfig);await assert.rejects(probe(),{code:'ENOENT'});
  await atomic(hostConfig,host([a.revision]));await refreshBroker(config);
  console.log('PASS source tamper and missing host file fail; no provider command or native run identity used');
 }finally {await call(['down','--volumes','--remove-orphans']);}
}
