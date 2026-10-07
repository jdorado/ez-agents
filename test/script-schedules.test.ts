import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRelay } from '../src/index.js'
import { ControlStore } from '../src/control-state.js'
import { RunStore, type RunRecord } from '../src/runs.js'
import { Scheduler } from '../src/scheduler.js'
import { Scripts } from '../src/scripts.js'
import { initialPreset } from '../src/ai.js'
import { startExecutorJob, type ExecutorOptions } from '../src/executor.js'
import { serveTestLedger } from './helpers/ledger.js'

const exec = promisify(execFile), bin = fileURLToPath(new URL('../bin/ezenciel-agents-schedule.mjs', import.meta.url))
const until = async (check: () => Promise<boolean>, tries = 400) => { for (let i = 0; i < tries; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)) } throw new Error('Timed out') }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// The script records only what it was given; it never prints secrets.
const fixture = `import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const mode = process.argv[2]
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('EZ_')))
writeFileSync('out-' + process.env.EZ_RUN_ID + '.json', JSON.stringify({ argv: process.argv.slice(2), env,
  leaked: ['TELEGRAM_BOT_TOKEN', 'EZ_TEST_SECRET', 'OPENAI_API_KEY'].filter(k => process.env[k] !== undefined) }))
console.log('routine check ok token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP')
console.error('diagnostic line')
if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync('child-' + process.env.EZ_RUN_ID + '.pid', String(child.pid))
  setInterval(() => {}, 1000)
}
if (mode === 'fail') process.exit(3)
`

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ez-script-schedules-'))
  const dir = join(root, 'control'), workspace = join(root, 'workspace'), fakeBin = join(root, 'bin')
  await Promise.all([mkdir(dir), mkdir(join(workspace, 'scripts'), { recursive: true }), mkdir(fakeBin)])
  await writeFile(join(workspace, 'scripts', 'guard.mjs'), fixture)
  // Any native engine launch would leave this marker: script runs must not start one.
  for (const engine of ['codex', 'claude', 'grok']) {
    await writeFile(join(fakeBin, engine), `#!/bin/sh\necho "$0" >> ${JSON.stringify(join(root, 'llm-invocations'))}\n`)
    await chmod(join(fakeBin, engine), 0o755)
  }
  const control = new ControlStore(dir, 1000)
  await control.requestPairing(101, 101); await control.approveOwner(101)
  const owner = (await control.status()).owner!
  return { root, dir, workspace, fakeBin, control, owner, runs: new RunStore(dir), scheduler: new Scheduler(dir), scripts: new Scripts(dir) }
}

test('script registration confines the entry point, rejects shell strings and records the entry hash', async t => {
  const f = await setup(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const base = { id: 'guard', owner: f.owner, workspace: f.workspace, interpreter: 'node', args: [], timeoutSeconds: 60 }
  const saved = await f.scripts.save({ ...base, entry: 'scripts/guard.mjs' }, true)
  assert.equal(saved.entry, join('scripts', 'guard.mjs')); assert.match(saved.sha256, /^[a-f0-9]{64}$/)
  await assert.rejects(f.scripts.save({ ...base, entry: 'scripts/guard.mjs' }, true), /already registered/)
  await writeFile(join(f.root, 'outside.mjs'), 'process.exit(0)')
  await assert.rejects(f.scripts.save({ ...base, id: 'escape', entry: '../outside.mjs' }, true), /inside the agent workspace/)
  await symlink(join(f.root, 'outside.mjs'), join(f.workspace, 'link.mjs'))
  await assert.rejects(f.scripts.save({ ...base, id: 'escape', entry: 'link.mjs' }, true), /inside the agent workspace/)
  await assert.rejects(f.scripts.save({ ...base, id: 'shell', entry: 'scripts/guard.mjs', interpreter: 'node -e "x"' }, true), /not a shell command/)
  await assert.rejects(f.scripts.save({ ...base, id: 'shell', entry: 'scripts/guard.mjs', interpreter: 'sh;rm' }, true), /not a shell command/)
  await assert.rejects(f.scripts.save({ ...base, id: 'missing', entry: 'scripts/guard.mjs', interpreter: 'no-such-interpreter-ez' }, true), /not installed/)
  await assert.rejects(f.scripts.save({ ...base, id: 'Bad ID', entry: 'scripts/guard.mjs' }, true), /Script ID/)
  // An interpreter inside the workspace would be unhashed code.
  await writeFile(join(f.workspace, 'run.sh'), '#!/bin/sh\n'); await chmod(join(f.workspace, 'run.sh'), 0o755)
  await assert.rejects(f.scripts.save({ ...base, id: 'local', entry: 'scripts/guard.mjs', interpreter: join(f.workspace, 'run.sh') }, true), /outside the agent workspace/)
  // Another owner's registration cannot be scheduled.
  const other = { ...f.owner, generation: '00000000-0000-4000-8000-000000000000', pairedAt: new Date(Date.parse(f.owner.pairedAt) + 1000).toISOString() }
  await assert.rejects(f.scheduler.save({ id: 'stranger', name: 'x', text: '', owner: other, enabled: true, trigger: { at: '2027-01-01T00:00:00Z' }, script: { id: 'guard', args: [] } }, true), /outside this owner binding/)
})

test('agent registers and schedules a script natively; script runs cannot change scripts or schedules', async t => {
  const f = await setup(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const ledger = await serveTestLedger(f.dir); t.after(() => ledger.stop())
  const execution = await f.control.captureChoice(initialPreset('codex'))
  const turn = await f.runs.create({ chatId: 101, telegramUserId: 101, texts: ['register it'], execution })
  await f.runs.patch(turn.id, { status: 'running' })
  const env = { ...process.env, EZ_CONTROL_DIR: f.dir, EZ_RUN_ID: turn.id, EZ_AGENT_WORKSPACE: f.workspace }
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [bin, ...args], { env, cwd: f.workspace })).stdout)
  const registered = await cli('script', 'register', 'book-freshness', '--file', 'scripts/guard.mjs', '--interpreter', 'node', '--timeout-seconds', '120')
  assert.equal(registered.interpreter, 'node'); assert.equal(registered.timeoutSeconds, 120)
  await assert.rejects(cli('create', 'bad', '--script', 'book-freshness', '--model', 'gpt-6-astra', '--now'), /run no model/)
  await assert.rejects(cli('create', 'bad', '--script', 'unknown', '--now'), /not registered/)
  const schedule = await cli('create', 'actual-book-freshness-guard', '--script', 'book-freshness', '--arg=--quiet', '--cron', '15 * * * *', '--timezone', 'Asia/Dubai')
  assert.equal(schedule.executionType, 'script'); assert.deepEqual(schedule.script, { id: 'book-freshness', args: ['--quiet'] })
  assert.equal(schedule.execution, undefined); assert.equal(schedule.text, '')
  const shown = await cli('script', 'show', 'book-freshness')
  assert.equal(shown.matchesRegistration, true); assert.deepEqual(shown.schedules, ['actual-book-freshness-guard'])
  await assert.rejects(cli('script', 'remove', 'book-freshness'), /used by schedules/)
  // An existing agent schedule remains readable beside it.
  const agent = await cli('create', 'daily', '--text', 'Prepare the report', '--model', 'gpt-6-astra', '--at', '2027-09-09T09:00:00+04:00')
  assert.equal(agent.executionType, 'agent'); assert.equal(agent.execution.preset.model, 'gpt-6-astra')

  const scriptRun = await f.runs.create({ chatId: 101, telegramUserId: 101, texts: ['[schedule]'],
    script: { id: 'book-freshness', args: [], revision: registered.revision, sha256: registered.sha256 },
    scheduled: { id: 'actual-book-freshness-guard', revision: schedule.revision, dueAt: new Date().toISOString(), pairedAt: f.owner.pairedAt } })
  await f.runs.patch(scriptRun.id, { status: 'running' })
  const asScript = { env: { ...env, EZ_RUN_ID: scriptRun.id }, cwd: f.workspace }
  for (const args of [['script', 'update', 'book-freshness'], ['script', 'register', 'other', '--file', 'scripts/guard.mjs', '--interpreter', 'node'],
    ['edit', 'actual-book-freshness-guard', '--script', 'book-freshness', '--now'], ['pause', 'daily'], ['trigger', 'daily', '--key', 'k']])
    await assert.rejects(exec(process.execPath, [bin, ...args], asScript), /Script runs cannot change scripts or schedules/)
  assert.equal(JSON.parse((await exec(process.execPath, [bin, 'script', 'show', 'book-freshness'], asScript)).stdout).id, 'book-freshness')
  // A relative --file resolves from the caller's directory, stored relative to the workspace.
  const nested = JSON.parse((await exec(process.execPath, [bin, 'script', 'register', 'nested', '--file', 'guard.mjs', '--interpreter', 'node'], { env, cwd: join(f.workspace, 'scripts') })).stdout)
  assert.equal(nested.entry, join('scripts', 'guard.mjs'))
})

test('script schedules run with zero LLM invocations, exact revision receipts, isolation and fail-safe integrity', async t => {
  const f = await setup(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const savedEnv = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, EZ_TEST_SECRET: process.env.EZ_TEST_SECRET }
  process.env.PATH = `${f.fakeBin}:${process.env.PATH}`; process.env.TELEGRAM_BOT_TOKEN = '123456:secret-token-value-for-tests-only'; process.env.EZ_TEST_SECRET = 'do-not-inherit'
  t.after(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const agentLaunches: ExecutorOptions[] = []
  const relay = createRelay({ workspace: f.workspace, controlDir: f.dir, pairingTtlMs: 1000, executorTimeoutMs: 0, executorCli: 'codex', telegramBotToken: 'fixture' },
    async (texts, options) => {
      if (options.script) return startExecutorJob(texts, options)
      agentLaunches.push(options)
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10)'], { detached: true }); await once(child, 'spawn')
      return { child, cleanup: async () => {}, stdout: '' }
    })
  relay.bot.api.config.use(async () => ({ ok: true, result: { message_id: 42 } }) as never)
  t.after(() => relay.stop())
  const registration = await f.scripts.save({ id: 'book-freshness', owner: f.owner, workspace: f.workspace, entry: 'scripts/guard.mjs', interpreter: 'node', args: ['ok'], timeoutSeconds: 60 }, true)
  const schedule = await f.scheduler.save({ id: 'guard', name: 'Guard', text: '', owner: f.owner, enabled: true, trigger: { cron: '15 * * * *', timezone: 'Asia/Dubai', start: new Date().toISOString() }, script: { id: 'book-freshness', args: ['extra'] } }, true)
  const finished = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await f.runs.get(id))?.status ?? ''))
  const output = async (run: RunRecord) => JSON.parse(await readFile(join(f.workspace, `out-${run.id}.json`), 'utf8'))

  // Manual trigger.
  const manual = await f.scheduler.trigger(schedule.id, schedule.revision, 'smoke-1', f.owner, f.runs)
  await relay.drainSources(); await finished(manual.id)
  const done = (await f.runs.get(manual.id))!
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.equal(done.execution, undefined)
  assert.deepEqual(done.script, { id: 'book-freshness', args: ['extra'], revision: registration.revision, sha256: registration.sha256 })
  assert.ok(done.startedAt && done.endedAt && done.createdAt <= done.startedAt)
  assert.match(done.output!, /routine check ok/); assert.match(done.output!, /diagnostic line/); assert.doesNotMatch(done.output!, /abcdefghijklmnopqrstuvwxyz0123456789ABCDEF/)
  const seen = await output(done)
  assert.deepEqual(seen.argv, ['ok', 'extra']); assert.deepEqual(seen.leaked, [])
  assert.equal(seen.env.EZ_RUN_ID, manual.id); assert.equal(seen.env.EZ_SCHEDULE_ID, 'guard'); assert.equal(seen.env.EZ_SCHEDULE_REVISION, schedule.revision)
  assert.equal(seen.env.EZ_DUE_AT, done.scheduled!.dueAt); assert.equal(seen.env.EZ_SCRIPT_REVISION, registration.revision); assert.equal(seen.env.EZ_SCRIPT_SHA256, registration.sha256)
  assert.equal((await relay.drainOutbox(), (await f.runs.pendingOutbox()).length), 0)

  // Natural occurrence through the existing tick.
  const due = await f.scheduler.pendingOccurrence(schedule)
  await f.scheduler.tick(f.owner, f.runs, due!)
  const natural = (await f.runs.list()).find(r => r.id !== manual.id && r.scheduled?.id === 'guard')!
  assert.equal(natural.scheduled!.dueAt, new Date(due!).toISOString())
  await relay.drainSources(); await finished(natural.id)
  assert.equal((await f.runs.get(natural.id))?.status, 'completed')
  await assert.rejects(access(join(f.root, 'llm-invocations')))
  assert.equal(agentLaunches.length, 0)

  // Changed entry-point bytes refuse to run until an explicit update.
  await writeFile(join(f.workspace, 'scripts', 'guard.mjs'), fixture + '\n// edited\n')
  const tampered = await f.scheduler.trigger(schedule.id, schedule.revision, 'tampered', f.owner, f.runs)
  await relay.drainSources(); await finished(tampered.id)
  const refused = (await f.runs.get(tampered.id))!
  assert.equal(refused.status, 'failed'); assert.match(refused.failure!.error, /entry point changed since registration/)
  await assert.rejects(readFile(join(f.workspace, `out-${tampered.id}.json`)))
  const updated = await f.scripts.save({ id: 'book-freshness', owner: f.owner, workspace: f.workspace, entry: 'scripts/guard.mjs', interpreter: 'node', args: ['hang'], timeoutSeconds: 60 }, false)
  assert.notEqual(updated.sha256, registration.sha256)

  // Cancellation stops the script and its children; overlap is refused meanwhile.
  const long = await f.scheduler.trigger(schedule.id, schedule.revision, 'long', f.owner, f.runs)
  await relay.drainSources()
  const childPid = Number(await until(async () => { try { await access(join(f.workspace, `child-${long.id}.pid`)); return true } catch { return false } })
    .then(() => readFile(join(f.workspace, `child-${long.id}.pid`), 'utf8')))
  assert.ok(alive(childPid))
  assert.equal((await f.runs.get(long.id))?.script?.revision, updated.revision)
  await assert.rejects(f.scheduler.trigger(schedule.id, schedule.revision, 'overlap', f.owner, f.runs), /queued or running/)
  const before = (await f.runs.list()).length
  await f.scheduler.tick(f.owner, f.runs, (await f.scheduler.pendingOccurrence(schedule))! + 3600_000)
  assert.equal((await f.runs.list()).length, before)
  await f.scheduler.cancel(long.id); await relay.drainSources(); await finished(long.id)
  assert.equal((await f.runs.get(long.id))?.status, 'cancelled')
  await until(async () => !alive(childPid))

  // A bounded timeout terminates the process; it is a failure, never retried.
  await f.scripts.save({ id: 'book-freshness', owner: f.owner, workspace: f.workspace, entry: 'scripts/guard.mjs', interpreter: 'node', args: ['hang'], timeoutSeconds: 1 }, false)
  const slow = await f.scheduler.trigger(schedule.id, schedule.revision, 'slow', f.owner, f.runs)
  await relay.drainSources(); await finished(slow.id)
  const timedOut = (await f.runs.get(slow.id))!
  assert.equal(timedOut.status, 'failed'); assert.equal(timedOut.failureReason, 'script-timeout'); assert.equal(timedOut.timedOut, true)
  const slowChild = Number(await readFile(join(f.workspace, `child-${slow.id}.pid`), 'utf8'))
  await until(async () => !alive(slowChild))
  await relay.drainSources()
  assert.equal((await f.runs.list()).filter(r => r.scheduled?.id === 'guard' && r.status === 'queued').length, 0)

  // An existing LLM schedule still launches its native engine settings.
  const execution = await f.control.captureChoice({ ...initialPreset('codex'), model: 'gpt-6-astra' })
  const agent = await f.scheduler.save({ id: 'report', name: 'Report', text: 'Prepare the report', owner: f.owner, execution, enabled: true, trigger: { at: '2027-01-01T00:00:00Z' } }, true)
  const agentRun = await f.scheduler.trigger(agent.id, agent.revision, 'agent', f.owner, f.runs)
  await relay.drainSources(); await finished(agentRun.id)
  assert.equal((await f.runs.get(agentRun.id))?.status, 'completed')
  assert.equal(agentLaunches.length, 1); assert.equal(agentLaunches[0].model, 'gpt-6-astra'); assert.equal(agentLaunches[0].nativeSession, true)
})
