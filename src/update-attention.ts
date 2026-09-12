import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunStore } from './runs.js'
import type { Owner } from './control-state.js'
import type { ExecutionChoice } from './ai.js'

// A local maintenance wakeup uses the existing owner-bound serial run queue.
// Release content is fetched by the agent, never injected as owner instructions.
export async function queueUpdateAttention(controlDir: string, owner: Owner | null, runs: RunStore, execution?: ExecutionChoice) {
  if (!owner) return
  let notice: { id: string }
  try { notice=JSON.parse(await readFile(path.join(controlDir,'update-attention.json'),'utf8')) }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error }
  if (!/^[a-f0-9]{64}$/.test(notice.id)) throw Error('Invalid update attention ID')
  return runs.create({id:`r_update_${createHash('sha256').update(JSON.stringify([notice.id,owner.telegramChatId,owner.telegramUserId])).digest('hex')}`,chatId:owner.telegramChatId,telegramUserId:owner.telegramUserId,execution,
    texts:[JSON.stringify({event:'software_update_attention',noticeId:notice.id})]})
}
