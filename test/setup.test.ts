import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findExecutableInPath, readActiveExecutor, setExecutorInEnv, getExecutorsStatus } from '../src/setup.js'

test('findExecutableInPath locates existing binary and returns null for nonexistent', async () => {
  const nodePath = await findExecutableInPath('node', process.env.PATH)
  assert.ok(nodePath && nodePath.includes('node'))

  const missing = await findExecutableInPath('nonexistent-binary-12345', process.env.PATH)
  assert.equal(missing, null)
})

test('readActiveExecutor extracts EZ_EXECUTOR_CLI or defaults to agy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ez-setup-test-'))
  try {
    const envPath = path.join(dir, '.env')
    assert.equal(await readActiveExecutor(envPath), 'agy')

    await writeFile(envPath, 'EZ_EXECUTOR_CLI=claude\n', 'utf8')
    assert.equal(await readActiveExecutor(envPath), 'claude')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('setExecutorInEnv updates or adds EZ_EXECUTOR_CLI without altering other env lines', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ez-setup-test-'))
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'TELEGRAM_BOT_TOKEN=token123\nEZ_AGENT_WORKSPACE=./agent\n', 'utf8')

    await setExecutorInEnv(envPath, 'claude')
    let content = await readFile(envPath, 'utf8')
    assert.match(content, /TELEGRAM_BOT_TOKEN=token123/)
    assert.match(content, /EZ_EXECUTOR_CLI=claude/)

    await setExecutorInEnv(envPath, 'antigravity')
    content = await readFile(envPath, 'utf8')
    assert.match(content, /TELEGRAM_BOT_TOKEN=token123/)
    assert.match(content, /EZ_EXECUTOR_CLI=antigravity/)
    assert.ok(!content.includes('claude'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getExecutorsStatus returns all executors and sets isActive correctly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ez-setup-test-'))
  try {
    const envPath = path.join(dir, '.env')
    await writeFile(envPath, 'EZ_EXECUTOR_CLI=claude\n', 'utf8')

    const status = await getExecutorsStatus(envPath)
    assert.equal(status.active, 'claude')
    const claudeItem = status.items.find((item) => item.id === 'claude')
    assert.ok(claudeItem)
    assert.equal(claudeItem.isActive, true)

    const agyItem = status.items.find((item) => item.id === 'agy')
    assert.ok(agyItem)
    assert.equal(agyItem.isActive, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
