import { mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertId } from './identity.js'

// Fixed, agent-bound path, never a caller-provided cwd. No shared mutable task files.
export async function taskWorkspace(workspace: string, id: string): Promise<string> {
  const dirs=[join(workspace,'work'),join(workspace,'work','tasks'),join(workspace,'work','tasks',assertId(id))]
  for(const dir of dirs){
    await mkdir(dir,{recursive:true,mode:0o700})
    if(!(await lstat(dir)).isDirectory())throw new Error('Task workspace must not be a symlink')
  }
  return dirs[2]
}
