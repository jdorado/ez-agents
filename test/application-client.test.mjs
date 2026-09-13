import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationBinding, applicationCall, runApplication } from '../src/application-client.mjs'

const id = `r_app_${'a'.repeat(64)}`
test('principal bindings fail closed on unknown, revoked, duplicate and shared endpoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-client-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'bindings.json'), tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'private-token\n', { mode: 0o600 })
  let bindings = [{ principalId: 'alice', url: 'http://alice:8787', tokenFile }, { principalId: 'bob', url: 'http://bob:8787', tokenFile }]
  const save = () => writeFile(file, JSON.stringify({ version: 1, bindings }))
  await save()
  assert.equal((await applicationBinding(file, 'alice')).url, 'http://alice:8787')
  assert.equal((await applicationBinding(file, 'bob')).url, 'http://bob:8787')
  await assert.rejects(applicationBinding(file, 'eve'), /No authorized/)
  bindings[1].revoked = true; await save()
  await assert.rejects(applicationBinding(file, 'bob'), /No authorized/)
  bindings[1].url = 'http://alice:8787/'; await save()
  await assert.rejects(applicationBinding(file, 'alice'), /separate Ez endpoints/)
  bindings[1].url = 'http://bob:8787'; bindings[1].principalId = 'alice'; await save()
  await assert.rejects(applicationBinding(file, 'alice'), /Invalid/)
  await writeFile(file, '{')
  await assert.rejects(applicationBinding(file, 'alice'))
})

test('shared client preserves one submission, exposes native continuity and bounds uncertain failure', async () => {
  const calls = [], admitted = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), ...options })
    return Response.json({ id, status: calls.length === 1 ? 'queued' : 'completed', nativeSessionId: 'native-history', messages: [{ id: 'message', text: 'Done' }] })
  }
  const input = { requestId: 'same-job', scope: 'main', text: 'hello', context: { capability: 'scoped' } }
  const result = await runApplication(input, { url: 'http://agent:8787', token: 'secret', fetchImpl, pollMs: 1, onAdmitted: value => admitted.push(value) })
  assert.equal(result.reply, 'Done'); assert.equal(result.nativeSessionId, 'native-history')
  assert.deepEqual(admitted, [id]); assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[0].body), input)
  assert.equal(calls[1].method, 'GET'); assert.equal(calls[0].redirect, 'error')
  await assert.rejects(applicationCall('/v1/runs', input, { url: 'http://agent:8787', token: 'secret', fetchImpl: async () => new Response('{', { status: 200 }) }), error => error.retryable === true)
  await assert.rejects(applicationCall('/v1/runs', input, { url: 'http://agent:8787', token: 'secret', fetchImpl: async () => new Response('', { status: 403 }) }), error => error.retryable === false)
  await assert.rejects(applicationCall('//other-host', input, { url: 'http://agent:8787', token: 'secret', fetchImpl }), /Invalid/)
  await assert.rejects(runApplication(input, { url: 'http://agent:8787', token: 'secret', fetchImpl: async () => Response.json({ id, status: 'cancelled' }) }), error => error.terminal === true)
  assert.equal(calls.length, 2, 'invalid operation never sends a credential')
})

test('opt-in reconnect retains admission identity and polls through temporary network failure', async () => {
  const calls = []
  const input = { requestId: 'durable', scope: 'main', text: 'Update', context: { capability: 'original' } }
  const result = await runApplication(input, { url: 'http://agent:8787', token: 'secret', pollMs: 1, reconnect: true,
    fetchImpl: async (_url, options) => {
      calls.push(options)
      if (calls.length === 1 || calls.length === 3) throw new Error('connection lost')
      return Response.json({ id, status: calls.length === 2 ? 'running' : 'completed', messages: [{ text: 'Saved' }] })
    },
  })
  assert.equal(result.reply, 'Saved')
  assert.equal(calls[0].body, calls[1].body)
  assert.equal(calls[2].method, 'GET'); assert.equal(calls[3].method, 'GET')
})
