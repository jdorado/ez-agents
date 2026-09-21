import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import { InboxStore } from '../src/inbox.js'
import { RunStore } from '../src/runs.js'

const update = (id: number): Update => ({ update_id: id })
test('intake deduplicates IDs, seals membership and retains cancellation tombstones (memory only)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-inbox-'))
  try {
    const inbox = new InboxStore(dir)
    assert.equal(await inbox.accept(update(1)), true)
    assert.equal(await inbox.accept(update(1)), false)
    await inbox.accept(update(2))
    assert.equal(await inbox.next(), undefined)
    const batch = (await inbox.next(true))!
    assert.deepEqual(
      batch.entries.map((e) => e.update.update_id),
      [1, 2],
    )
    await inbox.accept(update(3))
    assert.deepEqual(await inbox.next(true), batch)
    const runs = new RunStore(dir)
    const input = { id: batch.id, chatId: 101, telegramUserId: 101, texts: ['hello'] }
    await runs.create(input)
    // Retry with the same run ID returns the existing run; no second run.
    await runs.create(input)
    assert.equal((await runs.list()).length, 1)
    await inbox.finish(batch.id)
    assert.equal((await inbox.next(true))?.id, 'tg_3')
    assert.equal(await inbox.cancel(), 1)
    assert.equal(await inbox.accept(update(3)), false)
    assert.equal(await inbox.next(true), undefined)
    // Stateless pipe: no inbox.json exists on disk; restart drops by design.
    await assert.rejects(stat(join(dir, 'inbox.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restart loses nothing by design; invalid identifiers are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-inbox-corrupt-'))
  try {
    // A fresh directory starts empty: no durable journal survives a restart.
    const inbox = new InboxStore(dir)
    assert.deepEqual(await inbox.status(), { pending: 0, failed: 0 })
    assert.throws(() => inbox.accept(update(-1)), /Invalid update ID/)
    await assert.rejects(
      new RunStore(dir).create({ id: '../escape', chatId: 101, telegramUserId: 101, texts: [] }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed batches are visible, not automatically retried, and do not block following messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-inbox-failed-'))
  try {
    const inbox = new InboxStore(dir)
    await Promise.all([inbox.accept(update(1)), inbox.accept(update(2)), inbox.accept(update(2))])
    const batch = (await inbox.next(true))!
    await inbox.finish(batch.id, true)
    assert.deepEqual(await inbox.status(), { pending: 0, failed: 1 })
    assert.equal(await inbox.next(true), undefined)
    await inbox.accept(update(3))
    assert.equal((await inbox.next(true))?.id, 'tg_3')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manual retry is owner/chat-bound and cannot revive pending or cancelled work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-inbox-retry-'))
  try {
    const inbox = new InboxStore(dir)
    await inbox.accept({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: 'Fixture',
        from: { id: 101, is_bot: false, first_name: 'Fixture' },
        chat: { id: 101, type: 'private', first_name: 'Fixture' },
      },
    })
    const batch = (await inbox.next(true))!
    await inbox.finish(batch.id, true)
    assert.equal(await inbox.retryLatest(202, 101), undefined)
    assert.equal(await inbox.retryLatest(101, -101), undefined)
    assert.equal(await inbox.retryLatest(101, 101), batch.id)
    assert.equal(await inbox.retryLatest(101, 101), undefined)
    await inbox.cancel()
    assert.equal(await inbox.retryLatest(101, 101), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
