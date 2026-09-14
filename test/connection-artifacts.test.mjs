import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {commandArtifact} from '../src/plugins/connection-artifacts.mjs';

test('CLI attachment output preserves exact binary bytes and excludes them from model output',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'voice-artifact-'));
  try {
    const bytes=Buffer.from([0,255,128,10,13,42]);
    const result=await commandArtifact(root,'source.pdf',async({onStdout})=>{onStdout(bytes.subarray(0,3));onStdout(bytes.subarray(3));return {code:0,stdout:'',stderr:''};});
    assert.equal(result.stdout,'');assert.equal(result.artifact.bytes,bytes.length);
    assert.equal(result.artifact.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await fs.readFile(path.join(root,result.artifact.path)),bytes);
    assert.equal((await fs.stat(path.join(root,result.artifact.path))).mode&0o777,0o600);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('artifact output rejects escaping paths, symlinks, overflow and cancelled or failed writes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'voice-artifact-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'voice-outside-'));
  const ok=async()=>({code:0,stdout:'',stderr:''});
  try {
    for(const name of ['../secret','/secret','.env','x/y'])await assert.rejects(commandArtifact(root,name,ok),/filename/);
    await fs.symlink(outside,path.join(root,'artifacts'));await assert.rejects(commandArtifact(root,'x',ok),/symlink/);await fs.unlink(path.join(root,'artifacts'));
    await assert.rejects(commandArtifact(root,'x',async({onStdout})=>{onStdout(Buffer.alloc(20*1024*1024+1));return ok();}),/20 MiB/);
    const abort=new AbortController();abort.abort();await assert.rejects(commandArtifact(root,'x',ok,{signal:abort.signal}));
    assert.equal((await commandArtifact(root,'x',async()=>({code:1,stdout:'',stderr:'failed'}))).code,1);
    assert.deepEqual(await fs.readdir(path.join(root,'artifacts')),[]);
    assert.deepEqual(await fs.readdir(outside),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
