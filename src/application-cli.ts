import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { loadControlConfig } from './config.js'
import { ControlStore, sameOwner, ownerId } from './control-state.js'
import { ApplicationBindings, applicationScope, validateApplicationRegistration } from './application-channel.js'
import { initialPreset } from './ai.js'
import { applicationId } from './application-origin.js'

async function main() {
  const { values } = parseArgs({ options: {
    owner: {type:'string'}, id: {type:'string'}, 'token-file': {type:'string'}, revoke: {type:'boolean'}, list: {type:'boolean'}, help: {type:'boolean'},
    'owner-id': {type:'string'}, rotate: {type:'boolean'}, 'share-owner': {type:'boolean'},
    'import-scope': {type:'string'}, 'native-session': {type:'string'}, cli: {type:'string'}, 'share-telegram': {type:'boolean'},
  } })
  if (values.help) { console.log('ezenciel-agents-application --id CHANNEL --token-file PRIVATE_FILE [--owner-id VERIFIED_OWNER_ID] [--share-owner] [--rotate] | --id CHANNEL --revoke | --list | --id CHANNEL --import-scope SCOPE --native-session ID --cli CLI'); return }
  if (process.env.EZ_RUN_ID) throw new Error('Application authority is configured by the installing administrator outside agent turns')
  const config = loadControlConfig(), control = new ControlStore(config.controlDir, config.pairingTtlMs)
  if (values.owner && values['owner-id']) throw new Error('Choose one owner registration form')
  if (values['owner-id'] && (!values.id || !values['token-file'] || values.revoke || values.list || values['import-scope'])) throw new Error('--owner-id requires channel registration')
  if (values.owner && (process.env.EZ_TELEGRAM_ENABLED !== 'false' || !values.id || !values['token-file'] || values.revoke || values.list || values['import-scope'])) throw new Error('--owner bootstrap requires explicit application-only registration')
  const registrationToken = values['token-file'] ? (await readFile(values['token-file'], 'utf8')).trim() : null
  if (values.owner || values['owner-id']) validateApplicationRegistration(values.id!, registrationToken)
  const owner = values['owner-id'] ? await control.registerOwner(values['owner-id']) : values.owner ? await control.bootstrapApplicationOwner(Number(values.owner)) : (await control.status()).owner
  if (!owner) throw new Error('Register an owner with --owner-id or pair a Telegram owner')
  const bindings = new ApplicationBindings(config.controlDir)
  if (values.list) { console.log(JSON.stringify((await bindings.list()).map(({id,bindingId}) => ({id,bindingId})))); return }
  if (!values.id || !applicationId(values.id)) throw new Error('Application ID required')
  if (values['import-scope']) {
    const binding = (await bindings.list()).find(item => item.id === values.id)
    if (!binding || !sameOwner(binding.owner, owner) || !applicationId(values['import-scope']) || !values['native-session'] || !/^[a-zA-Z0-9_-]{1,160}$/.test(values['native-session']) || !values.cli) throw new Error('Current application binding, scope, native session and CLI required')
    if (values['share-owner'] && !binding.shareTelegram) throw new Error('This channel is not registered for shared owner chat')
    const choice = await control.captureApplicationChoice(initialPreset(values.cli), applicationScope(binding.bindingId, values['import-scope']), values['share-owner'] === true)
    if (choice.preset.cli !== values.cli) throw new Error('Application scope already uses a different engine')
    await control.saveNativeSession(choice.sessionId, values['native-session'])
    console.log(JSON.stringify({ok:true,scope:values['import-scope'],sessionId:choice.sessionId})); return
  }
  if (!!values['token-file'] === !!values.revoke) throw new Error('Provide --token-file or --revoke')
  const binding = await bindings.register(values.id, values.revoke ? null : registrationToken, owner, values['share-owner'] || values['share-telegram'], values.rotate)
  console.log(JSON.stringify({ok:true,ownerId:ownerId(owner),id:values.id,bindingId:binding?.bindingId,revoked:Boolean(values.revoke)}))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
