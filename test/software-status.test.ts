import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installedPluginVersions, softwareStatus } from '../src/software-status.js'
import { formatRelayLabel, packageVersion } from '../src/version.js'

test('relay label shows the running RC tag first', () => {
  assert.equal(formatRelayLabel('0.1.0-beta.35', 'rc2', 'abc123def4567890'), 'rc2 (v0.1.0-beta.35 · abc123def456)')
  assert.equal(formatRelayLabel('0.1.0-beta.35', 'rc2'), 'rc2 (v0.1.0-beta.35)')
  assert.equal(formatRelayLabel('1.0.0'), 'v1.0.0')
})

test('Telegram software status uses loaded version and only fresh host plugin metadata', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-software-status-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(path.join(root,'host-executor'))
  await writeFile(path.join(root,'registry.json'),JSON.stringify({plugins:{whatsapp:{manifest:{id:'whatsapp',version:'0.1.0-beta.3'},secrets:'never share',source:'/private/source'}}}))
  const plugins=await installedPluginVersions(root)
  assert.deepEqual(plugins,[{id:'whatsapp',version:'0.1.0-beta.3'}])
  const heartbeat=path.join(root,'host-executor/heartbeat.json')
  await writeFile(heartbeat,JSON.stringify({at:Date.now(),version:'0.1.0-beta.4',platform:'darwin',arch:'arm64',plugins}))
  const lines=await softwareStatus(root,'host-capable')
  assert.equal(lines[0],`Relay: running · v${packageVersion}`)
  assert(lines.includes('Env: mac (darwin/arm64) · host-capable · host'))
  assert(lines.includes('Host transport: running · v0.1.0-beta.4'))
  assert(lines.includes('Plugins: whatsapp 0.1.0-beta.3'))
  assert(!JSON.stringify(lines).includes('/private'))
  for(const h of [{at:Date.now()-60000,plugins},{at:Date.now()+60000,plugins},{}]) {
    await writeFile(heartbeat,JSON.stringify(h))
    assert((await softwareStatus(root)).includes('Plugins: unknown'))
  }
  await writeFile(heartbeat,JSON.stringify({at:Date.now()}))
  assert((await softwareStatus(root)).includes('Host transport: running · version unknown'))
  await writeFile(path.join(root,'registry.json'),'broken')
  assert.equal(await installedPluginVersions(root),null)
  await rm(heartbeat)
  assert((await softwareStatus(root)).includes('Host transport: unavailable'))
  assert((await softwareStatus(root)).includes('Plugins: unknown'))
  assert((await softwareStatus(root)).some(l => l.startsWith('Env:') && l.includes('unknown · unknown')))
  assert((await softwareStatus(root,'isolated')).includes('Host transport: n/a · isolated execution'))
  assert((await softwareStatus(root,'isolated')).some(l => l.startsWith('Env:') && l.includes('isolated · local')))
  assert((await softwareStatus(root,'isolated')).includes('Plugins: isolated broker · versions via `ez tools list`'))
  await writeFile(path.join(root,'plugin-broker-plugins.json'),JSON.stringify({version:1,at:new Date().toISOString(),plugins:[{id:'voice',version:'0.2.0'}]}))
  assert((await softwareStatus(root,'isolated')).includes('Plugins: voice 0.2.0'))
  await writeFile(path.join(root,'plugin-broker-plugins.json'),'broken')
  assert((await softwareStatus(root,'isolated')).includes('Plugins: isolated broker · versions via `ez tools list`'))
})

test('isolated software status uses broker inventory with a fresh executor heartbeat', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'ez-isolated-status-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(path.join(root,'host-executor'))
  const heartbeat=path.join(root,'host-executor/heartbeat.json')
  const inventory=path.join(root,'plugin-broker-plugins.json')
  await writeFile(inventory,JSON.stringify({version:1,plugins:[{id:'example',version:'1.2.3',source:'/private/source'}]}))
  for (const plugins of [null,[],[{id:'outdated',version:'0.0.1'}]]) {
    await writeFile(heartbeat,JSON.stringify({at:Date.now(),version:'1.0.0',containerExecutor:true,plugins}))
    const lines=await softwareStatus(root,'isolated')
    assert(lines.includes('Host transport: running · v1.0.0'))
    assert(lines.includes('Plugins: example 1.2.3'))
    assert(!lines.includes('Plugins: unknown'))
    assert(!JSON.stringify(lines).includes('/private'))
  }
  await rm(inventory)
  assert((await softwareStatus(root,'isolated')).includes('Plugins: isolated broker · versions via `ez tools list`'))
  assert((await softwareStatus(root,'host-capable')).includes('Plugins: outdated 0.0.1'))
})
