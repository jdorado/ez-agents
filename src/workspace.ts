import { installAgentGuidance } from './agent-guidance.js'
import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { TOOLS_LINE } from './tools-line.mjs'

// Engine-neutral memory: every native CLI loads AGENTS.md, so both read the
// same plain files. The agent owns the folder and the section after seeding.
const MEMORY_SEED = `## Memory

Keep durable facts (people, preferences, decisions, standing commitments) in
\`memory/\`, one fact per file, each listed on one line in \`memory/MEMORY.md\`.
Read \`memory/MEMORY.md\` when a conversation starts. Save or update a fact as
soon as you learn something a future conversation will need; skip what other
workspace files already hold.`

// Publish each complete seed exclusively. Reinstall never replaces the agent's mind.
export const initializeWorkspace = async (workspace: string, purposeFile: string | undefined = process.env.EZ_AGENT_PURPOSE_FILE): Promise<string[]> => {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  if (!(await lstat(workspace)).isDirectory()) throw new Error(`Workspace directory must not be a symlink: ${workspace}`)
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
    const purpose = (await readFile(purposeFile, 'utf8')).trim()
    if (!purpose) throw new Error('Purpose file must not be empty.')
    await writeFile(temporary, `## Purpose\n\n${purpose}\n\n${MEMORY_SEED}\n\n${TOOLS_LINE}\n`, { mode: 0o600, flag: 'wx' })
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
