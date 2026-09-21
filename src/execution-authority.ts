import { ApplicationBindings } from './application-channel.js'
import { RunStore, type RunRecord } from './runs.js'
import { validOwner, type Owner } from './control-state.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ownsRun } from './identity.js'

export const EXTERNAL_EXECUTION_BLOCK = 'external-execution-unavailable' as const

// All current adapters run with the installing user's authority. A fresh
// session or plugin declaration does not make that an isolated task runner.
export function executionBlockReason(run: RunRecord, owner: Owner | null): string | undefined {
  if (!ownsRun(owner, run))
    return 'owner-mismatch'
  if (run.taskId || run.external || run.id.startsWith('event_')) return EXTERNAL_EXECUTION_BLOCK
}

// Stateless pipe: intake authorizes the sender before spawn. The executor
// re-verifies owner binding with a read-only control-state.json read: zero
// control/ writes, fail-closed on missing/corrupt/revoked owner. Request
// metadata and EZ_RUN_ID are not proof of owner identity. Local host
// administrators remain trusted.
export const readOnlyOwner = async (controlDir: string): Promise<Owner | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(controlDir, 'control-state.json'), 'utf8'))
    const owner = (parsed as { owner?: unknown }).owner ?? null
    return validOwner(owner) ? (owner as Owner) : null
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function requireOwnerExecution(controlDir: string, runId: string): Promise<RunRecord> {
  const run = await new RunStore(controlDir).get(runId)
  if (!run || run.status !== 'running') throw new Error('No active core run')
  if (run.taskId || run.external || run.id.startsWith('event_')) throw new Error(`Execution blocked: ${EXTERNAL_EXECUTION_BLOCK}`)
  const owner = await readOnlyOwner(controlDir)
  const reason = executionBlockReason(run, owner)
  if (reason) throw new Error(`Execution blocked: ${reason}`)
  if (run.application || run.delivery) await new ApplicationBindings(controlDir).authorize(run)
  return run
}
