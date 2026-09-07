import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxStore } from '../src/inbox.js'

test('durable debounce resets quiet time and respects the ten-item cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-burst-'))
  let now = 0
  const inbox = new InboxStore(dir, () => now)
  try {
    await inbox.accept({ update_id: 1 })
    now = 1999
    assert.equal(await inbox.next(), undefined)
    await inbox.accept({ update_id: 2 })
    now = 3998
    assert.equal(await inbox.next(), undefined)
    now = 3999
    const first = (await inbox.next())!
    assert.deepEqual(
      first.entries.map((e) => e.update.update_id),
      [1, 2],
    )
    await inbox.finish(first.id)
    for (let id = 3; id <= 13; id++) await inbox.accept({ update_id: id })
    const full = (await inbox.next())!
    assert.equal(full.entries.length, 10)
    await inbox.finish(full.id)
    now += 2000
    assert.equal((await inbox.next())?.entries[0].update.update_id, 13)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restart-aged work flushes at max wait and an album is not split at the cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-album-'))
  let now = 0
  const inbox = new InboxStore(dir, () => now)
  try {
    await inbox.accept({ update_id: 1 })
    now = 29999
    await inbox.accept({ update_id: 2 })
    now = 30000
    const first = (await inbox.next())!
    assert.equal(first.entries.length, 2)
    await inbox.finish(first.id)
    for (let id = 3; id <= 13; id++)
      await inbox.accept({
        update_id: id,
        message: {
          message_id: id,
          from: { id: 101, is_bot: false, first_name: 'Fixture' },
          date: 0,
          chat: { id: 101, type: 'private', first_name: 'Fixture' },
          media_group_id: id >= 11 ? 'fixture_album' : undefined,
        },
      })
    assert.equal(await inbox.next(), undefined)
    now += 2000
    assert.equal((await inbox.next())?.entries.length, 11)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
