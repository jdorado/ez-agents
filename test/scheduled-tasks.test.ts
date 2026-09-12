import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler } from '../src/scheduler.js'
import { scheduledTasksText } from '../src/scheduled-tasks.js'

const owner = { telegramUserId: 101, telegramChatId: 101, pairedAt: '2026-09-11T00:00:00.000Z' }
const execution = { sessionId: randomUUID(), preset: { id: 'fixture', name: 'Fixture', cli: 'codex' } }

test('scheduled task view is read-only, owner-bound, and shows only task titles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-scheduled-tasks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scheduler = new Scheduler(dir)

  assert.deepEqual(await scheduler.listReadOnly(), [])
  await assert.rejects(access(join(dir, 'schedules')), /ENOENT/)

  await scheduler.save({
    id: 'owner-task', name: 'Daily report', text: 'Read the ledger and send the owner a concise report.', owner, execution, enabled: true,
    trigger: { cron: '0 9 * * 1-5', timezone: 'Asia/Dubai', start: '2026-01-01T00:00:00.000Z' },
  })
  await scheduler.save({
    id: 'other-task', name: 'Other owner task', text: 'This must never be visible.',
    owner: { ...owner, telegramUserId: 202, telegramChatId: 202 }, execution, enabled: true,
    trigger: { at: '2027-01-01T00:00:00.000Z' },
  })
  const scheduleDir = join(dir, 'schedules')
  const before = await readFile(join(scheduleDir, 'owner-task.json'), 'utf8')
  const entries = await readdir(scheduleDir)
  const text = scheduledTasksText(await scheduler.listReadOnly(), owner)

  assert.equal(text, 'Scheduled tasks\n\n• Daily report')
  assert.doesNotMatch(text, /Read the ledger|Instructions|Timing|State|Next run/)
  assert.doesNotMatch(text, /Other owner task|This must never be visible/)
  assert.equal(await readFile(join(scheduleDir, 'owner-task.json'), 'utf8'), before)
  assert.deepEqual(await readdir(scheduleDir), entries)
})
