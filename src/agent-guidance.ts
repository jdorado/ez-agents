import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// Resolve against the installed package, never the agent's editable workspace.
export const agentGuidance = (): string =>
  readFileSync(new URL('../templates/agent-guidance.md', import.meta.url), 'utf8').trim()

// Channel behavior is shared without exposing owner workspace guidance to contacts.
export const chatGuidance = (): string =>
  readFileSync(new URL('../templates/chat-guidance.md', import.meta.url), 'utf8').trim()

const start = '<!-- ez shared guidance: begin -->'
const end = '<!-- ez shared guidance: end -->'

// Native instruction installation, refreshed at setup/runtime upgrade, not per turn.
// Personal instructions outside this one managed block remain byte-for-byte intact.
export async function installAgentGuidance(workspace: string): Promise<void> {
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const file = path.join(workspace, name)
    let original: string
    try {
      if (!(await lstat(file)).isFile()) throw new Error(`Native instructions must be a regular file: ${file}`)
      original = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const block = `${start}\n${agentGuidance()}\n${end}\n\n`
    const from = original.indexOf(start), to = original.indexOf(end)
    if ((from < 0) !== (to < 0) || (from >= 0 && (to < from || original.indexOf(start, from + start.length) >= 0 || original.indexOf(end, to + end.length) >= 0)))
      throw new Error(`Malformed shared guidance block: ${file}`)
    const updated = from < 0 ? block + original : original.slice(0, from) + block.trimEnd() + original.slice(to + end.length)
    if (updated === original) continue
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }
}
