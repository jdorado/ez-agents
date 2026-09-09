import { ownerRun } from './helpers/owner-run.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readlink,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {startExecutorJob} from '../src/executor.js'

test('Codex shares only auth through a link and keeps each agent runtime state separate',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ez-codex-context-'))
 const priorHome=process.env.HOME,priorPath=process.env.PATH
 try{
  await mkdir(path.join(root,'.codex'));await mkdir(path.join(root,'bin'))
  await writeFile(path.join(root,'.codex/auth.json'),'{}')
  await writeFile(path.join(root,'.codex/config.toml'),'# unrelated personal config')
  await writeFile(path.join(root,'bin/codex'),`#!${process.execPath}\nconsole.log(process.env.CODEX_HOME)`,{mode:0o700})
  process.env.HOME=root;process.env.PATH=path.join(root,'bin')+path.delimiter+priorPath
  for(const agent of ['one','two']){
   const controlDir=path.join(root,agent)
   await ownerRun(controlDir, 'r_test')
   const job=await startExecutorJob(['hello'],{workspace:root,controlDir,binDir:path.join(root,'bin'),cli:'codex',runId:'r_test',timeoutMs:5000})
   let output='';job.child.stdout?.on('data',chunk=>output+=chunk)
   assert.equal(await new Promise(resolve=>job.child.once('close',resolve)),0)
   await job.cleanup()
   const home=path.join(controlDir,'cli/codex')
   assert.equal(output.trim(),home)
   assert.deepEqual(await readdir(home),['auth.json'])
   assert.equal(await readlink(path.join(home,'auth.json')),path.join(root,'.codex/auth.json'))
  }
 }finally{
  if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome
  if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath
  await rm(root,{recursive:true,force:true})
 }
})
