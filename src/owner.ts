import { loadControlConfig } from './config.js'
import { ControlStore } from './control-state.js'
import { parseOwnerArgs } from './owner-args.js'

const help = 'Usage: ezenciel-agents-owner status | approve <telegram-user-id> | approve-group <negative-chat-id> | revoke'
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(help)
  process.exit(0)
}

const { command, value } = parseOwnerArgs(process.argv.slice(2))
const config = loadControlConfig()
const store = new ControlStore(config.controlDir, config.pairingTtlMs)

const usage = (): never => {
  console.error(help)
  process.exit(1)
}

if (command === 'status' && !value) {
  const state = await store.status()
  console.log(JSON.stringify({ owner: state.owner, pending: state.pending, control_dir: config.controlDir }, null, 2))
} else if ((command === 'approve' || command === 'approve-group') && value) {
  const owner = await store.approveOwner(Number(value), command === 'approve-group')
  console.log(`Paired Telegram owner ${owner.telegramUserId}.`)
} else if (command === 'revoke' && !value) {
  console.log((await store.revokeOwner()) ? 'Owner pairing revoked.' : 'No owner pairing existed.')
} else {
  usage()
}
