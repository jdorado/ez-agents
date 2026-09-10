import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readModels, validateSelection, type AiPreset } from './ai.js'
import { ControlStore } from './control-state.js'

const {values,positionals}=parseArgs({allowPositionals:true,options:{cli:{type:'string'},model:{type:'string'},effort:{type:'string'}}})
if (!process.env.EZ_CONTROL_DIR) throw new Error('Use this agent’s bound control directory')
const catalog=await readModels(undefined,undefined,join(process.env.EZ_CONTROL_DIR,'cli','codex'))
if(positionals[0]==='list')console.log(JSON.stringify(catalog))
else if(positionals[0]==='select'){
  const preset:AiPreset={id:randomBytes(8).toString('hex'),name:[values.model||values.cli,values.effort].filter(Boolean).join(' · '),cli:values.cli||'',model:values.model,effort:values.effort}
  await validateSelection(preset,catalog)
  const control=new ControlStore(process.env.EZ_CONTROL_DIR,900000)
  const state=await control.status()
  if(!state.ai)throw new Error('Agent AI settings are not initialized')
  const existing=state.ai.presets.find(p=>p.cli===preset.cli&&p.model===preset.model&&p.effort===preset.effort)
  const selected=existing||preset
  if(!existing)await control.savePreset(selected)
  const current=state.ai.presets.find(p=>p.id===state.ai!.selectedId)!
  await control.selectPreset(selected.id,state.activeSession?.sessionId??null,current.cli!==selected.cli||Boolean(state.activeSession&&!state.activeSession.cli))
  console.log(JSON.stringify({selected,defaultUnchanged:true,applies:'subsequent messages; queued work keeps its captured choice'}))
}else throw new Error('Use list or select --cli <installed-cli> [--model <model>] [--effort <effort>]')
