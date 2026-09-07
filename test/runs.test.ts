import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseMessageArgs, sendRunText } from '../src/message-send.js'
import { RunStore } from '../src/runs.js'

const fixture = async (run: (store: RunStore) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ez-runs-'))
  try {
    await run(new RunStore(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('creates a queued run and binds chat id outside the workspace', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 101, telegramUserId: 101, texts: ['hello'] })
  assert.match(created.id, /^r_/)
  assert.equal(created.status, 'queued')
  assert.equal((await store.get(created.id))?.chatId, 101)
}))

test('ez message writes an outbox item for the bound run, not a telegram send', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 9, telegramUserId: 9, texts: ['hello'] })
  await store.patch(created.id, { status: 'running' })
  const item = await sendRunText(store, created.id, '  started 1/100\n')
  assert.equal(item.chatId, 9)
  assert.equal(item.text, 'started 1/100')
  const pending = await store.pendingOutbox()
  assert.equal(pending.length, 1)
  await store.markOutboxSent(item.id)
  assert.equal((await store.pendingOutbox()).length, 0)
}))

test('ez message rejects an empty file and a finished run', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 1, telegramUserId: 1, texts: ['x'] })
  await store.patch(created.id, { status: 'completed' })
  await assert.rejects(sendRunText(store, created.id, 'hi'), /cannot send/)
  await assert.rejects(sendRunText(store, created.id, '  \n'), /empty/)
}))

test('message CLI treats --text-file as the payload path', () => {
  assert.deepEqual(parseMessageArgs(['--', '--text-file', './note.md']), { textFile: './note.md' })
  assert.deepEqual(parseMessageArgs([]), { textFile: undefined })
})

test('message CLI parses --document, --voice, and --reply-to flags', () => {
  const parsed = parseMessageArgs([
    '--text-file', './note.md',
    '--document', './invoice.pdf',
    '--reply-to', '42',
    '--voice', 'spoken note',
  ])
  assert.equal(parsed.textFile, './note.md')
  assert.equal(parsed.document, './invoice.pdf')
  assert.equal(parsed.replyTo, 42)
  assert.equal(parsed.voice, 'spoken note')
})

test('RunStore enqueues document, voice, and approval items properly', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 1, telegramUserId: 1, texts: ['test'] })
  await store.patch(created.id, { status: 'running' })

  const docItem = await store.enqueueDocument(created.id, './report.pdf', { caption: 'Here is your report', replyToMessageId: 42 })
  assert.equal(docItem.type, 'document')
  assert.equal(docItem.documentPath, './report.pdf')
  assert.equal(docItem.text, 'Here is your report')
  assert.equal(docItem.replyToMessageId, 42)

  const voiceItem = await store.enqueueVoice(created.id, 'Hello in audio', { replyToMessageId: 42 })
  assert.equal(voiceItem.type, 'voice')
  assert.equal(voiceItem.voiceText, 'Hello in audio')

  const appItem = await store.enqueueApproval(created.id, 'Approve transaction?', 'tx_123', { replyToMessageId: 42 })
  assert.equal(appItem.type, 'approval')
  assert.equal(appItem.approvalPrompt, 'Approve transaction?')
  assert.equal(appItem.approvalActionId, 'tx_123')

  const pending = await store.pendingOutbox()
  assert.equal(pending.length, 3)
}))

test('claimOutbox prevents concurrent double-processing of the same item', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 1, telegramUserId: 1, texts: ['test'] })
  await store.patch(created.id, { status: 'running' })
  const item = await store.enqueueMessage(created.id, 'one copy only')

  // First claim succeeds
  const firstClaim = await store.claimOutbox(item.id)
  assert.equal(firstClaim, true)

  // Item is no longer visible in pendingOutbox while claimed (.sending.json)
  assert.equal((await store.pendingOutbox()).length, 0)

  // Concurrent second claim must fail
  const secondClaim = await store.claimOutbox(item.id)
  assert.equal(secondClaim, false)

  // Mark sent renames to .sent.json
  await store.markOutboxSent(item.id)
  assert.equal((await store.pendingOutbox()).length, 0)
}))

test('unclaimOutbox restores item for retry on transient failure', async () => fixture(async (store) => {
  const created = await store.create({ chatId: 1, telegramUserId: 1, texts: ['test'] })
  await store.patch(created.id, { status: 'running' })
  const item = await store.enqueueMessage(created.id, 'retry item')

  assert.equal(await store.claimOutbox(item.id), true)
  assert.equal((await store.pendingOutbox()).length, 0)

  await store.unclaimOutbox(item.id)
  assert.equal((await store.pendingOutbox()).length, 1)
}))
