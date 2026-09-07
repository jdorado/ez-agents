import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
test('public launchers resolve package root through npm-style symlinks',async t=>{
 const temp=await mkdtemp(path.join(tmpdir(),'ez-public-bin-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const bin=path.join(temp,'bin'),deployment=path.join(temp,'deployment');await mkdir(bin);await mkdir(deployment);
 await writeFile(path.join(bin,'docker'),`#!/bin/sh\nexec '${process.execPath}' -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,{mode:0o700});
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,EZ_DEPLOYMENT_DIR:deployment,EZ_AGENTS_HOME:path.join(temp,'agents')};
 for(const name of ['docker','create','host'])await symlink(path.join(root,'bin','ezenciel-agents-'+name),path.join(bin,'ezenciel-agents-'+name));
 const docker=JSON.parse((await exec(path.join(bin,'ezenciel-agents-docker'),['config'],{env})).stdout);
 assert.equal(docker[docker.indexOf('--project-directory')+1],await realpath(root));
 const create=JSON.parse((await exec(path.join(bin,'ezenciel-agents-create'),['--list'],{env})).stdout);
 assert.equal(create[create.indexOf('--compose-file')+1],path.join(await realpath(root),'compose.yaml'));
 await writeFile(path.join(deployment,'host-executor.json'),'{');
 await assert.rejects(exec(path.join(bin,'ezenciel-agents-host'),[],{env}),e=>/JSON/.test(e.stderr)&&!e.stderr.includes('ERR_MODULE_NOT_FOUND'));
});
test('main version reports package metadata without starting a relay',async()=>{
 const p=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
 assert.equal((await exec(process.execPath,[path.join(root,'bin/ezenciel-agents.mjs'),'--version'])).stdout.trim(),p.version);
});
