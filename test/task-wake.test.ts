import assert from 'node:assert/strict'
import test from 'node:test'
import { queueTaskWake, taskWakePrompt } from '../src/task-wake.js'
import type { RunStore, RunRecord } from '../src/runs.js'
import type { Owner } from '../src/control-state.js'
import type { ExecutionChoice } from '../src/ai.js'

const execution = { sessionId: 'chat', preset: { id: 'p', cli: 'codex', model: 'm' } } as ExecutionChoice
const owner = { id: 'owner', telegramUserId: 42, telegramChatId: 42, pairedAt: new Date(0).toISOString() } as Owner
const store = (existing: Partial<RunRecord>[] = []) => {
  const created: any[] = []
  return { created, runs: { list: async () => existing, create: async (input: unknown) => { created.push(input); return input } } as unknown as RunStore }
}

test('a worker report queues one literal trigger in the owner chat session', async () => {
  const { runs, created } = store()
  assert.ok(await queueTaskWake(runs, owner, 'task_a', execution))
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].texts, [taskWakePrompt('task_a')])
  assert.equal(created[0].execution, execution)
  assert.equal(created[0].chatId, 42)
  assert.equal(created[0].taskId, undefined)
  assert.equal(created[0].scheduled, undefined)
})

test('a queued wake for the task is not duplicated, a running one is not skipped', async () => {
  const text = taskWakePrompt('task_a')
  const queued = store([{ status: 'queued', texts: [text] }])
  assert.equal(await queueTaskWake(queued.runs, owner, 'task_a', execution), undefined)
  assert.equal(queued.created.length, 0)
  const running = store([{ status: 'running', texts: [text] }, { status: 'queued', texts: [taskWakePrompt('task_b')] }])
  assert.ok(await queueTaskWake(running.runs, owner, 'task_a', execution))
  assert.equal(running.created.length, 1)
})

test('no linked chat owner means the report is only saved', async () => {
  const { runs, created } = store()
  assert.equal(await queueTaskWake(runs, null, 'task_a', execution), undefined)
  assert.equal(await queueTaskWake(runs, { id: 'web', pairedAt: new Date(0).toISOString() } as Owner, 'task_a', execution), undefined)
  assert.equal(created.length, 0)
})
