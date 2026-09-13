import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { loadControlConfig } from './config.js'
import { ControlStore } from './control-state.js'
import { ApplicationBindings, applicationScope } from './application-channel.js'
import { initialPreset } from './ai.js'
import { applicationId } from './application-origin.js'

async function main() {
  const { values } = parseArgs({ options: {
    id: {type:'string'}, 'token-file': {type:'string'}, revoke: {type:'boolean'}, list: {type:'boolean'}, help: {type:'boolean'},
    'import-scope': {type:'string'}, 'native-session': {type:'string'}, cli: {type:'string'}, 'share-telegram': {type:'boolean'},
  } })
  if (values.help) { console.log('ezenciel-agents-application --id NAME --token-file PRIVATE_FILE [--share-telegram] | --id NAME --revoke | --list | --id NAME --import-scope SCOPE --native-session ID --cli CLI'); return }
  if (process.env.EZ_RUN_ID) throw new Error('Application authority is configured by the installing administrator outside agent turns')
  const config = loadControlConfig(), control = new ControlStore(config.controlDir, config.pairingTtlMs)
  const owner = (await control.status()).owner
  if (!owner) throw new Error('Pair an owner before granting application access')
  const bindings = new ApplicationBindings(config.controlDir)
  if (values.list) { console.log(JSON.stringify((await bindings.list()).map(({id,bindingId}) => ({id,bindingId})))); return }
  if (!values.id || !applicationId(values.id)) throw new Error('Application ID required')
  if (values['import-scope']) {
    const binding = (await bindings.list()).find(item => item.id === values.id)
    if (!binding || binding.owner.pairedAt !== owner.pairedAt || binding.owner.telegramUserId !== owner.telegramUserId || binding.owner.telegramChatId !== owner.telegramChatId || !applicationId(values['import-scope']) || !values['native-session'] || !/^[a-zA-Z0-9_-]{1,160}$/.test(values['native-session']) || !values.cli) throw new Error('Current application binding, scope, native session and CLI required')
    const choice = await control.captureApplicationChoice(initialPreset(values.cli), applicationScope(binding.bindingId, values['import-scope']))
    if (choice.preset.cli !== values.cli) throw new Error('Application scope already uses a different engine')
    await control.saveNativeSession(choice.sessionId, values['native-session'])
    console.log(JSON.stringify({ok:true,scope:values['import-scope'],sessionId:choice.sessionId})); return
  }
  if (!!values['token-file'] === !!values.revoke) throw new Error('Provide --token-file or --revoke')
  const binding = await bindings.register(values.id, values.revoke ? null : (await readFile(values['token-file']!, 'utf8')).trim(), owner, values['share-telegram'])
  console.log(JSON.stringify({ok:true,id:values.id,bindingId:binding?.bindingId,revoked:Boolean(values.revoke)}))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
