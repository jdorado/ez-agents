import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('owner help succeeds without loading control configuration or credentials',()=>{
  const output=execFileSync(process.execPath,['bin/ezenciel-agents-owner.mjs','--help'],{
    encoding:'utf8',env:{PATH:process.env.PATH,EZ_CONTROL_DIR:'/dev/null/not-a-directory'}
  });
  assert.match(output,/Usage: ezenciel-agents-owner status/);
});
