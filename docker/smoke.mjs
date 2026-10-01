import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const image = process.env.EZ_RELAY_IMAGE || 'ezenciel-agents:local';
const dir = mkdtempSync(join(tmpdir(), 'ez-docker-qa-'));
const holder = `ez-main-lock-qa-${process.pid}`;
const volume = `${holder}-control`;
const application = `${holder}-application`;
const privateVolume = `${holder}-private`;
const boundProject = `${holder}-bound`;
const boundVolume = `${boundProject}_data`;
const broker = `${holder}-broker`;
const marker = 'qa-private-secret-never-in-executor';
writeFileSync(join(dir, 'relay.env'), `TELEGRAM_BOT_TOKEN=${marker}\n`, { mode: 0o600 });
writeFileSync(join(dir, 'purpose.md'), 'Verify the packaged Ez runtime.\n', { mode: 0o644 });
writeFileSync(join(dir, 'node'), `#!/bin/sh\nIFS= read -r value <&3\n[ "$value" = "TELEGRAM_BOT_TOKEN=${marker}" ] || exit 91\nexec /usr/local/bin/node "$@"\n`, { mode: 0o555 });
const run = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
try {
  const inherited = run(['run','--rm','--mount',`type=bind,src=${join(dir,'relay.env')},dst=/run/secrets/relay_env,readonly`,
    '--mount',`type=bind,src=${join(dir,'node')},dst=/qa/node,readonly`,'-e','PATH=/qa:/usr/local/bin:/usr/bin:/bin',image,'application','--help']);
  assert.equal(inherited.status,0,inherited.stderr);
  const nonroot = ['--user','20000:20000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--mount',`type=bind,src=${join(dir,'purpose.md')},dst=/run/agent-purpose.md,readonly`,'-e','EZ_AGENT_PURPOSE_FILE=/run/agent-purpose.md',
    '--tmpfs','/tmp:mode=1777','--tmpfs','/state/control:uid=20000,gid=20000,mode=700',
    '--tmpfs','/state/home:uid=20000,gid=20000,mode=700','--tmpfs','/workspace:uid=20000,gid=20000,mode=700',
    '-e','EZ_APPLICATION_PORT=8110','-e','EZ_ISOLATION=isolated','-e','EZ_EXECUTOR_TRANSPORT=local','-e','EZ_EXECUTOR_CLI=codex'];
  const help = run(['run','--rm',...nonroot,image,'application','--help']);
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/ezenciel-agents-application/);
  const login = run(['run','--rm',...nonroot,'--entrypoint','/bin/bash',image,'-lc',
    'command -v ezenciel-agents-application && command -v ezenciel-agents-message && command -v codex && ezenciel-agents-message --help && codex --version']);
  assert.equal(login.status,0,login.stderr);
  assert.match(login.stdout,/\/usr\/local\/bin\/ezenciel-agents-application/);
  assert.match(login.stdout,/\/usr\/local\/bin\/ezenciel-agents-message/);
  assert.match(login.stdout,/codex-cli 0\.153\.4/);
  const started = run(['run','-d','--name',application,...nonroot,image,'start']);
  assert.equal(started.status,0,started.stderr);
  let ready = false;
  for (let n=0;n<60;n++) {
    if (run(['exec',application,'node','/app/docker/healthcheck.mjs']).status===0) { ready=true; break; }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,run(['logs',application]).stderr);
  assert.equal(run(['stop','--time','10',application]).status,0);
  assert.equal(run(['inspect','--format','{{.State.ExitCode}}',application]).stdout.trim(),'0');
  const probe = `
    const fs = require('fs'), assert = require('assert/strict');
    assert.equal(process.getuid(), 1000);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.throws(() => fs.openSync('/proc/'+process.ppid+'/mem', 'r'), {code:'EACCES'});
    assert.throws(() => fs.readFileSync('/run/secrets/relay_env'), {code:'EACCES'});
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.match(fs.readFileSync('/proc/self/status','utf8'), /^NoNewPrivs:\\s+1$/m);
    for (const pid of ['1', String(process.ppid)]) {
      try { assert.ok(!fs.readFileSync('/proc/'+pid+'/environ','utf8').includes('${marker}')); }
      catch (e) { if (e.code !== 'EACCES') throw e; }
    }
    console.log(JSON.stringify({uid:process.getuid(), argv:process.argv.slice(1), private:true}));
  `;
  const literal = 'space $(touch /tmp/ez-should-not-exist); `echo no`';
  const result = run(['run', '--rm', '--mount', `type=bind,src=${join(dir,'relay.env')},dst=/run/secrets/relay_env,readonly`, image, 'exec', 'node', '-e', probe, literal]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).argv, [literal]);
  const customProbe = probe.replace('process.getuid(), 1000', 'process.getuid(), 20001') + `
    assert.equal(process.geteuid(),20001);
    assert.equal(process.getgid(),20002);
    assert.equal(process.getegid(),20002);
    for (const directory of ['/state/control','/state/home','/workspace']) {
      const info=fs.statSync(directory); assert.equal(info.uid,20001); assert.equal(info.gid,20002);
    }
  `;
  const custom = run(['run','--rm','-e','EZ_RUNTIME_UID=20001','-e','EZ_RUNTIME_GID=20002','-e','EZ_RELAY_UID=20003',
    '--mount',`type=bind,src=${join(dir,'relay.env')},dst=/run/secrets/relay_env,readonly`,image,'exec','node','-e',customProbe]);
  assert.equal(custom.status,0,custom.stderr);
  assert.equal(JSON.parse(custom.stdout).uid,20001);
  // Real Linux ownership, including pre-existing mode-600 control/registry
  // files. Host bind mounts on desktop Docker can mask these failures.
  const seed = run(['run','--rm','-v',`${privateVolume}:/qa`,'--entrypoint','node',image,'-e',`
    const fs=require('fs');
    for(const name of ['home','control','mind']) {
      fs.mkdirSync('/qa/'+name,{recursive:true,mode:0o700});
      fs.chownSync('/qa/'+name,20001,20002);
    }
    const files={
      '/qa/control/control-state.json':{version:1,owner:null,pending:[]},
      '/qa/home/config.json':{schemaVersion:1,workspace:'/qa/mind',hostConfig:'/qa/host-executor.json'},
      '/qa/home/registry.json':{schemaVersion:1,owner:'/qa/home',plugins:{},commands:{}},
      '/qa/host-executor.json':{isolation:'isolated',agents:[{name:'qa',toolsHome:'/qa/home',workspace:'/qa/mind',controlDir:'/qa/control'}]},
    };
    for(const [file,value] of Object.entries(files)) {
      fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chownSync(file,20001,20002);
    }
  `]);
  assert.equal(seed.status,0,seed.stderr);
  // Compose must reuse an existing operator-owned bind volume without
  // recreating it or rejecting its driver options (legacy Compose v1 did).
  const mountpoint = run(['volume','inspect','--format','{{.Mountpoint}}',privateVolume]).stdout.trim();
  assert.ok(mountpoint.startsWith('/'));
  const bind = run(['volume','create','--driver','local','--opt','type=none','--opt','o=bind','--opt',`device=${mountpoint}`,boundVolume]);
  assert.equal(bind.status,0,bind.stderr);
  const boundConfig = {services:{probe:{image,network_mode:'none',entrypoint:['node','-e',
    `const fs=require('fs'),assert=require('assert/strict');assert.equal(JSON.parse(fs.readFileSync('/state/host-executor.json')).isolation,'isolated');console.log('bound-volume-preserved');`],
    volumes:['data:/state:ro']}},volumes:{data:{}}};
  const reused = spawnSync('docker',['run','--rm','-i','--network','none','-v','/var/run/docker.sock:/var/run/docker.sock',
    '--entrypoint','docker-compose',image,'--project-name',boundProject,'--file','-','run','--rm','--no-deps','probe'],
    {encoding:'utf8',timeout:60000,input:JSON.stringify(boundConfig)});
  assert.equal(reused.status,0,reused.stderr);
  assert.match(reused.stdout,/bound-volume-preserved/);
  assert.equal(run(['volume','inspect','--format','{{index .Options "device"}}',boundVolume]).stdout.trim(),mountpoint);
  const privateState = run(['run','--rm','-v',`${privateVolume}:/qa`,
    '-e','EZ_CONTROL_DIR=/qa/control','-e','EZ_RUNTIME_UID=20001','-e','EZ_RUNTIME_GID=20002','-e','EZ_RELAY_UID=20003',
    image,'owner','status']);
  assert.equal(privateState.status,0,privateState.stderr);
  assert.equal(JSON.parse(privateState.stdout).owner,null);
  const brokerStarted = run(['run','-d','--name',broker,'--user','0:0','--cap-drop','ALL',
    '--cap-add','DAC_OVERRIDE','--cap-add','CHOWN','--security-opt','no-new-privileges','--network','none',
    '-v',`${privateVolume}:/qa`,'--entrypoint','node',image,'--import','/app/node_modules/tsx/dist/loader.mjs',
    '/app/src/plugin-broker.mjs','--home','/qa/home','--workspace','/qa/mind','--control-dir','/qa/control',
    '--socket','/qa/control/plugin-broker.sock','--host-config','/qa/host-executor.json']);
  assert.equal(brokerStarted.status,0,brokerStarted.stderr);
  let brokerReady=false;
  for(let n=0;n<30;n++) {
    const check=run(['exec','--user','20001:20002',broker,'node','-e',`
      const fs=require('fs'),assert=require('assert/strict');
      assert.ok(fs.statSync('/qa/control/plugin-broker.sock').isSocket());
      const file='/qa/control/plugin-broker-plugins.json';
      assert.equal(fs.statSync(file).uid,20001);assert.deepEqual(JSON.parse(fs.readFileSync(file)).plugins,[]);
    `]);
    if(check.status===0){brokerReady=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(brokerReady,run(['logs',broker]).stderr);
  const prepare = run(['exec',broker,'node','--input-type=module','-e',`
    import fs from 'node:fs/promises';
    import {snapshot,install,prepareCommand} from '/app/src/plugins/manager.mjs';
    const home='/qa/home',source='/qa/source';
    await fs.mkdir(source);
    const manifest={schemaVersion:1,id:'sample',version:'0.1.0',description:'Synthetic',commands:{sample:{executable:'client.mjs',args:[]}},skills:['SKILL.md']};
    const deployment={schemaVersion:1,services:{sample:{buildTarget:'runtime',volumes:{},healthcheck:['node','--version']}},commands:{sample:{service:'sample',argv:['node','/app/client.mjs']}}};
    for(const [name,value] of Object.entries({'package.json':JSON.stringify({files:['client.mjs','SKILL.md']}),'ez-plugin.json':JSON.stringify(manifest),'ez-deployment.json':JSON.stringify(deployment),'Dockerfile':'FROM scratch AS runtime','.dockerignore':'','client.mjs':'','SKILL.md':'Synthetic'}))await fs.writeFile(source+'/'+name,value);
    // Only the Docker build effect is stubbed; real installation and private
    // filesystem operations execute with the production broker capabilities.
    await fs.writeFile('/qa/docker','#!/bin/sh\\nexit 0\\n',{mode:0o755});
    process.env.PATH='/qa:'+process.env.PATH;
    delete process.env.EZ_DOCKER_COMPOSE;
    const pkg=await snapshot(source),config=JSON.parse(await fs.readFile(home+'/config.json'));
    await install(home,config,'sample',source,pkg.revision);
    const command=await prepareCommand(home,'sample',[],{invocation:true,environment:{}});
    await command.release();
  `]);
  assert.equal(prepare.status,0,prepare.stderr);
  const steward = run(['exec','--user','20001:20002',broker,'node','-e',`
    const fs=require('fs'),assert=require('assert/strict');
    for(const dir of ['packages','packages/sample','command-invocations']) {
      const stat=fs.statSync('/qa/home/'+dir);
      assert.equal(stat.uid,20001);assert.equal(stat.gid,20002);assert.equal(stat.mode&511,448);
      fs.readdirSync('/qa/home/'+dir);
    }
    fs.readFileSync('/qa/home/packages/sample/compose.json');
  `]);
  assert.equal(steward.status,0,steward.stderr);
  const failed = run(['run','--rm',image,'exec','node','-e','process.exit(23)']);
  assert.equal(failed.status, 23, failed.stderr);
  // The live delivery socket is the single-relay guard (it replaced the kernel
  // flock). This mirrors the relay's own start check: an answering address
  // refuses the second owner; a stale file is removed before binding.
  const guardScript = `
    const net=require('net'),fs=require('fs'),stay=process.argv[1]==='hold',path='/state/control/delivery.sock';
    const probe=net.createConnection(path);
    const bind=()=>{
      fs.rmSync(path,{force:true});
      const s=net.createServer(()=>{});
      s.on('error',()=>process.exit(1));
      s.listen(path,()=>{if(stay){fs.writeFileSync('/state/control/ready','yes');setInterval(()=>{},1000)}else s.close(()=>process.exit(0))});
    };
    probe.on('connect',()=>{probe.destroy();process.exit(73)});
    probe.on('error',bind);
    probe.setTimeout(3000,()=>{probe.destroy();process.exit(1)});
  `;
  const held = run(['run','-d','--name',holder,'-v',`${volume}:/state/control`,image,'exec','node','-e',guardScript,'hold']);
  assert.equal(held.status,0,held.stderr);
  for (let n=0;n<30;n++) {
    const probe=run(['exec',holder,'test','-f','/state/control/ready']);
    if(probe.status===0)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(run(['exec',holder,'test','-f','/state/control/ready']).status,0);
  const duplicate=run(['run','--rm','-v',`${volume}:/state/control`,image,'exec','node','-e',guardScript]);
  assert.equal(duplicate.status,73,duplicate.stderr);
  assert.equal(run(['kill',holder]).status,0);
  let released=1;
  for (let n=0;n<50;n++) {
    const recovered=run(['run','--rm','-v',`${volume}:/state/control`,image,'exec','node','-e',guardScript]);
    released=recovered.status;
    if(released===0)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(released,0,'a dead relay must release the delivery socket');
  console.log('Docker smoke passed: direct non-root application help/start/health/stop, inherited private descriptor, non-root executor, isolated Codex on PATH, private secret isolation, literal argv, exit code, no Docker socket, live delivery-socket guard and crash release.');
} finally { run(['rm','-f',holder,application,broker]); run(['volume','rm',boundVolume,volume,privateVolume]); rmSync(dir, {recursive:true, force:true}); }
