import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlStore } from '../src/control-state.js'
import { parseOwnerArgs } from '../src/owner-args.js'

const fixture = async (run: (store: ControlStore, advance: (milliseconds: number) => void) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ez-control-test-'))
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  try {
    await run(new ControlStore(directory, 60_000, () => now), (milliseconds) => { now += milliseconds })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('does not pair the first sender automatically', async () => fixture(async (store) => {
  assert.equal(await store.requestPairing(101, 101), 'requested')
  const state = await store.status()
  assert.equal(state.owner, null)
  assert.equal(state.pending.length, 1)
}))

test('approves only an active explicit pairing request', async () => fixture(async (store) => {
  await store.requestPairing(101, 101)
  const owner = await store.approveOwner(101)
  assert.equal(owner.telegramUserId, 101)
  assert.equal(owner.telegramChatId, 101)
  await assert.rejects(store.approveOwner(202), /already paired/)
}))

test('cannot approve a telegram id that did not request pairing', async () => fixture(async (store) => {
  await store.requestPairing(101, 101)
  await assert.rejects(store.approveOwner(202), /No active pairing request/)
  assert.equal((await store.status()).owner, null)
  assert.equal((await store.status()).pending[0]?.telegramUserId, 101)
}))

test('expires pairing requests before an owner can approve them', async () => fixture(async (store, advance) => {
  await store.requestPairing(101, 101)
  advance(60_001)
  await assert.rejects(store.approveOwner(101), /No active pairing request/)
}))

test('supports local owner recovery by revocation', async () => fixture(async (store) => {
  await store.requestPairing(101, 101)
  await store.approveOwner(101)
  assert.equal(await store.revokeOwner(), true)
  assert.equal((await store.status()).owner, null)
}))

test('owner CLI treats pnpm -- as a separator, not a command', () => {
  assert.deepEqual(parseOwnerArgs(['--', 'status']), { command: 'status', value: undefined })
  assert.deepEqual(parseOwnerArgs(['--', 'approve', '101']), { command: 'approve', value: '101' })
  assert.deepEqual(parseOwnerArgs(['revoke']), { command: 'revoke', value: undefined })
})
