import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlStore } from '../src/control-state.js'
import { parseOwnerArgs } from '../src/owner-args.js'

const fixture = async (run: (store: ControlStore, advance: (milliseconds: number) => void, directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ez-control-test-'))
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  try {
    await run(new ControlStore(directory, 60_000, () => now), (milliseconds) => { now += milliseconds }, directory)
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
  const request = (await store.status()).pending[0]
  if (!request || !('telegramUserId' in request)) throw new Error('Telegram pairing request missing')
  assert.equal(request.telegramUserId, 101)
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

test('application-owned Telegram link is hashed, one-time, and bound to the current owner', async () => fixture(async (store, advance, directory) => {
  const owner = await store.registerOwner('account:one')
  const bindingId = '11111111-1111-1111-1111-111111111111'
  const pairing = await store.createApplicationTelegramPairing(bindingId, owner)
  assert.ok(pairing)
  assert.doesNotMatch(await readFile(path.join(directory, 'control-state.json'), 'utf8'), new RegExp(pairing.token))
  assert.equal(await store.claimApplicationTelegramPairing(`${pairing.token}x`, 101, 101, async () => true), null)
  assert.equal(await store.claimApplicationTelegramPairing(pairing.token, 101, 101, async () => false), null)
  assert.equal((await store.status()).owner?.telegramUserId, undefined)

  const replacement = await store.createApplicationTelegramPairing(bindingId, owner)
  assert.ok(replacement)
  advance(60_001)
  assert.equal(await store.claimApplicationTelegramPairing(replacement.token, 101, 101, async () => true), null)

  const active = await store.createApplicationTelegramPairing(bindingId, owner)
  assert.ok(active)
  const linked = await store.claimApplicationTelegramPairing(active.token, 101, 101, async (requestedBinding, expectedOwner) =>
    requestedBinding === bindingId && expectedOwner.id === owner.id)
  assert.equal(linked?.id, owner.id)
  assert.equal(linked?.telegramUserId, 101)
  assert.equal(linked?.telegramChatId, 101)
  assert.ok(linked?.telegramLinkedAt)
  assert.equal(await store.claimApplicationTelegramPairing(active.token, 101, 101, async () => true), null)
}))

test('owner CLI treats pnpm -- as a separator, not a command', () => {
  assert.deepEqual(parseOwnerArgs(['--', 'status']), { command: 'status', value: undefined })
  assert.deepEqual(parseOwnerArgs(['--', 'approve', '101']), { command: 'approve', value: '101' })
  assert.deepEqual(parseOwnerArgs(['revoke']), { command: 'revoke', value: undefined })
})
