import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const start = '<!-- ez shared guidance: begin -->'
const end = '<!-- ez shared guidance: end -->'

// Drop the obsolete package-owned handbook. Discovery lives in the managed
// ez tools locator. Personal text outside the markers stays byte-for-byte.
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
    const from = original.indexOf(start), to = original.indexOf(end)
    if ((from < 0) !== (to < 0) || (from >= 0 && (to < from || original.indexOf(start, from + start.length) >= 0 || original.indexOf(end, to + end.length) >= 0)))
      throw new Error(`Malformed shared guidance block: ${file}`)
    if (from < 0) continue
    let rest = original.slice(to + end.length)
    if (from === 0 && rest.startsWith('\n')) rest = rest.slice(1)
    const updated = original.slice(0, from) + rest
    if (updated === original) continue
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }
}
