import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {runTaskCapability} from '../src/task-capability.js'
import {readTaskAttachment} from '../src/task-attachments.js'
import {randomUUID} from 'node:crypto'

test('channel capability invokes only the approved command vector with one literal untrusted input',async t=>{
  const root=await mkdtemp('/tmp/ez-capability-'),bin=join(root,'bin')
  await mkdir(bin)
  await writeFile(join(root,'registry.json'),JSON.stringify({commands:{'library-query':'library'},plugins:{library:{manifest:{commands:{'library-query':{channelQuery:true,exposure:{receivesExternalContent:true,sendsExternally:false,changesRecords:false,requiresReview:false}}}}}}}))
  await writeFile(join(bin,'ez'),`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),token:process.env.TELEGRAM_BOT_TOKEN}))\n`,{mode:0o700})
  t.after(()=>rm(root,{recursive:true,force:true}))
  const capability={id:'knowledge',description:'Search knowledge',command:'library-query',args:['--library','default','--','{input}']}
  const input='--remove everything; $(echo nope)'
  const result=await runTaskCapability(root,capability,input)
  assert.ok(result.output)
  assert.deepEqual(JSON.parse(result.output),{args:['library-query','--library','default','--',input]})
})

test('channel capability rejects installed aliases that can write, send, or require review',async t=>{
  const root=await mkdtemp('/tmp/ez-capability-'),bin=join(root,'bin');await mkdir(bin)
  await writeFile(join(bin,'ez'),'not reached',{mode:0o700})
  t.after(()=>rm(root,{recursive:true,force:true}))
  const capability={id:'unsafe',description:'Unsafe operation',command:'admin',args:['get','--','{input}']}
  for(const command of [
    {exposure:{receivesExternalContent:true,sendsExternally:false,changesRecords:false,requiresReview:false}},
    {channelQuery:true,exposure:{receivesExternalContent:true,sendsExternally:false,changesRecords:true,requiresReview:false}},
  ]) {
    await writeFile(join(root,'registry.json'),JSON.stringify({commands:{admin:'plugin'},plugins:{plugin:{manifest:{commands:{admin:command}}}}}))
    await assert.rejects(runTaskCapability(root,capability,'input'),/not an installed read-only channel query/)
  }
})

test('file capability stages original bytes only for a declared read-only file command',async t=>{
 const root=await mkdtemp('/tmp/ez-file-capability-');await mkdir(join(root,'bin'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const bytes=Buffer.from('%PDF\n\x00\xff','latin1')
 await writeFile(join(root,'bin','ez'),`#!${process.execPath}\nprocess.stdout.write(Buffer.from('${bytes.toString('base64')}','base64'))`,{mode:0o700})
 const command={channelFile:true,exposure:{receivesExternalContent:true,sendsExternally:false,changesRecords:false,requiresReview:false}}
 await writeFile(join(root,'registry.json'),JSON.stringify({commands:{file:'plugin'},plugins:{plugin:{manifest:{commands:{file:command}}}}}))
 const capability={id:'file',description:'Read file',command:'file',args:['--','{input}'],output:'file' as const}
 const result=await runTaskCapability(root,capability,'manual.pdf',{controlDir:root,runId:'run',lease:randomUUID()})
 assert.ok(result.attachment);assert.deepEqual(await readTaskAttachment(root,result.attachment),bytes)
 await assert.rejects(runTaskCapability(root,{...capability,output:undefined},'manual.pdf'),/not an installed read-only/)
 await assert.rejects(runTaskCapability(root,capability,'manual.pdf'),/requires task staging/)
})
