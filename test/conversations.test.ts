import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlStore, sessionTitle } from '../src/control-state.js'
import { initialPreset } from '../src/ai.js'
import { EXECUTOR_REGISTRY } from '../src/executor.js'

const fixture = async (work: (store: ControlStore, dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-conversations-'))
  try { await work(new ControlStore(dir, 1000), dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('switching after restart restores native context and model while queued choices stay pinned', async () => fixture(async (store, dir) => {
  const first = await store.captureChoice(initialPreset('codex'), 'Client launch')
  await store.saveNativeSession(first.sessionId, 'native_first')
  await store.savePreset({ id: 'second', name: 'Second', cli: 'grok', model: 'fixture' })
  await store.selectPreset('second', first.sessionId, true)
  const second = await store.captureChoice(initialPreset('grok'), 'Holiday planning')
  await store.markSessionStarted(second.sessionId)
  const restarted = new ControlStore(dir, 1000)
  await restarted.switchSession(first.sessionId)
  assert.deepEqual(await restarted.captureChoice(initialPreset('grok')), first)
  const session = await restarted.executionSession(first)
  const args = EXECUTOR_REGISTRY.codex.buildArgs({ workspace: dir, isResume: session.hasStarted, sessionId: session.nativeSessionId }, '', '')
  assert.equal(args[args.indexOf('resume') + 1], 'native_first')
  assert.equal((await restarted.executionSession(second)).sessionId, second.sessionId)
  await restarted.switchSession(second.sessionId)
  assert.deepEqual(await restarted.captureChoice(initialPreset('codex')), second)
  assert.equal((await restarted.listSessions()).length, 2)
}))

test('archive hides without deleting, late completions keep their binding, restore survives restart', async () => fixture(async (store, dir) => {
  const first = await store.captureChoice(initialPreset('codex'), 'Topic one')
  await store.archiveSession(first.sessionId, true)
  assert.equal(await store.getActiveSession(), null)
  await store.saveNativeSession(first.sessionId, 'native_late')
  const second = await store.captureChoice(initialPreset('codex'), 'Topic two')
  assert.notEqual(second.sessionId, first.sessionId)
  await assert.rejects(store.switchSession(first.sessionId), /unavailable/)
  const restarted = new ControlStore(dir, 1000)
  assert.equal((await restarted.executionSession(first)).nativeSessionId, 'native_late')
  await restarted.archiveSession(first.sessionId, false)
  await restarted.switchSession(first.sessionId)
  assert.equal((await restarted.executionSession(first)).nativeSessionId, 'native_late')
  assert.equal((await restarted.listSessions()).length, 2)
}))

test('titles are bounded and rename is durable; malformed IDs and unsupported metadata fail closed', async () => fixture(async (store, dir) => {
  const first = await store.captureChoice(initialPreset('grok'), '  Topic\n one ')
  assert.equal(sessionTitle((await store.getActiveSession())!), 'Topic one')
  await store.captureChoice(initialPreset('grok'), 'second message')
  assert.equal(sessionTitle((await store.getActiveSession())!), 'Topic one')
  await store.renameSession('<Client & launch>')
  assert.equal(sessionTitle((await new ControlStore(dir, 1000).getActiveSession())!), '<Client & launch>')
  await assert.rejects(store.renameSession('x'.repeat(81)), /1–80/)
  await assert.rejects(store.switchSession('../escape'), /unavailable/)
  await assert.rejects(store.archiveSession('../escape', true), /unavailable/)
  assert.equal((await store.getActiveSession())!.sessionId, first.sessionId)
  const file = join(dir, 'control-state.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  state.activeSession.preset.cli = 'sh'
  await writeFile(file, JSON.stringify(state))
  await assert.rejects(store.listSessions(), /unsupported shape/)
}))

test('legacy sessions retain IDs; unbound and latest-only engines cannot resume a different context', async () => fixture(async (store, dir) => {
  const legacy = await store.ensureActiveSession()
  await store.markSessionStarted(legacy.sessionId)
  await store.captureChoice(initialPreset('grok'))
  await store.resetSession()
  await assert.rejects(store.switchSession(legacy.sessionId), /binding/)
  assert.match(sessionTitle((await store.listSessions()).find(s => s.sessionId === legacy.sessionId)!), /Conversation /)
  await store.archiveSession(legacy.sessionId, true)
  const agy = { id: 'agy-test', name: 'AGY', cli: 'agy' }
  await store.savePreset(agy)
  await store.selectPreset(agy.id, (await store.getActiveSession())!.sessionId, true)
  const old = await store.captureChoice(agy)
  await store.markSessionStarted(old.sessionId)
  await store.resetSession()
  await assert.rejects(store.switchSession(old.sessionId), /latest conversation/)
}))
