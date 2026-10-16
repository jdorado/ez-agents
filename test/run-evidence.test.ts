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
import { RunStore, retentionBoundary } from '../src/runs.js'
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
    failure: { error: secret, relayVersion: '0.1.0-beta.47' },
    attempts:[{preset:{id:'test',name:'test',cli:'claude',model:'opus'},quotaScope:'claude',outcome:'failed',
      nativeTerminal:{status:'failed',subtype:'error_during_execution',isError:true,stopReason:null,privateText:secret} as any}] })
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
  assert.deepEqual(result.runs[0].nativeTerminals,[{attempt:1,status:'failed',subtype:'error_during_execution',isError:true,stopReason:null}])
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

test('evidence lists the setups a run tried in order with typed outcomes, clocks and opt-in telemetry, and nothing else', async t => {
  const { dir, runs } = await fixture(t)
  const secret = 'Private prose, token=abc123'
  const at = (second: number) => new Date(Date.UTC(2026, 9, 16, 4, 0, second)).toISOString()
  const claude = { id: 'claude', name: secret, cli: 'claude', model: 'opus', effort: 'high' }
  const second = { ...claude, id: 'fallback-0', authProfile: 'claude2' }
  const codex = { id: 'codex', name: 'codex', cli: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }
  const telemetry = { coverage: 'complete', model: 'gpt-6-sol', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, source: 'native-total', note: 'LEAKPROSE token=abc123' },
    tools: { calls: 1, completed: 1, errors: 0, durationMs: 40, note: 'LEAKPROSE', byName: { command: { calls: 1, completed: 1, errors: 0, durationMs: 40, note: 'LEAKPROSE' } } }, prompt: secret }
  await runs.patch('owner_run', { attempts: [
    { preset: claude, quotaScope: 'claude', outcome: 'failed', category: 'quota', resetAt: at(3600), exitCode: 1, startedAt: at(0), endedAt: at(1) },
    { preset: second, quotaScope: 'claude@claude2', outcome: 'skipped', category: 'same-quota-scope', startedAt: at(1), endedAt: at(1) },
    { preset: codex, quotaScope: 'codex', outcome: 'completed', exitCode: 0, startedAt: at(1), endedAt: at(9),
      nativeTerminal: { status: 'completed', subtype: 'success', isError: false, stopReason: 'end_turn' }, telemetry: telemetry as any },
    { preset: codex, quotaScope: secret, outcome: 'failed', category: secret as any, exitCode: 'private' as any, startedAt: secret, endedAt: at(9) },
  ] })
  const result = await runEvidence(dir)
  const attempts = result.runs[0].attempts
  assert.deepEqual(attempts.map(a => [a.attempt, a.setup.cli, a.setup.authProfile, a.setup.model, a.setup.effort, a.outcome, a.category, a.exitCode]), [
    [1, 'claude', undefined, 'opus', 'high', 'failed', 'quota', 1], [2, 'claude', 'claude2', 'opus', 'high', 'skipped', 'same-quota-scope', undefined],
    [3, 'codex', undefined, 'gpt-6-sol', 'xhigh', 'completed', undefined, 0], [4, 'codex', undefined, 'gpt-6-sol', 'xhigh', 'failed', undefined, undefined]])
  assert.deepEqual([attempts[0].resetAt, attempts[0].startedAt, attempts[2].endedAt], [at(3600), at(0), at(9)])
  assert.deepEqual(attempts[2].nativeTerminal, { status: 'completed', subtype: 'success', isError: false, stopReason: 'end_turn' })
  assert.equal(attempts[2].telemetry!.tokens!.output, 5)
  assert.equal(attempts[2].telemetry!.tools!.byName.command.durationMs, 40)
  assert.equal(attempts[3].quotaScope, undefined)
  assert.equal(attempts[3].startedAt, undefined)
  assert.ok(!/Private prose|abc123|LEAKPROSE/.test(JSON.stringify(result)), 'prose, names and unknown fields are dropped, nested ones too')
  // A long quota wait cannot make one page unbounded.
  // The latest are kept, so a recovery after many quota rounds is still listed, numbered by its place in the run.
  await runs.patch('owner_run', { attempts: Array.from({ length: 55 }, (_, i) => ({ preset: i === 54 ? codex : claude, quotaScope: i === 54 ? 'codex' : 'claude', outcome: i === 54 ? 'completed' as const : 'failed' as const, exitCode: i })) })
  const long = (await runEvidence(dir)).runs[0] as { attempts: { attempt: number; setup: { cli: string }; outcome: string; exitCode: number }[]; attemptsTruncated?: boolean; nativeTerminals: unknown[] }
  assert.equal(long.attempts.length, 50)
  assert.equal(long.attemptsTruncated, true)
  assert.deepEqual([long.attempts[0].attempt, long.attempts[0].exitCode, long.attempts.at(-1)!.attempt, long.attempts.at(-1)!.setup.cli, long.attempts.at(-1)!.outcome], [6, 5, 55, 'codex', 'completed'])
})

test('evidence states where retained history begins and counts what the caps dropped', async t => {
  const { dir, runs } = await fixture(t)
  const first = await runEvidence(dir)
  const retention = first.coverage.retention
  assert.ok(Number.isFinite(Date.parse(retention.ledgerStartedAt)) && Date.parse(retention.ledgerStartedAt) <= Date.parse(first.readStartedAt))
  assert.deepEqual([retention.prunedTerminalRuns, retention.prunedTerminalOutbox, retention.maxTerminalRuns, retention.maxTerminalOutbox, retention.retainedBeforeLedgerStart], [0, 0, 2000, 2000, 0])
  assert.equal(retention.oldestRetainedRunAt, first.runs[0].createdAt)
  // Past the cap the oldest terminal runs are dropped, and the read says how many.
  for (let i = 0; i < 2002; i++) {
    const id = `bulk_${i}`
    await runs.create({ id, chatId: 101, telegramUserId: 101, texts: ['t'] })
    await runs.patch(id, { status: 'completed' })
  }
  const after = await runEvidence(dir, { limit: 1 })
  assert.equal(after.coverage.retention.prunedTerminalRuns, 2)
  assert.equal(after.coverage.total, 2001)
  assert.equal(after.coverage.retention.oldestRetainedRunAt, after.runs[0].createdAt)
  assert.equal(after.coverage.retention.ledgerStartedAt, retention.ledgerStartedAt)
  // A single-run read still reports the whole ledger's boundary, not the filtered rows.
  const one = await runEvidence(dir, { runId: 'owner_run' })
  assert.equal(one.coverage.total, 1)
  assert.equal(one.coverage.retention.prunedTerminalRuns, 2)
})

test('evidence counts outbox items the cap dropped and owner runs retained from before the ledger started', async t => {
  const start = Date.parse(retentionBoundary('any').ledgerStartedAt)
  t.mock.timers.enable({ apis: ['Date'], now: start - 86_400_000 })
  const { dir, runs } = await fixture(t) // paired and first run created a day before this ledger began
  t.mock.timers.reset()
  const before = await runEvidence(dir)
  assert.equal(before.coverage.retention.retainedBeforeLedgerStart, 1)
  assert.equal(before.coverage.retention.prunedTerminalOutbox, 0)
  for (let i = 0; i < 2002; i++) {
    const item = await runs.enqueueMessage('owner_run', `m${i}`)
    await runs.claimOutbox(item.id); await runs.markOutboxSent(item.id, [i + 1])
  }
  const after = await runEvidence(dir, { limit: 1 })
  assert.deepEqual([after.coverage.retention.prunedTerminalOutbox, after.coverage.retention.prunedTerminalRuns, after.coverage.retention.retainedBeforeLedgerStart], [2, 0, 1])
  assert.equal(after.runs[0].deliveries.length, 2000)
})
