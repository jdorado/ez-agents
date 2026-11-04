import type { ExecutionChoice } from './ai.js'
import { ownerId, ownerEpoch, telegramOwner, type Owner } from './control-state.js'
import type { RunStore, RunRecord } from './runs.js'

// A restricted task worker never writes to the owner. Its report is saved on the
// task and the owner's own chat session gets this one literal trigger. The
// agent reads the report with `ezenciel-agents-task list` and decides whether
// the owner needs to hear anything; Ez builds no owner message.
export const taskWakePrompt = (taskId: string) =>
  `[task ${taskId}] Worker report saved. Owner messages go through ezenciel-agents-message --text "..."; stdout is not delivered.`

export async function queueTaskWake(runs: RunStore, owner: Owner | null, taskId: string, execution: ExecutionChoice): Promise<RunRecord | undefined> {
  const target = telegramOwner(owner)
  if (!target) return undefined
  const text = taskWakePrompt(taskId)
  // A queued wake reads every saved report when it runs, so a second one adds nothing.
  if ((await runs.list()).some(run => run.status === 'queued' && !run.taskId && run.texts[0] === text)) return undefined
  return runs.create({ ownerId: ownerId(target), ownerEpoch: ownerEpoch(target), telegramEpoch: target.telegramLinkedAt ?? target.pairedAt,
    chatId: target.telegramChatId, telegramUserId: target.telegramUserId, texts: [text], execution })
}
