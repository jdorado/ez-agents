import { installAgentGuidance } from './agent-guidance.js'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertId } from './identity.js'

// Fixed, agent-bound path, never a caller-provided cwd. No shared mutable task files.
export async function taskWorkspace(workspace: string, id: string): Promise<string> {
  const dirs=[join(workspace,'work'),join(workspace,'work','tasks'),join(workspace,'work','tasks',assertId(id))]
  for(const dir of dirs){
    await mkdir(dir,{recursive:true,mode:0o700})
    if(!(await lstat(dir)).isDirectory())throw new Error('Task workspace must not be a symlink')
  }
  const target=dirs[2]
  for(const name of ['SOUL.md','USER.md','TOOLS.md']){
    try {
      const content=await readFile(join(workspace,name),'utf8')
      await writeFile(join(target,name),content,{mode:0o600,flag:'wx'})
    }catch(e){if(!['ENOENT','EEXIST'].includes((e as NodeJS.ErrnoException).code || ''))throw e}
  }
  try{await writeFile(join(target,'AGENTS.md'),`# Background task\n\nYou work for the same owner as the main agent. Use SOUL.md, USER.md and TOOLS.md only when relevant to this task.\nKeep writes and artifacts in this task directory; do not modify the parent agent's mind or other tasks. Follow the task's notification policy. Send requested results with ezenciel-agents-message and verify delivery before completing the task; native final text does not reach the owner.\n`,{mode:0o600,flag:'wx'})}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  await installAgentGuidance(target)
  return target
}
