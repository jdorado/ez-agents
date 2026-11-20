// Recovery from states a full disk or a killed process leaves behind. Each case
// once needed a human to clear a file before the agent answered again.
import { ownerRun } from './helpers/owner-run.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, utimes, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveHostExecutor } from '../src/host-executor.js'
import { ControlStore } from '../src/control-state.js'

const waitFor = async (check: () => Promise<boolean>, attempts = 300) => {
  for (let n = 0; n < attempts; n++) { if (await check().catch(() => false)) return; await new Promise(r => setTimeout(r, 20)) }
  assert.fail('condition not reached')
}
const gone = (file: string) => stat(file).then(() => false, () => true)

test('host executor starts over a truncated worker lock and closes a claim with a truncated process record', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-truncated-'))
  const workspace = path.join(root, 'mind'), controlDir = path.join(root, 'control'), directory = path.join(controlDir, 'host-executor')
  await mkdir(workspace); await mkdir(directory, { recursive: true })
  // A write cut by ENOSPC leaves created-but-empty files.
  await writeFile(path.join(directory, 'worker.lock'), '')
  await writeFile(path.join(directory, 'r_cut.running.json'), '{}')
  await writeFile(path.join(directory, 'r_cut.process.json'), '')
  const abort = new AbortController()
  const server = serveHostExecutor({ cli: 'grok', agents: [{ name: 'test', workspace, controlDir, binDir: root }] }, abort.signal, undefined, async () => [])
  t.after(async () => { abort.abort(); await server; await rm(root, { recursive: true, force: true }) })
  await waitFor(async () => Boolean(await readFile(path.join(directory, 'heartbeat.json'))))
  assert.equal(JSON.parse(await readFile(path.join(directory, 'worker.lock'), 'utf8')).pid, process.pid)
  assert.ok(await gone(path.join(directory, 'r_cut.running.json')))
  assert.match(await readFile(path.join(directory, 'r_cut.events'), 'utf8'), /"stream":"exit","code":1/)
})

test('a failed event write ends that run cleanly and keeps the host executor serving', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-event-write-'))
  const workspace = path.join(root, 'mind'), controlDir = path.join(root, 'control'), directory = path.join(controlDir, 'host-executor')
  await mkdir(workspace); await mkdir(controlDir)
  const abort = new AbortController()
  const launch = async (_texts: string[], options: { runId?: string }) => {
    // The run's result file stops accepting writes, as on a full disk.
    if (options.runId === 'r_disk_full') await chmod(path.join(directory, 'r_disk_full.events'), 0o400)
    const child = spawn(process.execPath, ['-e', 'console.log("output");setTimeout(()=>{},100)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    return { child, cleanup: async () => {}, stdout: '' }
  }
  const server = serveHostExecutor({ cli: 'grok', agents: [{ name: 'test', workspace, controlDir, binDir: root }] }, abort.signal, launch as never, async () => [])
  t.after(async () => { abort.abort(); await server; await rm(root, { recursive: true, force: true }) })
  await waitFor(async () => Boolean(await readFile(path.join(directory, 'heartbeat.json'))))
  await ownerRun(controlDir, 'r_disk_full')
  await writeFile(path.join(directory, 'r_disk_full.request.json'), JSON.stringify({ texts: ['a'], options: { cli: 'grok' } }))
  await waitFor(async () => await gone(path.join(directory, 'r_disk_full.running.json')) && await gone(path.join(directory, 'r_disk_full.request.json')))
  assert.ok(await gone(path.join(directory, 'r_disk_full.process.json')))
  // The same executor still claims and completes the next run.
  await ownerRun(controlDir, 'r_after')
  await writeFile(path.join(directory, 'r_after.request.json'), JSON.stringify({ texts: ['b'], options: { cli: 'grok' } }))
  await waitFor(async () => (await readFile(path.join(directory, 'r_after.events'), 'utf8')).includes('"stream":"exit","code":0'))
})

test('client ends a run whose request and claim are gone without an exit event', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-lost-exit-'))
  const directory = path.join(root, 'host-executor'); await mkdir(directory)
  try {
    // A live host keeps beating, so only the missing request and claim can end this watch.
    const beat = setInterval(() => { void writeFile(path.join(directory, 'heartbeat.json'), JSON.stringify({ at: Date.now() })) }, 200)
    const client = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../src/host-executor-client.ts', import.meta.url)), root, 'tg_96'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''; client.stderr.on('data', chunk => stderr += chunk); client.stdout.resume()
    const closed = new Promise(resolve => client.once('close', resolve))
    client.stdin.end(JSON.stringify({ texts: ['test'], options: {} }))
    await waitFor(async () => Boolean(await readFile(path.join(directory, 'tg_96.request.json'))))
    await writeFile(path.join(directory, 'tg_96.events'), JSON.stringify({ stream: 'stdout', text: 'partial' }) + '\n')
    await rm(path.join(directory, 'tg_96.request.json'))
    assert.equal(await closed, 1)
    clearInterval(beat)
    assert.match(stderr, /Host run ended without a result/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a control lock left by a killed holder is broken instead of blocking every caller', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ez-control-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const control = new ControlStore(root, 900_000)
  await control.status()
  const lock = path.join(root, 'control-state.lock'), old = new Date(Date.now() - 60_000)
  await writeFile(lock, 'killed-holder'); await utimes(lock, old, old)
  assert.equal(await control.getActiveSession(), null)
  assert.ok(await gone(lock))
  // A fresh lock is still respected.
  await writeFile(lock, 'live-holder')
  await assert.rejects(control.getActiveSession(), /authority control lock/)
})
