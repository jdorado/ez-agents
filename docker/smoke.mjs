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
    '-e','EZ_TELEGRAM_ENABLED=false','-e','EZ_APPLICATION_PORT=8110','-e','EZ_ISOLATION=isolated','-e','EZ_EXECUTOR_TRANSPORT=local','-e','EZ_EXECUTOR_CLI=codex'];
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
  const failed = run(['run','--rm',image,'exec','node','-e','process.exit(23)']);
  assert.equal(failed.status, 23, failed.stderr);
  const held = run(['run','-d','--name',holder,'-v',`${volume}:/state/control`,image,'exec','node','-e',"require('fs').writeFileSync('/state/control/ready','yes');setInterval(()=>{},1000)"]);
  assert.equal(held.status,0,held.stderr);
  for (let n=0;n<30;n++) {
    const probe=run(['exec',holder,'test','-f','/state/control/ready']);
    if(probe.status===0)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(run(['exec',holder,'test','-f','/state/control/ready']).status,0);
  const duplicate=run(['run','--rm','-v',`${volume}:/state/control`,image,'exec','node','-e','process.exit(0)']);
  assert.equal(duplicate.status,73,duplicate.stderr);
  assert.equal(run(['kill',holder]).status,0);
  const recovered=run(['run','--rm','-v',`${volume}:/state/control`,image,'exec','node','-e','process.exit(0)']);
  assert.equal(recovered.status,0,recovered.stderr);
  console.log('Docker smoke passed: direct non-root application help/start/health/stop, inherited private descriptor, non-root executor, isolated Codex on PATH, private secret isolation, literal argv, exit code, no Docker socket, duplicate writer rejection and crash lock release.');
} finally { run(['rm','-f',holder,application]); run(['volume','rm',volume]); rmSync(dir, {recursive:true, force:true}); }
