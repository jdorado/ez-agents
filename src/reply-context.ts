import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { RunStore, type RunRecord } from './runs.js'

async function snapshot(file: string, limit = 6000) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 256000) return undefined
    return (await readFile(file, 'utf8')).slice(-limit)
  } catch { return undefined }
}
export async function ownerConversationContext(controlDir: string, run: RunRecord, workspace?: string) {
  const runs = new RunStore(controlDir)
    const records = (await runs.list()).filter(r => r.chatId === run.chatId && r.telegramUserId === run.telegramUserId)
    const recent = records.filter(r => !r.external && !r.taskId && /^tg_/.test(r.id)).slice(-12)
    const active = [...records.filter(r => r.id !== run.id && ['running', 'queued'].includes(r.status)).slice(0,20), ...records.filter(r => r.status === 'failed').slice(-6)]
    const recentResults = records.filter(r => !r.external && !r.taskId).slice(-30)
    const messages = []
    for (const file of (await readdir(join(controlDir, 'outbox'))).filter(f => f.endsWith('.sent.json') && recentResults.some(r => f.startsWith(r.id + '_')))) {
      try { const item = JSON.parse(await readFile(join(controlDir, 'outbox', file), 'utf8')); if (item.chatId === run.chatId && recentResults.some(r => r.id === item.runId)) messages.push({ runId: item.runId, text: item.text, createdAt: item.createdAt }) } catch {}
    }
    return { request: run.texts, selectedAI: run.execution?.preset, recent: recent.map(r => ({ id: r.id, texts: r.texts.join('\n').slice(-1600), status: r.status })), replies: messages.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-8).map(m => ({...m,text:String(m.text || '').slice(-2400)})),
      agent: workspace ? await snapshot(join(workspace, 'SOUL.md')) : undefined, owner: workspace ? await snapshot(join(workspace, 'USER.md')) : undefined,
      work: await Promise.all(active.map(async r => ({ id: r.id, name: r.scheduled?.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
        request: r.texts.join('\n').slice(0,800), exitCode: r.exitCode, failureReason: r.failureReason, interrupted: r.interrupted,
        hostStarted: await snapshot(join(controlDir, 'host-executor', r.id + '.process.json')) ? true : await snapshot(join(controlDir, 'host-executor', r.id + '.request.json')) ? false : undefined,
        progress: r.scheduled && workspace ? await snapshot(join(workspace, 'work', 'tasks', r.id, 'progress.md'), 1600) : undefined }))) }
}
// Give the next normal conversation turn the replies it did not see natively.
export async function parallelReplyHistory(controlDir: string, current: RunRecord) {
  const records = (await new RunStore(controlDir).list()).filter(r => r.chatId === current.chatId && r.telegramUserId === current.telegramUserId && r.id !== current.id)
  const previous = records.filter(r => /^tg_/.test(r.id) && !r.replyOnly && r.status === 'completed').at(-1)
  const cutoff = previous?.startedAt || previous?.createdAt || ''
  const history = []
  for (const r of records.filter(r => r.replyOnly).slice(-8)) {
    try {
      const receipt = JSON.parse(await readFile(join(controlDir, 'outbox', r.id+'_busy_reply.sent.json'), 'utf8'))
      // A reply delivered during that turn was absent from its initial prompt.
      if (receipt.receipt?.deliveredAt && receipt.receipt.deliveredAt <= cutoff) continue
      if (receipt.chatId === current.chatId) history.push({owner: r.texts.join('\n').slice(-1600), reply: String(receipt.text || '').slice(-2400)})
    } catch {}
  }
  return history
}
