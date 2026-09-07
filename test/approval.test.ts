import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalStore } from '../src/approval.js'

const fixture = async (run: (store: ApprovalStore) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ez-approval-test-'))
  try {
    await run(new ApprovalStore(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('creates pending approval request', async () => fixture(async (store) => {
  const req = await store.requestApproval('action_1', 'Approve $50 cloud expense?', 'run_1')
  assert.equal(req.actionId, 'action_1')
  assert.equal(req.decision, 'pending')
  assert.equal(req.prompt, 'Approve $50 cloud expense?')

  const fetched = await store.getDecision('action_1')
  assert.equal(fetched?.decision, 'pending')
}))

test('records decision when owner approves or denies', async () => fixture(async (store) => {
  await store.requestApproval('action_2', 'Send email blast?')
  const approved = await store.recordDecision('action_2', 'approved', 101)
  assert.equal(approved.decision, 'approved')
  assert.equal(approved.decidedBy, 101)

  const check = await store.getDecision('action_2')
  assert.equal(check?.decision, 'approved')
}))

test('returns null for nonexistent actionId', async () => fixture(async (store) => {
  const check = await store.getDecision('nonexistent')
  assert.equal(check, null)
}))
