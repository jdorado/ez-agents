import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const image = process.env.EZ_RELAY_IMAGE || 'ezenciel-agents:local';
const dir = mkdtempSync(join(tmpdir(), 'ez-docker-qa-'));
const holder = `ez-main-lock-qa-${process.pid}`;
const volume = `${holder}-control`;
const marker = 'qa-private-secret-never-in-executor';
writeFileSync(join(dir, 'relay.env'), `TELEGRAM_BOT_TOKEN=${marker}\n`, { mode: 0o600 });
const run = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
try {
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
  console.log('Docker smoke passed: non-root executor, private secret mount/environment, literal argv, exit code, no Docker socket, duplicate writer rejection and crash lock release.');
} finally { run(['rm','-f',holder]); run(['volume','rm',volume]); rmSync(dir, {recursive:true, force:true}); }
