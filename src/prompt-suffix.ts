import type { RunRecord } from './runs.js'

// Relay/host overhead converts a run's trigger fields into the one slim suffix
// the core appends to literal input. The core itself never reads the ledger.
export const runPromptSuffix = (run: RunRecord | null | undefined): string => {
  if (!run || run.taskId) return ''
  if (run.messageId === undefined && !run.application && !run.delivery) return ''
  const scope = run.application?.scope ?? run.delivery?.scope
  const channel = run.scheduled ? 'schedule' : run.application || run.delivery ? 'application' : run.messageId !== undefined ? 'chat' : 'trigger'
  const contact = run.messageId !== undefined ? ` message ${run.messageId}` : scope !== undefined ? ` scope ${JSON.stringify(scope)}` : ''
  return `\n\n[${channel}${contact}] Reply via ezenciel-agents-message --text "..."; stdout is not delivered.`
}
