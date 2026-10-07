import test from 'node:test';
import assert from 'node:assert/strict';
import { run, latestCodexVersion } from '../src/install-tools.mjs';

test('Codex discovery parses stdout and retains failure diagnostics',async()=>{
  const script=`process.stdout.write('"0.160.1"\\n');process.stderr.write('package manager notice\\n');`;
  const invoke=(command,args,options)=>{
    assert.equal(command,'pnpm');
    assert.deepEqual(args,['view','@openai/codex@latest','version','--json','--registry','https://registry.npmjs.org/']);
    assert.equal(options.stdoutOnly,true);
    return run(process.execPath,['-e',script],options);
  };
  assert.equal(await latestCodexVersion(invoke,{command:'pnpm',args:[]}),'0.160.1');
  await assert.rejects(run(process.execPath,['-e',script+'process.exitCode=1'],{stdoutOnly:true}),/package manager notice/);
});

test('Codex discovery rejects contaminated stdout without leaking it',async()=>{
  await assert.rejects(latestCodexVersion(async()=> '"0.160.1"\nprivate-output'),{message:'Codex version discovery returned invalid JSON on stdout'});
  for(const value of ['null','{}','["0.160.1"]','"latest"'])
    await assert.rejects(latestCodexVersion(async()=>value),/Invalid latest Codex version/);
});
