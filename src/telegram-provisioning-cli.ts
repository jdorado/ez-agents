import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { provisionTelegramBot } from './telegram-provisioning.js'

const help = 'Usage: ezenciel-agents-provision-telegram --config PRIVATE_CONFIG_FILE < BOTFATHER_TOKEN\nConfigures one existing Ez deployment. The token is accepted only through stdin, written only to that deployment\'s private relay secret, and is never printed.'

export const runTelegramProvisioningCli = async (args = process.argv.slice(2), input = process.stdin): Promise<void> => {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return }
  if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error(help)
  if ((input as NodeJS.ReadStream).isTTY) throw new Error('Supply the BotFather token through stdin, not a command argument.')
  let token = ''
  for await (const chunk of input) {
    token += chunk.toString()
    if (token.length > 512) { (input as NodeJS.ReadStream).destroy?.(); throw new Error('Token input is too long.') }
  }
  await provisionTelegramBot(args[1], token.trim())
  console.log(JSON.stringify({ configured: true }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTelegramProvisioningCli().catch(error => { console.error((error as Error).message); process.exitCode = 1 })
}
