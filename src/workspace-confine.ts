import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type SiblingDeny = { deny: string; allow: string }

const resolved = (value: string) => {
  try { return realpathSync(value) }
  catch { return path.resolve(value) }
}

// Confine extra project paths to this workspace. Do not deny $HOME: Codex and
// host CLIs live there. A tenant farm (sibling workspaces) is the parent dir.
export const workspaceSiblingDenies = (workspace: string, home = homedir()): SiblingDeny[] => {
  const allow = resolved(workspace)
  const deny = path.dirname(allow)
  const root = path.parse(allow).root
  const homeDir = resolved(home)
  if (!allow.startsWith(root) || deny === root || deny === homeDir || deny === path.dirname(homeDir)) return []
  return [{ deny, allow }]
}

const sbplPath = (value: string) => JSON.stringify(value)

export const macosWorkspaceProfile = (denies: SiblingDeny[], extraAllows: string[] = []): string => {
  const lines = ['(version 1)', '(allow default)']
  for (const { deny, allow } of denies) {
    lines.push(`(deny file-read-data file-write* (subpath ${sbplPath(deny)}))`)
    lines.push(`(allow file-read-data file-write* (subpath ${sbplPath(allow)}))`)
    for (const extra of extraAllows) {
      const resolvedExtra = resolved(extra)
      if (resolvedExtra === deny || resolvedExtra.startsWith(`${deny}${path.sep}`)) {
        lines.push(`(allow file-read-data file-write* (subpath ${sbplPath(resolvedExtra)}))`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}
