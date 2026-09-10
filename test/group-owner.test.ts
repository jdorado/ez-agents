import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStore } from '../src/control-state.js'
import { isOwner, ownsRun } from '../src/identity.js'
import { executionBlockReason } from '../src/execution-authority.js'
import { RunStore } from '../src/runs.js'

test('group pairing requires explicit group approval and grants only the exact group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-group-owner-'))
  try {
    const store = new ControlStore(dir, 900000)
    await store.requestPairing(101, -123, 'Test group')
    assert.equal((await store.status()).owner, null)
    await assert.rejects(store.approveOwner(101), /No active/)
    await assert.rejects(store.approveOwner(-124, true), /No active/)
    const owner = await store.approveOwner(-123, true)
    assert.equal(owner.kind, 'group')
    const ctx = (id: number, chat = -123, bot = false) => ({from: {id, is_bot: bot, first_name: 'Member'}, chat: {id: chat, type: 'supergroup' as const, title: 'Test'}})
    assert.equal(isOwner(ctx(101), owner), true)
    assert.equal(isOwner(ctx(202), owner), true)
    assert.equal(isOwner(ctx(202, -124), owner), false)
    assert.equal(isOwner(ctx(202, -123, true), owner), false)
    assert.equal(isOwner({...ctx(101), chat: {id: 101, type: 'private', first_name: 'User'}}, owner), false)
    const run = await new RunStore(dir).create({id: 'tg_1', chatId: -123, telegramUserId: 202, texts: ['Hi']})
    assert.equal(executionBlockReason(run, owner), undefined)
    assert.equal(executionBlockReason({...run, chatId: -124}, owner), 'owner-mismatch')
    assert.equal(ownsRun(owner, {...run, telegramUserId: 0}), false)
    const restored = (await new ControlStore(dir, 900000).status()).owner
    assert.deepEqual(restored, owner)
    await store.revokeOwner()
    assert.equal(ownsRun((await store.status()).owner, run), false)
  } finally { await rm(dir, {recursive: true, force: true}) }
})
