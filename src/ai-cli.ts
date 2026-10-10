import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { authProfileStatus, readModels, presetProvider, sameChoice, sameEngine, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { cliHome } from './auth-profile.js'
import { ControlStore } from './control-state.js'
import { resolveIsolation } from './isolation.js'

const usage='Usage: ezenciel-agents-ai list | select --cli <installed-cli> [--auth-profile <name>] [--provider <provider>] [--model <model>] [--effort <effort>] | default | profiles | profile add --cli codex|claude --auth-profile <name>'
const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean'},cli:{type:'string'},'auth-profile':{type:'string'},provider:{type:'string'},model:{type:'string'},effort:{type:'string'}}})
if(values.help){
  console.log(`${usage}\nChoose only values returned by list. Selection affects subsequent messages; default makes the selected AI the choice for new conversations. Queued work is unchanged.\nAuth profiles are separate owner-provisioned Codex/Claude logins with their own configuration and sessions; changing profile starts a new conversation. profile add creates an empty home and prints the native login command for the owner to run; profiles reports read-only login status without secrets.`)
  process.exit(0)
}
if (!process.env.EZ_CONTROL_DIR) throw new Error('Use this agent’s bound control directory')
const controlDir=process.env.EZ_CONTROL_DIR
const authProfile=values['auth-profile']
const catalog=():Promise<ModelChoice[]>=>resolveIsolation(process.env)==='host-capable'
  ? readFile(join(controlDir,'host-executor','models.json'),'utf8').then(text=>JSON.parse(text))
  : readModels(undefined,undefined,join(controlDir,'cli','codex'),undefined,undefined,undefined,controlDir)
if(positionals[0]==='list')console.log(JSON.stringify(await catalog()))
else if(positionals[0]==='profiles')console.log(JSON.stringify(await authProfileStatus(controlDir)))
else if(positionals[0]==='profile' && positionals[1]==='add'){
  if(!authProfile)throw new Error('profile add requires --auth-profile <name>')
  const home=cliHome(controlDir,values.cli||'',authProfile)
  const created=await mkdir(home,{recursive:true,mode:0o700})
  const login=values.cli==='codex' ? `CODEX_HOME=${home} codex login`
    : `CLAUDE_CONFIG_DIR=${home} claude auth login (or store a \`claude setup-token\` token in ${home}/oauth-token, mode 600)`
  console.log(JSON.stringify({cli:values.cli,authProfile,home,created:created!==undefined,ownerLogin:login}))
}
else if(positionals[0]==='default'){
  const control=new ControlStore(controlDir,900000)
  const state=await control.status()
  const selected=state.ai?.presets.find(p=>p.id===state.ai?.selectedId)
  if(!selected)throw new Error('No selected AI')
  await validateSelection(selected,await catalog())
  await control.defaultPreset(selected.id)
  console.log(JSON.stringify({default:selected,applies:'new conversations; current and queued work unchanged'}))
}
else if(positionals[0]==='select'){
  const preset:AiPreset={id:randomBytes(8).toString('hex'),name:[values.provider,values.model||values.cli,values.effort].filter(Boolean).join(' · ')+(authProfile ? ` @${authProfile}` : ''),cli:values.cli||'',provider:values.provider,...(authProfile ? {authProfile} : {}),model:values.model,effort:values.effort}
  await validateSelection(preset,await catalog())
  const control=new ControlStore(controlDir,900000)
  const state=await control.status()
  if(!state.ai)throw new Error('Agent AI settings are not initialized')
  const existing=state.ai.presets.find(p=>sameChoice(p,preset))
  const selected=existing||preset
  if(!existing)await control.savePreset(selected)
  const current=state.ai.presets.find(p=>p.id===state.ai!.selectedId)!
  await control.selectPreset(selected.id,state.activeSession?.sessionId??null,!sameEngine(current,selected)||presetProvider(current)!==presetProvider(selected)||Boolean(state.activeSession&&!state.activeSession.cli))
  console.log(JSON.stringify({selected,defaultUnchanged:true,applies:'subsequent messages; queued work keeps its captured choice'}))
}else throw new Error(usage)
