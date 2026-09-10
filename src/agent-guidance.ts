import { readFileSync } from 'node:fs'

// Resolve against the installed package, never the agent's editable workspace.
export const agentGuidance = (): string =>
  readFileSync(new URL('../templates/agent-guidance.md', import.meta.url), 'utf8').trim()
