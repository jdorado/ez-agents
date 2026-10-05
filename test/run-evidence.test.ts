import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ownerRun } from './helpers/owner-run.js'
import { serveTestLedger } from './helpers/ledger.js'
import { RunStore } from '../src/runs.js'
import { ControlStore } from '../src/control-state.js'
import { runEvidence, projectRunEvidence } from '../src/run-evidence.js'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ez-evidence-'))
  await ownerRun(dir, 'owner_run')
  const ledger = await serveTestLedger(dir)
  t.after(async () => { await ledger.stop(); await rm(dir, { recursive: true, force: true }) })
  return { dir, runs: new RunStore(dir), owner: (await new ControlStore(dir, 1000).status()).owner! }
}

test('CLI projects operational proof without sessions, failure prose or delivered text', async t => {
  const { dir, runs } = await fixture(t)
  const secret = 'private-session-or-token'
  await runs.patch('owner_run', { nativeSessionId: secret, failureReason: secret,
    failure: { error: secret, relayVersion: '0.1.0-beta.47' } })
  const sent = await runs.enqueueMessage('owner_run', 'private financial report')
  await runs.claimOutbox(sent.id); await runs.markOutboxSent(sent.id, [7])
  const uncertain = await runs.enqueueMessage('owner_run', 'uncertain report')
  await runs.claimOutbox(uncertain.id); await runs.failOutbox(uncertain.id, secret, true)
  const control = await new ControlStore(dir, 1000).status()
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/ezenciel-agents-schedule.mjs', 'evidence'], {
    env: { ...process.env, EZ_CONTROL_DIR: dir, EZ_RUN_ID: 'owner_run' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.runs.length, 1)
  assert.ok(!stdout.includes(secret) && !stdout.includes('private financial report') && !stdout.includes('uncertain report'))
  const receipts = result.runs[0].deliveries
  assert.equal(receipts.find((r: any) => r.id === sent.id).receiptVerified, true)
  assert.equal(receipts.find((r: any) => r.id === sent.id).content.sha256, createHash('sha256').update('private financial report').digest('hex'))
  assert.equal(receipts.find((r: any) => r.id === uncertain.id).state, 'unknown')
  assert.equal(receipts.find((r: any) => r.id === uncertain.id).receiptVerified, false)
  assert.equal(result.runs[0].toolDelegationMetadata.state, 'unavailable')
  assert.deepEqual(await new ControlStore(dir, 1000).status(), control)
})

test('pages require an unchanged snapshot and exact identity', async t => {
  const { dir, runs } = await fixture(t)
  await ownerRun(dir, 'second_run')
  const first = await runEvidence(dir, { limit: 1 })
  assert.equal(first.coverage.total, 2)
  assert.equal(first.coverage.nextOffset, 1)
  const second = await runEvidence(dir, { limit: 1, offset: 1, expected: first.snapshotSha256 })
  assert.equal(second.coverage.nextOffset, null)
  assert.notEqual(second.runs[0].id, first.runs[0].id)
  await assert.rejects(runEvidence(dir, { offset: 1 }), /requires/)
  await runs.patch('second_run', { status: 'completed' })
  await assert.rejects(runEvidence(dir, { offset: 1, expected: first.snapshotSha256 }), /changed/)
  await assert.rejects(runEvidence(dir, { runId: '../owner_run' }), /identifier/)
  for (const options of [{ limit: 101 }, { offset: -1 }, { offset: 0.5 }, { expected: 'bad' }])
    await assert.rejects(runEvidence(dir, options))
})

test('revoked owners, restricted callers and unrelated bindings are excluded', async t => {
  const { dir, runs, owner } = await fixture(t)
  const stranger = await runs.create({ id: 'other_owner', chatId: 202, telegramUserId: 202, texts: ['secret'] })
  const external = await ownerRun(dir, 'external', { sourceId: 'test', bindingId: 'binding', eventIds: ['1'] })
  const old = { ...(await runs.get('owner_run'))!, id: 'old_run', scheduled: { id: 'schedule', revision: 'rev', dueAt: '2026-01-01T00:00:00Z', pairedAt: 'old-pairing' } }
  const app = { ...(await runs.get('owner_run'))!, id: 'app_run', delivery: { bindingId: 'private', scope: 'private' } }
  assert.deepEqual(projectRunEvidence([stranger, external, old, app], [], owner), [])
  await assert.rejects(runEvidence(dir, { callerRunId: 'external' }), /blocked/)
  await runs.patch('owner_run', { replyOnly: true })
  await assert.rejects(runEvidence(dir, { callerRunId: 'owner_run' }), /Telegram owner/)
  await assert.rejects(runEvidence(dir, { runId: 'other_owner' }), /Unknown/)
  await new ControlStore(dir, 1000).revokeOwner()
  await assert.rejects(runEvidence(dir), /No authorized owner/)
})
