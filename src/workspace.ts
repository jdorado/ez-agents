import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templates = fileURLToPath(new URL('../templates/agent/', import.meta.url))

// Publish each complete seed exclusively. Reinstall never replaces the agent's mind.
export const initializeWorkspace = async (workspace: string, purposeFile: string | undefined = process.env.EZ_AGENT_PURPOSE_FILE): Promise<string[]> => {
  for (const dir of [workspace, path.join(workspace, 'inbox'), path.join(workspace, 'work')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (!(await lstat(dir)).isDirectory()) throw new Error(`Workspace directory must not be a symlink: ${dir}`)
  }
  const created: string[] = []
  for (const name of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md']) {
    const target = path.join(workspace, name)
    const temporary = path.join(workspace, `.${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, await readFile(name === 'SOUL.md' && purposeFile ? purposeFile : path.join(templates, name)), { mode: 0o600, flag: 'wx' })
      try {
        await link(temporary, target)
        created.push(name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!(await lstat(target)).isFile()) throw new Error(`Workspace seed must be a regular file: ${target}`)
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return created
}
