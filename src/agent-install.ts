import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve, dirname, delimiter } from 'node:path'
import { parseArgs } from 'node:util'
import { executorKey } from './executor.js'
import { isolationTransport, parseIsolationClass, type IsolationClass } from './isolation.js'
import { fileURLToPath } from 'node:url'
import { validateCodexProvider, type CodexProviderBinding } from './executor.js'

// Recorded by the installing CLI once; agent creation inherits this binding.
export const installationCli = async (root: string, installerCli?: string): Promise<string> => {
  const file = join(root, 'installation.json')
  let saved: string | undefined
  try {
    const value = JSON.parse(await readFile(file, 'utf8')).cli
    if (typeof value !== 'string' || !value.trim()) throw new Error('Installation CLI record is invalid')
    saved = executorKey(value)
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const requested = installerCli?.trim() ? executorKey(installerCli) : undefined
  if (saved) {
    if (requested && requested !== saved) throw new Error('Use the CLI already selected for this host installation')
    return saved
  }
  if (!requested) throw new Error('The installing agent must record its CLI during package installation; no default is guessed.')
  await mkdir(root, {recursive:true, mode:0o700})
  try { await writeFile(file, JSON.stringify({cli:requested})+'\n', {mode:0o600,flag:'wx'}) }
  catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return installationCli(root, requested)
  }
  return requested
}

export const createAgent = async (options: {
  root: string; hostRoot: string; composeFile: string; name: string; purpose: string; token: string; cli?: string; image?: string; isolation?: string; codexProvider?: CodexProviderBinding; ledgerPort?: number
}) => {
  const { root, hostRoot, composeFile, name, purpose, token } = options
  const requestedIsolation = options.isolation?.trim()
  if (requestedIsolation) parseIsolationClass(requestedIsolation)
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Use an agent name of 1–40 lowercase letters, digits or hyphens, starting with a letter.')
  if (![root, hostRoot, composeFile].every(p => isAbsolute(p) && !/[\r\n\0']/.test(p)))
    throw new Error('Installation paths must be absolute and contain no newline or single quote.')
  if (!purpose.trim() || purpose.length > 2000) throw new Error('Supply a concise purpose of 1–2000 characters.')
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Supply the BotFather token through stdin.')
  const image=options.image||'ezenciel-agents:local'
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))throw new Error('Invalid relay image reference')
  await mkdir(root, {recursive:true, mode:0o700})
  const cli = await installationCli(root, options.cli)
  const isolation: IsolationClass = requestedIsolation ? parseIsolationClass(requestedIsolation) : cli === 'codex' ? 'isolated' : 'host-capable'
  if (isolation === 'isolated' && cli !== 'codex') throw new Error(`Isolated execution is unavailable for ${cli}; use host-capable isolation`)
  const transport = isolationTransport(isolation)
  const ledgerPort = isolation === 'host-capable'
    ? options.ledgerPort ?? 20000 + (createHash('sha256').update(name).digest().readUInt16BE(0) % 10000)
    : undefined
  if (isolation === 'host-capable' && (!Number.isSafeInteger(ledgerPort) || ledgerPort! < 1024 || ledgerPort! > 65535))
    throw new Error('Host-capable agents require a free loopback ledger port for host CLI access')
  const codexProvider = options.codexProvider ? validateCodexProvider(options.codexProvider) : undefined
  if (codexProvider && cli !== 'codex') throw new Error('A Codex provider requires the Codex installation CLI')
  const directory = join(root, name), deploymentDir = join(hostRoot, name)
  // Exclusive directory creation: a repeated name never overwrites another agent.
  await mkdir(directory, {mode:0o700})
  try {
    const project = `ez-agent-${name}`
    const ledgerOverlay = join(deploymentDir, 'ledger.compose.yaml')
    const values = {
      COMPOSE_PROJECT_NAME: project,
      COMPOSE_FILE: [composeFile, ...(ledgerPort ? [ledgerOverlay] : [])].join(delimiter),
      EZ_RELAY_IMAGE: image,
      EZ_RELAY_ENV_FILE: join(deploymentDir, 'relay.env'),
      EZ_AGENT_PURPOSE_FILE: join(deploymentDir, 'purpose.md'),
      EZ_EXECUTOR_CLI: cli,
      EZ_ISOLATION: isolation,
      EZ_EXECUTOR_TRANSPORT: transport,
      ...(ledgerPort ? { EZ_DELIVERY_TCP_PORT: String(ledgerPort) } : {}),
      ...(isolation === 'isolated' && cli === 'codex' ? { EZ_CODEX_SANDBOX: 'external' } : {}),
      EZ_AGENT_WORKSPACE: join(deploymentDir, 'mind'),
      EZ_CONTROL_DIR: join(deploymentDir, 'control'),
      EZ_TOOLS_HOME: join(deploymentDir, 'tools'),
      EZ_PLUGIN_BROKER_SOCKET: join(deploymentDir, 'control', 'plugin-broker.sock'),
      EZ_PLUGIN_BROKER_HOST_CONFIG: join(deploymentDir, 'host-executor.json'),
      ...(isolation === 'isolated' ? { COMPOSE_PROFILES: 'isolated' } : {}),
      EZ_WHATSAPP_IPC_VOLUME: `${project}-whatsapp-ipc`,
      EZ_WHATSAPP_CLIENT_VOLUME: `${project}-whatsapp-client`,
    }
    await writeFile(join(directory, 'docker.env'), Object.entries(values).map(([k,v]) => `${k}='${v}'\n`).join(''), {mode:0o600, flag:'wx'})
    if (ledgerPort) await writeFile(join(directory, 'ledger.compose.yaml'), [
      '# Host-capable execution: on Docker Desktop/OrbStack the control-volume',
      '# Unix socket is not connectable from the host, so the relay serves its',
      '# memory ledger on this published loopback port and requests authenticate',
      '# with the per-run token in the control directory.',
      'services:',
      '  relay:',
      '    environment:',
      '      EZ_DELIVERY_TCP_PORT: ${EZ_DELIVERY_TCP_PORT:?}',
      '    ports:',
      '      - "127.0.0.1:${EZ_DELIVERY_TCP_PORT:?}:${EZ_DELIVERY_TCP_PORT:?}"',
      '',
    ].join('\n'), {mode:0o600, flag:'wx'})
    await writeFile(join(directory, 'relay.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, {mode:0o600, flag:'wx'})
    await writeFile(join(directory, 'purpose.md'), purpose.trim()+'\n', {mode:0o644, flag:'wx'})
    await mkdir(join(directory,'mind'),{mode:0o700})
    await mkdir(join(directory,'control'),{mode:0o700})
    await mkdir(join(directory,'tools'),{mode:0o700})
    const agent = {name, project, deploymentDir, purpose:purpose.trim(), executor:cli, isolation}
    const host = {cli,isolation,agents:[{name,workspace:join(deploymentDir,'mind'),controlDir:join(deploymentDir,'control'),binDir:join(dirname(composeFile),'bin'),...(isolation === 'isolated' ? {toolsHome:join(deploymentDir,'tools')} : {}),...(codexProvider?{codexProviders:[codexProvider]}:{})}]}
    await writeFile(join(directory,'host-executor.json'),JSON.stringify(host,null,2)+'\n',{mode:0o600,flag:'wx'})
    await writeFile(join(directory, 'agent.json'), JSON.stringify(agent,null,2)+'\n', {mode:0o600, flag:'wx'})
    return agent
  } catch (error) { await rm(directory, {recursive:true, force:true}); throw error }
}

export const listAgents = async (root: string) => {
  const agents = []
  for (const entry of await readdir(root, {withFileTypes:true})) {
    if (!entry.isDirectory()) continue
    try { agents.push(JSON.parse(await readFile(join(root,entry.name,'agent.json'),'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return agents
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values:v} = parseArgs({options:{name:{type:'string'},purpose:{type:'string'},isolation:{type:'string'},'host-root':{type:'string'},'compose-file':{type:'string'},'relay-image':{type:'string'},'ledger-port':{type:'string'},list:{type:'boolean'},cli:{type:'string'},'register-cli':{type:'string'},'codex-provider':{type:'string'},'codex-provider-name':{type:'string'},'codex-base-url':{type:'string'},'codex-env-key':{type:'string'},'codex-model':{type:'string',multiple:true}}})
    if (v['register-cli']) console.log(JSON.stringify({cli:await installationCli('/installations',v['register-cli'])}))
    else if (v.list) console.log(JSON.stringify(await listAgents('/installations')))
    else {
      let token=''
      for await (const chunk of process.stdin) { token+=chunk; if(token.length>512) throw new Error('Token input is too long.') }
      const providerValues=[v['codex-provider'],v['codex-provider-name'],v['codex-base-url'],v['codex-env-key'],v['codex-model']]
      const codexProvider=providerValues.some(Boolean)?validateCodexProvider({id:v['codex-provider']||'',name:v['codex-provider-name']||v['codex-provider']||'',baseUrl:v['codex-base-url']||'',envKey:v['codex-env-key']||'',models:v['codex-model']||[]}):undefined
      console.log(JSON.stringify(await createAgent({root:'/installations',hostRoot:v['host-root']||'',composeFile:v['compose-file']||'',name:v.name||'',purpose:v.purpose||'',token:token.trim(),cli:v.cli||'',image:v['relay-image'],isolation:v.isolation,codexProvider,ledgerPort:v['ledger-port']===undefined?undefined:Number(v['ledger-port'])})))
    }
  } catch (error) { console.error((error as Error).message); process.exitCode=1 }
}
