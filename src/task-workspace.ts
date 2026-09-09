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
  try{await writeFile(join(target,'AGENTS.md'),`# Background task\n\nRead SOUL.md, USER.md and TOOLS.md when present. You work for the same owner as the main agent.\nYour task directory is your writable workspace. Keep progress and artifacts here; do not modify the parent agent's mind or other tasks. The main agent may read your progress.\nDelegate through your executor's native tools when useful. For an explicitly persistent objective, use native /goal or ask the executor to set its native goal. Do not pretend plain text alone proved goal activation.\nSend the owner useful progress and the final result using ezenciel-agents-message; stdout is not delivered. Verify the result before claiming completion.\n`,{mode:0o600,flag:'wx'})}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  return target
}
