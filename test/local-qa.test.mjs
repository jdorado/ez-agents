import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,extract} from '../src/updates/artifact.mjs';

test('local QA staging preserves source and rejects label replacement and dirty source',async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'ez-qa-test-'));
  const source=path.join(root,'repo'),catalog=path.join(root,'catalog'),flow=path.join(root,'QA.md');
  await fs.mkdir(source);
  const pkg={name:'@fixture/main',version:'0.1.0-beta.12',files:['feature.txt'],ezRelease:{kind:'main',protocol:1,stateSchema:1,mainProtocol:1}};
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify(pkg));
  await fs.writeFile(path.join(source,'feature.txt'),'feature source');
  await fs.writeFile(flow,'Ask for the feature. Verify its result.');
  const git=args=>execFileSync('git',args,{cwd:source,stdio:'pipe'}).toString().trim();
  git(['init']);git(['add','package.json','feature.txt']);
  git(['-c','user.name=QA','-c','user.email=qa@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m','fixture']);
  const script=fileURLToPath(new URL('../scripts/stage-qa.mjs',import.meta.url));
  const args=[script,'--source',source,'--catalog',catalog,'--label','beta-12','--version','0.1.0-beta.12.qa.1','--flow',flow];
  const stage=()=>execFileSync(process.execPath,args,{stdio:'pipe'}).toString();
  try {
    const result=JSON.parse(stage()),data=await fs.readFile(path.join(result.directory,result.file));
    assert.equal(result.sha256,digest(data));assert.equal(result.commit,git(['rev-parse','HEAD']));
    assert.equal(git(['status','--porcelain']),'');
    await extract(data,path.join(root,'unpacked'));
    const built=JSON.parse(await fs.readFile(path.join(root,'unpacked/package.json'),'utf8'));
    assert.equal(built.version,'0.1.0-beta.12.qa.1');assert.equal(built.ezQa.commit,result.commit);
    assert.equal(await fs.readFile(path.join(root,'unpacked/feature.txt'),'utf8'),'feature source');
    assert.throws(stage,error=>/QA label already exists/.test(error.stderr.toString()));
    assert.equal(digest(await fs.readFile(path.join(result.directory,result.file))),result.sha256);
    await fs.writeFile(path.join(source,'feature.txt'),'unreviewed edit');
    assert.throws(stage,error=>/Commit the reviewed source/.test(error.stderr.toString()));
    assert.deepEqual(await fs.readdir(catalog),['beta-12']);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
