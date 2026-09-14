import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { nativeTaskBinding,nativeTasks } from '../src/plugins/native-tasks.mjs'
import { ControlStore } from '../src/control-state.js'

test('native tasks use verified control binding, sanitized environment and unchanged scheduler',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ez-native-tasks-'))),home=path.join(root,'tools'),workspace=path.join(root,'mind'),controlDir=path.join(root,'control'),hostConfig=path.join(root,'host-executor.json')
  try {
    for(const dir of [home,workspace,controlDir])await fs.mkdir(dir)
    await fs.writeFile(path.join(home,'config.json'),JSON.stringify({schemaVersion:1,workspace,hostConfig}))
    const host={cli:'grok',agents:[{toolsHome:home,workspace,controlDir}]}
    await fs.writeFile(hostConfig,JSON.stringify(host))
    const binding=await nativeTaskBinding(home,{HOME:root,PATH:process.env.PATH,TELEGRAM_BOT_TOKEN:'secret',EZ_RUN_ID:'forged',NODE_OPTIONS:'injection',EZ_CONTROL_DIR:'/wrong'})
    assert.equal(binding.cwd,workspace);assert.equal(binding.env.EZ_CONTROL_DIR,controlDir);assert.equal(binding.env.EZ_EXECUTOR_CLI,'grok')
    for(const key of ['TELEGRAM_BOT_TOKEN','EZ_RUN_ID','NODE_OPTIONS'])assert.equal(binding.env[key],undefined)
    assert.match((await nativeTasks(home,['--help'])).stdout,/durable, asynchronous CLI task/)
    const denied=await nativeTasks(home,['list']);assert.notEqual(denied.code,0);assert.match(denied.stderr,/Pair an owner/)
    const control=new ControlStore(controlDir,1000);await control.requestPairing(101,101);await control.approveOwner(101)
    const text='Read scan; $(must-not-run) /goal literal'
    const saved=await nativeTasks(home,['create','native-fixture','--now','--text',text]);assert.equal(saved.code,0,saved.stderr)
    const value=JSON.parse(saved.stdout);assert.equal(value.text,text);assert.equal(value.execution.preset.cli,'grok')
    assert.equal(JSON.parse((await nativeTasks(home,['show','native-fixture'])).stdout).text,text)
    assert.equal((await nativeTasks(home,['remove','native-fixture'])).code,0)
    await assert.rejects(nativeTasks(home,['--help'],{signal:AbortSignal.abort()}),/cancelled/)
    await assert.rejects(nativeTasks(home,['bad\0argument']),/literal/)
    for(const input of [['--text-file','/private/secret'],['--text-file=/private/secret']])
      await assert.rejects(nativeTasks(home,['create','--now',...input]),/inline --text/)
    await fs.writeFile(hostConfig,JSON.stringify({...host,agents:[{...host.agents[0],workspace:root}]}))
    await assert.rejects(nativeTaskBinding(home),/does not match/)
    await fs.writeFile(path.join(home,'config.json'),JSON.stringify({schemaVersion:1,workspace}))
    await assert.rejects(nativeTasks(home,['--help']),/standalone/)
  }finally{await fs.rm(root,{recursive:true,force:true})}
})
