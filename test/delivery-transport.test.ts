import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createLedgerHandler, deliverySocketPath, serveDeliverySocket } from '../src/delivery-socket.js'
import { callDeliverySocket } from '../src/delivery-socket-client.mjs'

const status = () => ({ polling: false, applicationOnly: false, telegramConfigured: true, version: 'test' })

const tcpCall = (endpoint: { host: string; port: number }, frame: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)))
    })
    socket.once('close', () => resolve(undefined))
    socket.once('error', reject)
  })

test('host processes reach the relay ledger through the loopback endpoint when the Unix socket is unreachable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-tcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await serveDeliverySocket(dir, createLedgerHandler(dir, { wake: () => {}, status }), { tcpPort: 0 })
  t.after(() => server.stop())
  const socketPath = deliverySocketPath(dir)
  assert.equal(server.endpoint?.host, '127.0.0.1')
  assert.ok(server.endpoint && server.endpoint.port > 0)
  const endpoint = server.endpoint!
  // Container-local producers keep using the Unix socket.
  assert.deepEqual(await callDeliverySocket(socketPath, { op: 'ping' }), { ok: true })
  // Authenticated loopback frames work with the control-directory token.
  assert.deepEqual(await tcpCall(endpoint, { id: '1', op: 'ping', token: endpoint.token }), { id: '1', ok: true, result: { ok: true } })
  // macOS host fallback: the socket file is visible but not connectable.
  await unlink(socketPath)
  assert.deepEqual(await callDeliverySocket(socketPath, { op: 'ping' }), { ok: true })
})

test('loopback frames without the control-directory token are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-token-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await serveDeliverySocket(dir, createLedgerHandler(dir, { wake: () => {}, status }), { tcpPort: 0 })
  t.after(() => server.stop())
  const endpoint = server.endpoint!
  assert.equal(await tcpCall(endpoint, { id: '1', op: 'ping' }), undefined)
  assert.equal(await tcpCall(endpoint, { id: '1', op: 'ping', token: '0'.repeat(64) }), undefined)
})

test('the client fails closed when neither the socket nor an endpoint exists', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-missing-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(callDeliverySocket(deliverySocketPath(dir), { op: 'ping' }, 500), /Delivery relay unavailable/)
})

test('a response timeout is not replayed over the loopback endpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ez-delivery-timeout-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let calls = 0
  const server = await serveDeliverySocket(dir, async () => { calls++; return new Promise(() => {}) }, { tcpPort: 0 })
  t.after(() => server.stop())
  assert.ok(server.endpoint)
  await assert.rejects(callDeliverySocket(deliverySocketPath(dir), { op: 'enqueue' }, 200), /Delivery relay unavailable/)
  assert.equal(calls, 1)
})
