import assert from 'node:assert/strict'
import test from 'node:test'
import { queueSessionClose } from '../src/session-close.js'
import type { RunStore } from '../src/runs.js'
import type { Owner, SessionState } from '../src/control-state.js'

test('a private application scope never gets an owner-authority close turn', async () => {
  const created: unknown[] = []
  const runs = { create: async (input: unknown) => { created.push(input); return input } } as unknown as RunStore
  const owner = { id: 'owner', telegramUserId: 42, pairedAt: new Date(0).toISOString() } as Owner
  const session: SessionState = { sessionId: 'scoped', hasStarted: true, preset: { id: 'p', cli: 'codex', model: 'm' } as SessionState['preset'], applicationScope: 'a'.repeat(64) }
  assert.equal(await queueSessionClose(runs, owner, session), undefined)
  assert.equal(created.length, 0)
  const { applicationScope: _, ...ownerSession } = session
  assert.ok(await queueSessionClose(runs, owner, ownerSession))
  assert.equal(created.length, 1)
})
