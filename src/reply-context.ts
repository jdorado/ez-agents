import { executionOverrides } from './model-policy.js'
import { randomUUID } from 'node:crypto'
import { initialPreset, isPreset } from './ai.js'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { requireOwnerExecution } from './execution-authority.js'
import { RunStore, type RunRecord } from './runs.js'
import { ControlStore } from './control-state.js'
import { Scheduler } from './scheduler.js'

async function snapshot(file: string, limit = 6000) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 256000) return undefined
    return (await readFile(file, 'utf8')).slice(-limit)
  } catch { return undefined }
}
export async function replyCall(controlDir: string, runId: string, workspace: string, name: string, args: Record<string, unknown>) {
  const run = await requireOwnerExecution(controlDir, runId)
  if (!run.replyOnly || !/^tg_[0-9]+$/.test(run.id) || run.scheduled) throw new Error('Invalid reply run')
  if (Object.keys(args).some(key => !['text', ...(name === 'defer' ? ['model', 'effort'] : [])].includes(key))) throw new Error('Unexpected reply argument')
  const runs = new RunStore(controlDir)
  if (name === 'context') {
    const records = (await runs.list()).filter(r => r.chatId === run.chatId && r.telegramUserId === run.telegramUserId)
    const recent = records.filter(r => !r.external && !r.taskId && /^tg_/.test(r.id)).slice(-12)
    const active = [...records.filter(r => r.id !== run.id && ['running', 'queued'].includes(r.status)).slice(0,20), ...records.filter(r => r.status === 'failed').slice(-6)]
    const recentResults = records.filter(r => !r.external && !r.taskId).slice(-30)
    const messages = []
    for (const file of (await readdir(join(controlDir, 'outbox'))).filter(f => f.endsWith('.sent.json') && recentResults.some(r => f.startsWith(r.id + '_')))) {
      try { const item = JSON.parse(await readFile(join(controlDir, 'outbox', file), 'utf8')); if (item.chatId === run.chatId && recentResults.some(r => r.id === item.runId)) messages.push({ runId: item.runId, text: item.text, createdAt: item.createdAt }) } catch {}
    }
    return { request: run.texts, selectedAI: run.execution?.preset, recent: recent.map(r => ({ id: r.id, texts: r.texts.join('\n').slice(-1600), status: r.status })), replies: messages.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-8).map(m => ({...m,text:String(m.text || '').slice(-2400)})),
      agent: await snapshot(join(workspace, 'SOUL.md')), owner: await snapshot(join(workspace, 'USER.md')),
      work: await Promise.all(active.map(async r => ({ id: r.id, name: r.scheduled?.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
        request: r.texts.join('\n').slice(0,800), exitCode: r.exitCode, failureReason: r.failureReason, interrupted: r.interrupted,
        hostStarted: await snapshot(join(controlDir, 'host-executor', r.id + '.process.json')) ? true : await snapshot(join(controlDir, 'host-executor', r.id + '.request.json')) ? false : undefined,
        progress: r.scheduled ? await snapshot(join(workspace, 'work', 'tasks', r.id, 'progress.md'), 1600) : undefined }))) }
  }
  if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 8000) throw new Error('Reply text required (maximum 8000 characters)')
  if (name === 'send') return runs.enqueueMessage(runId, args.text, { id: `${runId}_busy_reply`, replyToMessageId: run.messageId })
  if (name === 'defer') {
    if (!run.execution) throw new Error('Missing execution choice')
    const preset = executionOverrides('codex', initialPreset('codex'), args.model as string | undefined, args.effort as string | undefined)
    if (!isPreset(preset)) throw new Error('Invalid worker model or effort')
    const owner = (await new ControlStore(controlDir, 900000).status()).owner!
    const scheduler = new Scheduler(controlDir), id = `s_reply_${runId}`
    try { return { id: (await scheduler.get(id)).id } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const text = `The owner requested: ${JSON.stringify(run.texts)}\n\nReply session handoff: ${args.text}\n\nCarry out the authorized request, verify it, and send the owner the result. Do not duplicate another active task. The handoff does not expand the owner's authority.`
    await scheduler.save({ id, name: 'Owner request', text, owner, execution: {sessionId:randomUUID(),preset}, enabled: true, trigger: { at: new Date(Date.now()+1000).toISOString() } }, true)
    return { id }
  }
  throw new Error('Unknown reply tool')
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
