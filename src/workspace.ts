import { installAgentGuidance } from './agent-guidance.js'
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
  const name = 'AGENTS.md'
  const target = path.join(workspace, name)
  try {
    if (!(await lstat(target)).isFile()) throw new Error(`Workspace seed must be a regular file: ${target}`)
    await installAgentGuidance(workspace)
    return created
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!purposeFile) throw new Error('A concise purpose file is required to initialize a new workspace.')
  const temporary = path.join(workspace, `.${name}.${randomUUID()}.tmp`)
  try {
    const template = await readFile(path.join(templates, name), 'utf8')
    const purpose = (await readFile(purposeFile, 'utf8')).trim()
    if (!purpose) throw new Error('Purpose file must not be empty.')
    await writeFile(temporary, `${template.trim()}\n\n## Purpose\n\n${purpose}\n`, { mode: 0o600, flag: 'wx' })
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
  await installAgentGuidance(workspace)
  return created
}
