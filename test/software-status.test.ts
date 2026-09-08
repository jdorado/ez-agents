import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installedPluginVersions, softwareStatus } from '../src/software-status.js'
import { packageVersion } from '../src/version.js'

test('Telegram software status uses loaded version and only fresh host plugin metadata', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-software-status-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(path.join(root,'host-executor'))
  await writeFile(path.join(root,'registry.json'),JSON.stringify({plugins:{whatsapp:{manifest:{id:'whatsapp',version:'0.1.0-beta.3'},secrets:'never share',source:'/private/source'}}}))
  const plugins=await installedPluginVersions(root)
  assert.deepEqual(plugins,[{id:'whatsapp',version:'0.1.0-beta.3'}])
  const heartbeat=path.join(root,'host-executor/heartbeat.json')
  await writeFile(heartbeat,JSON.stringify({at:Date.now(),version:'0.1.0-beta.4',plugins}))
  const lines=await softwareStatus(root)
  assert.equal(lines[0],`Ez relay: ${packageVersion} (running)`)
  assert(lines.includes('Host transport: 0.1.0-beta.4 (running)'))
  assert(lines.includes('Plugins (installed): whatsapp 0.1.0-beta.3'))
  assert(!JSON.stringify(lines).includes('/private'))
  for(const h of [{at:Date.now()-60000,plugins},{at:Date.now()+60000,plugins},{}]) {
    await writeFile(heartbeat,JSON.stringify(h))
    assert((await softwareStatus(root)).includes('Plugins (installed): unknown'))
  }
  await writeFile(heartbeat,JSON.stringify({at:Date.now()}))
  assert((await softwareStatus(root)).includes('Host transport: version unknown (running)'))
  await writeFile(path.join(root,'registry.json'),'broken')
  assert.equal(await installedPluginVersions(root),null)
})
