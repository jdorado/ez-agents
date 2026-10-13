import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { authProfileStatus, readModels, presetLabel, presetProvider, resolveFallbacks, sameChoice, sameEngine, validateSelection, type AiPreset, type ModelChoice } from './ai.js'
import { cliHome, provisionedHome } from './auth-profile.js'
import { ControlStore } from './control-state.js'
import { resolveIsolation } from './isolation.js'

const usage='Usage: ezenciel-agents-ai list | select --cli <installed-cli> [--auth-profile <name>] [--provider <provider>] [--model <model>] [--effort <effort>] | default | profiles | profile add --cli codex|claude --auth-profile <name> | fallbacks [--fallback cli=CLI[,auth-profile=NAME][,provider=ID][,model=MODEL][,effort=EFFORT] ... | --clear] | telemetry [on|off]'
const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean'},cli:{type:'string'},'auth-profile':{type:'string'},provider:{type:'string'},model:{type:'string'},effort:{type:'string'},fallback:{type:'string',multiple:true},clear:{type:'boolean'}}})
if(values.help){
  console.log(`${usage}\nChoose only values returned by list. Selection affects subsequent messages; default makes the selected AI the choice for new conversations. Queued work is unchanged.\nAuth profiles are separate owner-provisioned Codex/Claude logins with their own configuration and sessions; changing profile starts a new conversation. profile add creates an empty home and prints the native login command for the owner to run; profiles reports read-only login status without secrets.\nfallbacks sets the ordered chain tried after the selected AI for chat and application turns, captured when work is queued. An entry for the selected AI's CLI without provider, model or effort keeps the turn's own model and effort. Core advances only when a setup is unavailable or rejected before work, or stopped at its usage limit; each other login resumes its own native session for that conversation. Without options it shows the chain.\ntelemetry on records per-attempt model, token, tool and error-category counts in run records (ezenciel-agents-schedule run RUN_ID); off by default; never prompts, tool arguments/results or costs.`)
  process.exit(0)
}
if (!process.env.EZ_CONTROL_DIR) throw new Error('Use this agent’s bound control directory')
const controlDir=process.env.EZ_CONTROL_DIR
const authProfile=values['auth-profile']
const catalog=():Promise<ModelChoice[]>=>(process.env.EZ_AI_CATALOG==='host'||(process.env.EZ_AI_CATALOG===undefined&&resolveIsolation(process.env)==='host-capable'))
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
else if(positionals[0]==='fallbacks'){
  const control=new ControlStore(controlDir,900000)
  if(values.fallback && values.clear)throw new Error('Choose --fallback or --clear')
  if(values.fallback){
    const chain=[]
    for(const [index,spec] of values.fallback.entries()){
      const fields=Object.fromEntries(spec.split(',').map(part=>{const at=part.indexOf('=');if(at<1)throw new Error('Fallback uses cli=CLI[,auth-profile=NAME][,provider=ID][,model=MODEL][,effort=EFFORT]');return [part.slice(0,at),part.slice(at+1)]}))
      if(!fields.cli || Object.keys(fields).some(key=>!['cli','auth-profile','provider','model','effort'].includes(key)))throw new Error('Fallback uses cli=CLI[,auth-profile=NAME][,provider=ID][,model=MODEL][,effort=EFFORT]')
      const preset:AiPreset={id:`fallback-${index+1}`,name:'Fallback',cli:fields.cli,...(fields.provider ? {provider:fields.provider} : {}),...(fields['auth-profile'] ? {authProfile:fields['auth-profile']} : {}),...(fields.model ? {model:fields.model} : {}),...(fields.effort ? {effort:fields.effort} : {})}
      if(preset.authProfile)await provisionedHome(controlDir,preset.cli,preset.authProfile)
      await validateSelection(preset,await catalog())
      chain.push({...preset,name:presetLabel(preset).slice(0,80)})
    }
    await control.setChatFallbacks(chain)
  } else if(values.clear) await control.setChatFallbacks(undefined)
  const state=await control.status()
  const selected=state.ai?.presets.find(p=>p.id===state.ai?.selectedId)
  console.log(JSON.stringify({fallbacks:state.ai?.fallbacks ?? [],...(selected ? {selected:presetLabel(selected),order:[selected,...resolveFallbacks(selected,state.ai?.fallbacks) ?? []].map(presetLabel)} : {}),
    applies:'chat and application work queued afterwards; queued work keeps its captured chain'}))
}
else if(positionals[0]==='telemetry'){
  const control=new ControlStore(controlDir,900000)
  if(positionals[1]==='on' || positionals[1]==='off')await control.setRunTelemetry(positionals[1]==='on')
  else if(positionals[1]!==undefined)throw new Error(usage)
  console.log(JSON.stringify({runTelemetry:(await control.status()).runTelemetry===true ? 'on' : 'off',applies:'runs started afterwards'}))
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
