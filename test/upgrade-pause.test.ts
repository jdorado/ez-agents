import assert from 'node:assert/strict'
import test from 'node:test'
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore } from '../src/runs.js'
import { initialPreset } from '../src/ai.js'
import { opencodeDataHome, piAgentDir } from '../src/executor.js'
// @ts-expect-error The supervisor is a standalone Node module.
import { idle } from '../src/updates/supervisor.mjs'
import { initializeWorkspace } from '../src/workspace.js'

test('reload idle status waits for an admission already past the pause check', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-upgrade-barrier-'))
  const purpose = join(dir, 'purpose.md')
  await writeFile(purpose, 'Fixture agent\n')
  await initializeWorkspace(dir, purpose)
  const control = new ControlStore(dir, 1000), runs = new RunStore(dir)
  await control.requestPairing(101, 101)
  await control.approveOwner(101)
  let launched = 0
  const relay = createRelay({ controlDir: dir, workspace: dir, pairingTtlMs: 1000,
    executorTimeoutMs: 0, executorCli: 'grok', telegramBotToken: 'fixture' }, async () => {
    launched++
    return { child: spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' }), cleanup: async () => {}, stdout: '' }
  })
  relay.bot.botInfo = { id: 999, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } as typeof relay.bot.botInfo
  let polling!: () => void
  const ready = new Promise<void>(resolve => { polling = resolve })
  relay.bot.api.config.use(async (_prev, method, _payload, signal) => {
    if (method === 'getUpdates') {
      polling()
      if (signal && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { ok: true, result: [] } as never
    }
    return { ok: true, result: { message_id: 42 } } as never
  })
  const started = relay.start()
  const originalStatus = ControlStore.prototype.status
  let release!: () => void, blocked!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entering = new Promise<void>(resolve => { blocked = resolve })
  try {
    await ready
    const run = await runs.create({ chatId: 101, telegramUserId: 101, texts: ['fixture'],
      execution: await control.captureChoice({ ...initialPreset('grok'), model: 'fixture-model' }) })
    let reads = 0
    ControlStore.prototype.status = async function () {
      if (++reads === 2) { blocked(); await gate }
      return originalStatus.call(this)
    }
    const admission = relay.drainSources()
    await entering
    await writeFile(join(dir, 'upgrade-pause.json'), '{}', { mode: 0o600 })
    let settled = false
    const snapshot = idle(dir, { pendingRequests: false, relayRequired: true }).then((value: boolean) => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(settled, false, 'status must wait behind the held admission')
    release()
    await admission
    assert.equal(await snapshot, false)
    assert.equal(launched, 1)
    assert.equal((await runs.get(run.id))?.status, 'running')
  } finally {
    release()
    ControlStore.prototype.status = originalStatus
    await relay.stop()
    await started
    await rm(dir, { recursive: true, force: true })
  }
})

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
      for (const engine of ['opencode', 'pi/agent']) {
        const directory = join(dir, 'cli', engine)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(join(directory, 'auth.json'), '{}', { mode: 0o600 })
      }
      assert.equal(opencodeDataHome(dir), join(dir, 'cli'))
      assert.equal(piAgentDir(dir), join(dir, 'cli', 'pi', 'agent'))
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
    '--bounding-set=-all', process.execPath, '--import', 'tsx',
    '--test', fileURLToPath(import.meta.url),
  ], { encoding: 'utf8', timeout: 15000, env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ok \d+ - private control directory/)
})
