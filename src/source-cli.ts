import { parseArgs } from 'node:util'
import { loadControlConfig } from './config.js'
import { ControlStore } from './control-state.js'
import { EventSources } from './event-sources.js'

async function main() {
  const { values } = parseArgs({ options: { name: { type: 'string' }, socket: { type: 'string' }, remove: { type: 'boolean' }, list: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) { console.log('ezenciel-agents-source --list | --name NAME --socket /absolute/service.sock | --name NAME --remove'); console.log('Run registration inside the relay where the source socket is mounted. For setup and monitoring guidance: ezenciel-agents-task --help'); return }
  const config = loadControlConfig()
  const sources = new EventSources(config.controlDir)
  if (values.list) { console.log(JSON.stringify(await sources.list())); return }
  if (!values.name || (!!values.socket === !!values.remove)) throw new Error('Supply --name and either --socket or --remove')
  const owner = (await new ControlStore(config.controlDir, config.pairingTtlMs).status()).owner
  if (!owner) throw new Error('Pair an owner before registering event sources')
  const source = await sources.register(values.name, values.remove ? null : values.socket!, owner)
  console.log(JSON.stringify({ ok: true, source: source ?? null }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
