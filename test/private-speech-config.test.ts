import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,openSync,closeSync,rmSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {loadConfig} from '../src/config.js'

test('installed private descriptor admits speech selectors and keeps speech keys out of the executor', () => {
  const dir=mkdtempSync('/tmp/ez-speech-env-'),file=join(dir,'relay.env'),key='synthetic-private-speech-marker'
  try {
    writeFileSync(file,`OPENROUTER_API_KEY=${key}\nEZ_SPEECH_PROVIDER=invalid-private-selector\nEZ_SPEECH_MODEL=fish-audio/s2.1-pro-free:free\n`,{mode:0o600})
    let fd=openSync(file,'r')
    const invalid=spawnSync(process.execPath,['--import','tsx','docker/run.ts','start'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,EZ_APPLICATION_PORT:'8787'},stdio:['ignore','pipe','pipe',fd]});closeSync(fd)
    assert.equal(invalid.status,1);assert.match(invalid.stderr,/Invalid EZ_SPEECH_PROVIDER/);assert.ok(!invalid.stderr.includes(key))
    writeFileSync(file,`OPENROUTER_API_KEY=${key}\nEZ_SPEECH_PROVIDER=openrouter\nEZ_SPEECH_MODEL=fish-audio/s2.1-pro-free:free\n`,{mode:0o600})
    fd=openSync(file,'r')
    const child=spawnSync(process.execPath,['--import','tsx','docker/run.ts','exec',process.execPath,'-e',"if(process.env.OPENROUTER_API_KEY||process.env.EZ_SPEECH_PROVIDER)process.exit(91);console.log('isolated')"],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe',fd]});closeSync(fd)
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'isolated')
    const config=loadConfig({EZ_APPLICATION_PORT:'8787',OPENROUTER_API_KEY:key,EZ_SPEECH_PROVIDER:'openrouter',EZ_SPEECH_MODEL:'fish-audio/s2.1-pro-free:free'})
    assert.equal(config.openrouterApiKey,key);assert.equal(config.speechProvider,'openrouter');assert.equal(config.speechModel,'fish-audio/s2.1-pro-free:free')
  } finally {rmSync(dir,{recursive:true,force:true})}
})
