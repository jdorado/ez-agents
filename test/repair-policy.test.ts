import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'
import { executorJobEnv } from '../src/executor.js'
import { agentGuidance } from '../src/agent-guidance.js'

test('repair preference is bound in the environment, never rewritten into the request', () => {
 const config = (value?:string) => loadConfig({TELEGRAM_BOT_TOKEN:'fixture', ...(value===undefined ? {} : {EZ_REPAIR_ENABLED:value})})
 assert.equal(config().repairEnabled,true)
 assert.equal(config('false').repairEnabled,false)
 assert.throws(()=>config('disabled'),/EZ_REPAIR_ENABLED/)
 for(const enabled of [true,false]) {
  const env=executorJobEnv({runId:'r_test',controlDir:'/control',binDir:'/bin',repairEnabled:enabled},{EZ_REPAIR_ENABLED:'injected',TELEGRAM_BOT_TOKEN:'secret'})
  assert.equal(env.EZ_REPAIR_ENABLED,String(enabled))
  assert.equal(env.TELEGRAM_BOT_TOKEN,undefined)
 }
 assert.match(agentGuidance(),/EZ_REPAIR_ENABLED/)
 assert.match(agentGuidance(),/explicit owner request or saved maintenance mandate/)
})
