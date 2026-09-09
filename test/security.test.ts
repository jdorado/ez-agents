import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOwner, isOwnerGroupCheckIn } from '../src/identity.js'
import { RunStore } from '../src/runs.js'
import { ApprovalStore } from '../src/approval.js'
import { ControlStore } from '../src/control-state.js'
import { stageIncomingFile, workspaceFile, detectFileType } from '../src/files.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'

test('direct owner gate rejects groups while group check-ins accept only the paired owner', () => {
  const owner = { telegramUserId: 101, telegramChatId: 101, pairedAt: '' }
  const from = { id: 101, is_bot: false, first_name: 'Test' }
  const chat = { id: 101, type: 'private' as const, first_name: 'Test' }
  assert.ok(isOwner({ from, chat }, owner))
  const group = { id: -101, type: 'group' as const, title: 'Test' }
  assert.equal(isOwner({ from, chat: group }, owner), false)
  assert.ok(isOwnerGroupCheckIn({ from, chat: group }, owner))
  for (const input of [
    { from: undefined, chat },
    { from: { ...from, id: 202 }, chat },
    { from: { ...from, is_bot: true }, chat },
    { from, chat: { ...chat, id: 202 } },
    { from: { ...from, id: 202 }, chat: group },
    { from: { ...from, is_bot: true }, chat: group },
  ])
    assert.equal(isOwner(input, owner), false)
  assert.equal(isOwnerGroupCheckIn({ from: { ...from, id: 202 }, chat: group }, owner), false)
  assert.equal(isOwnerGroupCheckIn({ from, chat: { id: -101, type: 'channel' as const, title: 'Test' } }, owner), false)
  assert.equal(isOwner({ from, chat }, null), false)
})

test('store identifiers reject traversal; corrupt records cannot authorize or block healthy runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-negative-'))
  try {
    const runs = new RunStore(dir)
    await assert.rejects(runs.get('../control-state'), /Invalid/)
    await assert.rejects(runs.claimOutbox('../control-state'), /Invalid/)
    await assert.rejects(new ApprovalStore(dir).getDecision('../escape'), /Invalid/)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['test'] })
    await writeFile(join(dir, 'runs', 'broken.json'), '{')
    assert.equal((await runs.nextQueued())?.id, run.id)
    await writeFile(join(dir, 'control-state.json'), '{')
    await assert.rejects(new ControlStore(dir, 1000).status())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('approval decisions cannot be invented, replayed or reused for another action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-approval-negative-'))
  try {
    const approvals = new ApprovalStore(dir)
    await assert.rejects(approvals.recordDecision('missing', 'approved', 101), /Unknown/)
    await approvals.requestApproval('sample', 'A harmless test?', 'run_a')
    await assert.rejects(approvals.requestApproval('sample', 'Different?', 'run_b'), /another request/)
    await approvals.recordDecision('sample', 'denied', 101)
    await assert.rejects(approvals.recordDecision('sample', 'approved', 101), /already decided/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('files reject malformed UTF-8 and symlinks outside the workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-path-negative-'))
  try {
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    await writeFile(join(dir, 'private.txt'), 'private')
    await symlink(join(dir, 'private.txt'), join(workspace, 'escape.txt'))
    await assert.rejects(workspaceFile(workspace, 'escape.txt'), /outside/)
    assert.equal(detectFileType(Buffer.from([0xff, 0xfe, 0x41])), 'unknown')
    await assert.rejects(stageIncomingFile(workspace, 'bad.txt', Buffer.from([0xff, 0xfe])), /Unsupported/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Grok uses an exact session for continuation and a distinct fresh session for new', () => {
  const build = EXECUTOR_REGISTRY.grok.buildArgs
  assert.deepEqual(
    build({ workspace: '/tmp', sessionId: 'test', isResume: true }, '/tmp/p', '').slice(0, 2),
    ['--resume', 'test'],
  )
  assert.deepEqual(
    build({ workspace: '/tmp', sessionId: 'new', isResume: false }, '/tmp/p', '').slice(0, 2),
    ['--session-id', 'new'],
  )
})
