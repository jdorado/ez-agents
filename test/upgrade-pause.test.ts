import assert from 'node:assert/strict'
import test from 'node:test'
import { access, chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'

test('private control directory preserves pause, fails closed on errors, and resumes queued work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-upgrade-pause-'))
  await chmod(dir, 0o700)
  const pause = join(dir, 'upgrade-pause.json')
  let launched = 0
  const relay = createRelay({
    controlDir: dir, workspace: dir, pairingTtlMs: 1000,
    executorTimeoutMs: 1000, executorCli: 'grok', telegramBotToken: 'fixture',
  }, async () => { launched++; throw new Error('Fixture executor reached') })
  relay.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  try {
    if (process.env.EZ_TEST_SPLIT_UID === '1') {
      assert.equal(process.getuid!(), 1001)
      assert.equal(process.geteuid!(), 1000)
      // Prove the old access check fails even though the marker is absent.
      await assert.rejects(access(pause), { code: 'EACCES' })
      await assert.rejects(stat(pause), { code: 'ENOENT' })
    }
    const control = new ControlStore(dir, 1000)
    await control.requestPairing(101, 101)
    await control.approveOwner(101)
    const runs = new RunStore(dir)
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['queued'],
      execution: await control.captureChoice(initialPreset('grok')) })
    await writeFile(pause, '{}', { mode: 0o600 })
    await relay.drainSources()
    assert.equal(launched, 0)
    assert.equal((await runs.get(run.id))?.status, 'queued')
    await rm(pause)
    await symlink(pause, pause)
    await assert.rejects(relay.drainSources(), { code: 'ELOOP' })
    assert.equal(launched, 0)
    assert.equal((await runs.get(run.id))?.status, 'queued')
    await rm(pause)
    await relay.drainSources()
    assert.equal(launched, 1)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
  } finally {
    await relay.stop()
    // Allow the failed fixture launch's next-queue callback to settle.
    await new Promise(resolve => setTimeout(resolve, 25))
    await rm(dir, { recursive: true, force: true })
  }
})

test('Linux relay real/effective UID regression (Docker test target)', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0,
}, () => {
  const env: NodeJS.ProcessEnv = { ...process.env, EZ_TEST_SPLIT_UID: '1' }
  delete env.NODE_TEST_CONTEXT // Run an independent test runner, not the parent's IPC protocol.
  const result = spawnSync('setpriv', [
    '--ruid=1001', '--euid=1000', '--regid=1000', '--clear-groups',
    '--bounding-set=-all', '--no-new-privs', process.execPath, '--import', 'tsx',
    '--test', fileURLToPath(import.meta.url),
  ], { encoding: 'utf8', timeout: 15000, env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok 1 - private control directory/)
})
