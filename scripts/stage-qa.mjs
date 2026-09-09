#!/usr/bin/env node
// Developer packaging only. The existing agent-owned updater installs the result.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {digest, extract, version, newer} from '../src/updates/artifact.mjs';

const {values:v}=parseArgs({options:Object.fromEntries(['source','catalog','label','version','flow'].map(k=>[k,{type:'string'}]))});
if(!['source','catalog','label','version','flow'].every(k=>v[k]))throw Error('Required: --source CHECKOUT --catalog DIRECTORY --label beta-12 --version 0.1.0-beta.12.qa.1 --flow QA.md');
if(!/^beta-[1-9]\d*$/.test(v.label))throw Error('Label must be beta-N');
version(v.version);
if(!/^\d+\.\d+\.\d+-beta\.\d+\.qa\.[1-9]\d*$/.test(v.version))throw Error('Use a distinct private version: X.Y.Z-beta.N.qa.BUILD');
const source=await fs.realpath(v.source),catalog=path.resolve(v.catalog);
const run=(cmd,args,cwd=source)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(run('git',['status','--porcelain']))throw Error('Commit the reviewed source before staging QA');
const commit=run('git',['rev-parse','HEAD']),flow=await fs.readFile(v.flow,'utf8');
if(!flow.trim())throw Error('A feature QA flow is required');
await fs.mkdir(catalog,{recursive:true,mode:0o700});
const destination=path.join(catalog,v.label);
if(await fs.lstat(destination).then(()=>true,err=>{if(err.code==='ENOENT')return false;throw err;}))throw Error('QA label already exists; never replace a build. Choose the next beta label.');
const temp=await fs.mkdtemp(path.join(tmpdir(),'ez-stage-qa-'));
const staged=await fs.mkdtemp(path.join(catalog,'.staging-'));
try {
  const pack=(cwd,out)=>JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',out],cwd))[0];
  const original=pack(source,temp);
  await extract(await fs.readFile(path.join(temp,original.filename)),path.join(temp,'source'));
  const root=path.join(temp,'source'),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if(pkg.ezRelease?.kind!=='main')throw Error('This staging command accepts the main package only');
  if(!newer(v.version,pkg.version))throw Error('Private QA version must be newer than source package version');
  pkg.version=v.version;pkg.ezQa={label:v.label,commit,private:true};
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  const packed=pack(root,staged),artifact=await fs.readFile(path.join(staged,packed.filename));
  const receipt={label:v.label,version:v.version,package:pkg.name,commit,sha256:digest(artifact),file:packed.filename,private:true};
  await fs.writeFile(path.join(staged,'manifest.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  await fs.writeFile(path.join(staged,'QA.md'),flow,{mode:0o600});
  await fs.chmod(path.join(staged,packed.filename),0o600);
  // The published directory is nonempty, so competing staging cannot replace it.
  await fs.rename(staged,destination);
  console.log(JSON.stringify({...receipt,directory:destination},null,2));
} finally {await fs.rm(temp,{recursive:true,force:true});await fs.rm(staged,{recursive:true,force:true});}
