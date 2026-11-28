import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore, type RunRecord } from '../src/runs.js'
import { Scripts } from '../src/scripts.js'
import { requireOwnerExecution } from '../src/execution-authority.js'
import { startExecutorJob } from '../src/executor.js'

const until = async (check: () => Promise<boolean>, tries = 400) => { for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)) } throw new Error('Timed out') }
const exists = (file: string) => access(file).then(() => true, () => false)

// Records what it was given, then waits for a release file named by its argument; mode "ez" also calls the agent's launcher.
const fixture = `import { writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [mode, hold] = process.argv.slice(2)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('EZ_')))
writeFileSync('out-' + process.env.EZ_RUN_ID + '.json', JSON.stringify({ argv: process.argv.slice(2), env,
  leaked: ['TELEGRAM_BOT_TOKEN', 'EZ_TEST_SECRET'].filter(k => process.env[k] !== undefined) }))
if (mode === 'ez') {
  const r = spawnSync('ez', ['ezstocks', 'ping'], { encoding: 'utf8' })
  writeFileSync('ez-' + process.env.EZ_RUN_ID + '.json', JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }))
}
if (hold) while (!existsSync(hold)) await new Promise(r => setTimeout(r, 20))
if (mode === 'fail') process.exit(3)
`

const setup = async (t: test.TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'ez-script-runs-'))
  const dir = join(root, 'control'), workspace = join(root, 'workspace'), fakeBin = join(root, 'bin')
  await Promise.all([mkdir(dir), mkdir(join(workspace, 'scripts'), { recursive: true }), mkdir(fakeBin)])
  await writeFile(join(workspace, 'scripts', 'gate.mjs'), fixture)
  // Any native engine launch would leave this marker: direct script runs must not start one.
  for (const engine of ['codex', 'claude', 'grok']) {
    await writeFile(join(fakeBin, engine), `#!/bin/sh\necho "$0" >> ${JSON.stringify(join(root, 'llm-invocations'))}\n`)
    await chmod(join(fakeBin, engine), 0o755)
  }
  const control = new ControlStore(dir, 1000)
  await control.requestPairing(101, 101); await control.approveOwner(101)
  const owner = (await control.status()).owner!
  const saved = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, EZ_TEST_SECRET: process.env.EZ_TEST_SECRET, EZ_PLUGIN_BROKER_SOCKET: process.env.EZ_PLUGIN_BROKER_SOCKET }
  process.env.PATH = `${fakeBin}:${process.env.PATH}`; process.env.TELEGRAM_BOT_TOKEN = '123456:secret-token-value-for-tests-only'; process.env.EZ_TEST_SECRET = 'do-not-inherit'
  const launches: string[] = []
  const relay = createRelay({ workspace, controlDir: dir, pairingTtlMs: 1000, executorTimeoutMs: 0, executorCli: 'codex', telegramBotToken: 'fixture' },
    async (texts, options) => { assert.ok(options.script, 'only a script may launch'); launches.push(options.runId); return startExecutorJob(texts, options) })
  relay.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  const token = randomBytes(32).toString('base64url')
  await relay.applicationChannel.bindings.register('trade', token, owner)
  const { port } = await relay.applicationChannel.listen(0) as { port: number }
  t.after(async () => {
    await relay.stop(); await rm(root, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  const post = (body: unknown, bearer = token) => fetch(`http://127.0.0.1:${port}/v1/script-runs`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const runs = new RunStore(dir), scripts = new Scripts(dir)
  const out = async (run: string) => JSON.parse(await readFile(join(workspace, `out-${run}.json`), 'utf8'))
  const finished = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await runs.get(id))?.status ?? ''))
  return { root, dir, workspace, owner, relay, post, runs, scripts, launches, out, finished, port }
}

test('direct script runs: admission, duplicate key, concurrency limit, context env and no foreground queueing', async t => {
  const f = await setup(t)
  const hold = (name: string) => join(f.workspace, name)
  const reg = await f.scripts.save({ id: 'gate', owner: f.owner, workspace: f.workspace, entry: 'scripts/gate.mjs', interpreter: 'node', args: ['ok', hold('go')], timeoutSeconds: 60, maxConcurrent: 2 }, true)
  assert.equal(reg.maxConcurrent, 2)

  // Authority and shape.
  assert.equal((await f.post({ script: 'gate', key: 'k', context: {} }, randomBytes(32).toString('base64url'))).status, 401)
  assert.equal((await f.post({ script: 'nope', key: 'k', context: {} })).status, 404)
  for (const bad of ['{', '[]', { script: 'gate', key: 'has space', context: {} }, { script: 'gate', key: '', context: {} }, { script: 'gate', key: 'x'.repeat(129), context: {} },
    { script: 'Bad ID', key: 'k', context: {} }, { script: 'gate', context: {} }, { script: 'gate', key: 'k', context: [] }, { script: 'gate', key: 'k', context: 'text' },
    { script: 'gate', key: 'k', context: {}, workspace: '/etc' }])
    assert.equal((await f.post(bad)).status, 422, JSON.stringify(bad))
  assert.equal((await f.post({ script: 'gate', key: 'k', context: { pad: 'x'.repeat(4096) } })).status, 413)
  assert.equal((await f.post({ script: 'gate', key: 'k', context: { pad: 'x'.repeat(100_000) } })).status, 413)
  assert.equal((await f.runs.list()).length, 0)

  // A foreground turn is running: a direct run still starts and never counts as the foreground.
  const foreground = await f.runs.create({ chatId: 101, telegramUserId: 101, texts: ['chat'] }); await f.runs.patch(foreground.id, { status: 'running' })
  const context = { check: 'chk_1', note: 'opaque ✓ {"nested":[1,2]}' }
  const started = Date.now()
  const first = await f.post({ script: 'gate', key: 'chk_1', context })
  const accepted = await first.json() as { run: string; duplicate: boolean }
  assert.equal(first.status, 202); assert.equal(accepted.duplicate, false); assert.match(accepted.run, /^r_script_[a-f0-9]{32}$/)
  await until(async () => exists(join(f.workspace, `out-${accepted.run}.json`)))
  assert.ok(Date.now() - started < 5000)
  // The script is still waiting: the answer did not wait for it.
  const running = (await f.runs.get(accepted.run))!
  assert.equal(running.status, 'running'); assert.equal(running.execution, undefined); assert.equal(running.scheduled, undefined)
  assert.equal((await f.runs.running(false))?.id, foreground.id)
  await requireOwnerExecution(f.dir, accepted.run)
  const seen = await f.out(accepted.run)
  assert.equal(seen.env.EZ_SCRIPT_CONTEXT, JSON.stringify(context)); assert.equal(seen.env.EZ_RUN_ID, accepted.run); assert.equal(seen.env.EZ_SCRIPT_ID, 'gate')
  assert.equal(seen.env.EZ_SCRIPT_REVISION, reg.revision); assert.equal(seen.env.EZ_SCRIPT_SHA256, reg.sha256)
  assert.equal(seen.env.EZ_SCHEDULE_ID, undefined); assert.equal(seen.env.EZ_DUE_AT, undefined)
  assert.deepEqual(seen.argv, ['ok', hold('go')]); assert.deepEqual(seen.leaked, [])

  // Same key, same script: the first run, nothing new started.
  const again = await f.post({ script: 'gate', key: 'chk_1', context: { different: true } })
  assert.deepEqual(await again.json(), { run: accepted.run, duplicate: true }); assert.equal(again.status, 202)
  assert.equal(f.launches.length, 1)

  // The registration's limit of two: a second key runs, the third is refused, and a repeat of a held key still answers.
  const second = await (await f.post({ script: 'gate', key: 'chk_2', context: {} })).json() as { run: string }
  assert.notEqual(second.run, accepted.run)
  const refused = await f.post({ script: 'gate', key: 'chk_3', context: {} })
  assert.equal(refused.status, 429); assert.match(((await refused.json()) as { error: string }).error, /limit of 2/)
  assert.deepEqual(await (await f.post({ script: 'gate', key: 'chk_2', context: {} })).json(), { run: second.run, duplicate: true })
  assert.equal(f.launches.length, 2)
  assert.equal((await f.runs.list()).filter(r => r.script).length, 2)

  // Releasing the scripts completes both runs and frees their slots; a refused key was never reserved.
  await writeFile(hold('go'), '')
  await f.finished(accepted.run); await f.finished(second.run)
  const done = (await f.runs.get(accepted.run))!
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.ok(done.startedAt && done.endedAt)
  assert.equal((await f.post({ script: 'gate', key: 'chk_3', context: {} })).status, 202)
  // The window keeps a finished key answering with its run.
  assert.deepEqual(await (await f.post({ script: 'gate', key: 'chk_1', context: {} })).json(), { run: accepted.run, duplicate: true })
  await assert.rejects(access(join(f.root, 'llm-invocations')))
})

test('a failing script is a failed run, an unchanged registration check still applies, and an update keeps max-concurrent', async t => {
  const f = await setup(t)
  const base = { id: 'gate', owner: f.owner, workspace: f.workspace, entry: 'scripts/gate.mjs', interpreter: 'node', args: ['fail'], timeoutSeconds: 60 }
  assert.equal((await f.scripts.save(base, true)).maxConcurrent, undefined)
  const run = await (await f.post({ script: 'gate', key: 'a', context: {} })).json() as { run: string }
  await f.finished(run.run)
  const failed = (await f.runs.get(run.run))!
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 3); assert.equal(failed.failureReason, 'executor-exit')
  // Default limit is one; the next key runs once the first finished.
  assert.equal((await f.post({ script: 'gate', key: 'b', context: {} })).status, 202)
  await assert.rejects(f.scripts.save({ ...base, id: 'bad', maxConcurrent: 0 }, true), /max concurrent/)
  await assert.rejects(f.scripts.save({ ...base, id: 'bad', maxConcurrent: 65 }, true), /max concurrent/)

  // Changed entry-point bytes fail the run (same verification as a schedule occurrence); the caller already has its 202.
  await writeFile(join(f.workspace, 'scripts', 'gate.mjs'), fixture + '\n// edited\n')
  const tampered = await (await f.post({ script: 'gate', key: 'c', context: {} })).json() as { run: string }
  await f.finished(tampered.run)
  const refused = (await f.runs.get(tampered.run))!
  assert.equal(refused.status, 'failed'); assert.equal(refused.failureReason, 'executor-start'); assert.match(refused.failure!.error, /entry point changed since registration/)
})

// The run goes through the agent's own `ez` broker launcher; this broker records what it is asked.
const fakeBroker = async (t: test.TestContext) => {
  const requests: any[] = []
  const socket = join(await mkdtemp(join(tmpdir(), 'ezb-')), 's')
  const broker = createServer(connection => connection.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const request = JSON.parse(line); requests.push(request)
      connection.write(JSON.stringify(request.operation === 'resolve' ? { ok: true, revision: 'rev-1', capability: 'cap-1' } : { ok: true, stdout: 'pong\n', code: 0 }) + '\n')
    }
  }))
  broker.listen(socket); await once(broker, 'listening'); t.after(() => { broker.close() })
  process.env.EZ_PLUGIN_BROKER_SOCKET = socket
  return requests
}

test('a file-registered direct run reaches the agent ez launcher under its own run identity', async t => {
  const f = await setup(t)
  const requests = await fakeBroker(t)
  await f.scripts.save({ id: 'gate', owner: f.owner, workspace: f.workspace, entry: 'scripts/gate.mjs', interpreter: 'node', args: ['ez'], timeoutSeconds: 60 }, true)
  const run = await (await f.post({ script: 'gate', key: 'ez-1', context: { check: 'c' } })).json() as { run: string }
  await f.finished(run.run)
  assert.equal((await f.runs.get(run.run))?.status, 'completed')
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, `ez-${run.run}.json`), 'utf8')), { status: 0, stdout: 'pong\n', stderr: '' })
  assert.deepEqual(requests.map(r => [r.operation, r.runId, r.alias]), [['resolve', run.run, 'ezstocks'], ['invoke', run.run, 'ezstocks']])
  assert.doesNotMatch(JSON.stringify(requests), /secret-token|do-not-inherit/)
})

test('a plugin registration also runs directly through the launcher', async t => {
  const f = await setup(t)
  const requests = await fakeBroker(t)
  await f.scripts.save({ id: 'book', owner: f.owner, workspace: f.workspace, plugin: 'ezstocks', args: ['trade', 'check'], timeoutSeconds: 60, maxConcurrent: 4, pathValue: join(process.cwd(), 'bin') }, true)
  const run = await (await f.post({ script: 'book', key: 'p-1', context: { check: 'x' } })).json() as { run: string }
  await f.finished(run.run)
  assert.equal((await f.runs.get(run.run))?.status, 'completed')
  assert.deepEqual(requests.map(r => [r.operation, r.runId, r.alias]), [['resolve', run.run, 'ezstocks'], ['invoke', run.run, 'ezstocks']])
  assert.deepEqual(requests[1].args, ['trade', 'check'])
})
