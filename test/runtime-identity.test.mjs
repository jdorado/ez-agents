import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('container identity rejects root, malformed IDs and shared relay/executor UID before startup', () => {
  for (const overrides of [
    {EZ_RUNTIME_UID:'0'}, {EZ_RUNTIME_GID:'0'}, {EZ_RELAY_UID:'0'},
    {EZ_RUNTIME_UID:'-1'}, {EZ_RUNTIME_UID:'20001;id'},
    {EZ_RUNTIME_UID:'020001'}, {EZ_RUNTIME_UID:'2147483648'},
    {EZ_RUNTIME_UID:'99999999999999999999999999999'},
    {EZ_RUNTIME_UID:'20001',EZ_RELAY_UID:'20001'},
  ]) {
    const result=spawnSync('sh',['docker/entrypoint.sh','exec','true'], {
      encoding:'utf8', env:{PATH:process.env.PATH,EZ_RUNTIME_UID:'1000',EZ_RUNTIME_GID:'1000',EZ_RELAY_UID:'1001',...overrides},
    });
    assert.equal(result.status,64,JSON.stringify(overrides)+': '+result.stderr);
  }
});
