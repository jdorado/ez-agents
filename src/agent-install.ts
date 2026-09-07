import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { executorKey } from './executor.js'
import { fileURLToPath } from 'node:url'

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
  root: string; hostRoot: string; composeFile: string; name: string; purpose: string; token: string; cli?: string
}) => {
  const { root, hostRoot, composeFile, name, purpose, token } = options
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Use an agent name of 1–40 lowercase letters, digits or hyphens, starting with a letter.')
  if (![root, hostRoot, composeFile].every(p => isAbsolute(p) && !/[\r\n\0']/.test(p)))
    throw new Error('Installation paths must be absolute and contain no newline or single quote.')
  if (!purpose.trim() || purpose.length > 12000) throw new Error('Supply a purpose of 1–12000 characters.')
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Supply the BotFather token through stdin.')
  await mkdir(root, {recursive:true, mode:0o700})
  const cli = await installationCli(root, options.cli)
  const directory = join(root, name), deploymentDir = join(hostRoot, name)
  // Exclusive directory creation: a repeated name never overwrites another agent.
  await mkdir(directory, {mode:0o700})
  try {
    const project = `ez-agent-${name}`
    const values = {
      COMPOSE_PROJECT_NAME: project,
      COMPOSE_FILE: composeFile,
      EZ_RELAY_ENV_FILE: join(deploymentDir, 'relay.env'),
      EZ_AGENT_PURPOSE_FILE: join(deploymentDir, 'purpose.md'),
      EZ_EXECUTOR_CLI: cli,
      EZ_AGENT_WORKSPACE: join(deploymentDir, 'mind'),
      EZ_CONTROL_DIR: join(deploymentDir, 'control'),
      EZ_WHATSAPP_IPC_VOLUME: `${project}-whatsapp-ipc`,
      EZ_WHATSAPP_CLIENT_VOLUME: `${project}-whatsapp-client`,
    }
    await writeFile(join(directory, 'docker.env'), Object.entries(values).map(([k,v]) => `${k}='${v}'\n`).join(''), {mode:0o600, flag:'wx'})
    await writeFile(join(directory, 'relay.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, {mode:0o600, flag:'wx'})
    await writeFile(join(directory, 'purpose.md'), purpose.trim()+'\n', {mode:0o644, flag:'wx'})
    await mkdir(join(directory,'mind'),{mode:0o700})
    await mkdir(join(directory,'control'),{mode:0o700})
    const agent = {name, project, deploymentDir, purpose:purpose.trim(), executor:cli}
    const host = {cli,agents:[{name,workspace:join(deploymentDir,'mind'),controlDir:join(deploymentDir,'control'),binDir:join(dirname(composeFile),'bin')}]}
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
    const {values:v} = parseArgs({options:{name:{type:'string'},purpose:{type:'string'},'host-root':{type:'string'},'compose-file':{type:'string'},list:{type:'boolean'},cli:{type:'string'},'register-cli':{type:'string'}}})
    if (v['register-cli']) console.log(JSON.stringify({cli:await installationCli('/installations',v['register-cli'])}))
    else if (v.list) console.log(JSON.stringify(await listAgents('/installations')))
    else {
      let token=''
      for await (const chunk of process.stdin) { token+=chunk; if(token.length>512) throw new Error('Token input is too long.') }
      console.log(JSON.stringify(await createAgent({root:'/installations',hostRoot:v['host-root']||'',composeFile:v['compose-file']||'',name:v.name||'',purpose:v.purpose||'',token:token.trim(),cli:v.cli||''})))
    }
  } catch (error) { console.error((error as Error).message); process.exitCode=1 }
}
