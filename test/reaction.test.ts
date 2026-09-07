import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { isSupportedReactionEmoji, normalizeReactionEmoji, TELEGRAM_REACTIONS } from '../src/reaction.js'
import { RunStore } from '../src/runs.js'

const execFileAsync = promisify(execFile)
const reactScriptPath = path.resolve('src/react.ts')

const fixture = async (run: (store: RunStore, dir: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ez-reactions-'))
  try {
    await run(new RunStore(directory), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('normalizes standard Telegram reaction emojis', () => {
  assert.equal(normalizeReactionEmoji('👍'), '👍')
  assert.equal(normalizeReactionEmoji('🔥'), '🔥')
  assert.equal(normalizeReactionEmoji('👀'), '👀')
  assert.equal(normalizeReactionEmoji('🫡'), '🫡')
  assert.equal(normalizeReactionEmoji('❤'), '❤')
  assert.equal(isSupportedReactionEmoji('👍'), true)
  assert.equal(isSupportedReactionEmoji('👀'), true)
})

test('normalizes emojis with variation selector FE0F', () => {
  // Red heart with FE0F should normalize to standard ❤
  assert.equal(normalizeReactionEmoji('❤️'), '❤')
  // Lightning bolt with FE0F should normalize to ⚡
  assert.equal(normalizeReactionEmoji('⚡️'), '⚡')
  // Dove with FE0F should normalize to 🕊
  assert.equal(normalizeReactionEmoji('🕊️'), '🕊')
  // Shrugging man/woman with FE0F
  assert.equal(normalizeReactionEmoji('🤷‍♂️'), '🤷‍♂')
  assert.equal(normalizeReactionEmoji('🤷‍♀️'), '🤷‍♀')
  // Heart on fire
  assert.equal(normalizeReactionEmoji('❤\uFE0F\u200D\u{1F525}'), '❤‍🔥')
})

test('rejects invalid or unsupported reaction emojis', () => {
  assert.equal(normalizeReactionEmoji('✅'), undefined)
  assert.equal(normalizeReactionEmoji('⏳'), undefined)
  assert.equal(normalizeReactionEmoji('❌'), undefined)
  assert.equal(normalizeReactionEmoji('🚀'), undefined)
  assert.equal(normalizeReactionEmoji(''), undefined)
  assert.equal(normalizeReactionEmoji('  '), undefined)
  assert.equal(normalizeReactionEmoji(undefined), undefined)
  assert.equal(normalizeReactionEmoji(null), undefined)
  assert.equal(isSupportedReactionEmoji('✅'), false)
  assert.equal(isSupportedReactionEmoji('⏳'), false)
})

test('RunStore enqueues valid reaction and normalizes emoji', async () => fixture(async (store) => {
  const run = await store.create({ chatId: 123, telegramUserId: 123, texts: ['hi'], messageId: 456 })
  await store.patch(run.id, { status: 'running' })

  const item = await store.enqueueReaction(run.id, '❤️')
  assert.equal(item.type, 'reaction')
  assert.equal(item.emoji, '❤') // Normalized without FE0F
  assert.equal(item.messageId, 456)
  assert.equal(item.chatId, 123)

  const pending = await store.pendingOutbox()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].emoji, '❤')
}))

test('RunStore rejects invalid reaction emoji with error', async () => fixture(async (store) => {
  const run = await store.create({ chatId: 123, telegramUserId: 123, texts: ['hi'], messageId: 456 })
  await store.patch(run.id, { status: 'running' })

  await assert.rejects(
    store.enqueueReaction(run.id, '✅'),
    /Invalid Telegram reaction emoji "✅"/,
  )
  await assert.rejects(
    store.enqueueReaction(run.id, '⏳'),
    /Invalid Telegram reaction emoji "⏳"/,
  )
}))

test('ezenciel-agents-react CLI enforces EZ_RUN_ID and valid emoji', async () => fixture(async (store, dir) => {
  // Missing EZ_RUN_ID
  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsx', reactScriptPath, '--emoji', '👍'], {
      env: { ...process.env, EZ_RUN_ID: '', EZ_CONTROL_DIR: dir },
    }),
    (err: any) => {
      assert.match(err.stderr, /EZ_RUN_ID is required/)
      return true
    },
  )

  // Invalid emoji
  const run = await store.create({ chatId: 123, telegramUserId: 123, texts: ['hi'], messageId: 456 })
  await store.patch(run.id, { status: 'running' })

  await assert.rejects(
    execFileAsync('pnpm', ['exec', 'tsx', reactScriptPath, '--emoji', '✅'], {
      env: { ...process.env, EZ_RUN_ID: run.id, EZ_CONTROL_DIR: dir },
    }),
    (err: any) => {
      assert.match(err.stderr, /Invalid Telegram reaction emoji "✅"/)
      return true
    },
  )

  // Valid emoji succeeds
  const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', reactScriptPath, '--emoji', '👍'], {
    env: { ...process.env, EZ_RUN_ID: run.id, EZ_CONTROL_DIR: dir },
  })
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.emoji, '👍')
}))
