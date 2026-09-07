import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/runs.js'
import { recoverInterruptedRuns } from '../docker/recovery.js'

test('exclusive Docker restart fails interrupted runs even when a container PID has been reused, without replaying queued work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-container-recovery-'))
  try {
    const store = new RunStore(dir)
    const prior = await store.create({ chatId: 1, telegramUserId: 1, texts: ['old'] })
    const queued = await store.create({ chatId: 1, telegramUserId: 1, texts: ['queued'] })
    await store.patch(prior.id, { status: 'running', pid: process.pid })
    await recoverInterruptedRuns(dir)
    assert.equal((await store.get(prior.id))?.status, 'failed')
    assert.equal((await store.get(queued.id))?.status, 'queued')
    const ended = (await store.get(prior.id))?.endedAt
    await recoverInterruptedRuns(dir)
    assert.equal((await store.get(prior.id))?.endedAt, ended)
  } finally { await rm(dir, {recursive:true, force:true}) }
})
