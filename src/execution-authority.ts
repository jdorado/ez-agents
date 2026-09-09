import { ControlStore } from './control-state.js'
import { RunStore, type RunRecord } from './runs.js'
import type { Owner } from './control-state.js'

export const EXTERNAL_EXECUTION_BLOCK = 'external-execution-unavailable' as const

// All current adapters run with the installing user's authority. A fresh
// session or plugin declaration does not make that an isolated task runner.
export function executionBlockReason(run: RunRecord, owner: Owner | null): string | undefined {
  if (!owner || run.telegramUserId !== owner.telegramUserId || run.chatId !== owner.telegramChatId)
    return 'owner-mismatch'
  if (run.taskId || run.external || run.id.startsWith('event_')) return EXTERNAL_EXECUTION_BLOCK
}

// Re-read core state at both launch boundaries. Request metadata and EZ_RUN_ID
// are not proof of owner identity. Local host administrators remain trusted.
export async function requireOwnerExecution(controlDir: string, runId: string): Promise<RunRecord> {
  const run = await new RunStore(controlDir).get(runId)
  if (!run || run.status !== 'running') throw new Error('No active core run')
  const owner = (await new ControlStore(controlDir, 900_000).status()).owner
  const reason = executionBlockReason(run, owner)
  if (reason) throw new Error(`Execution blocked: ${reason}`)
  return run
}
