import test from 'node:test'
import assert from 'node:assert/strict'
import { readRequest } from '../src/read-request.js'

test('repeatable input retries connection reset and 503 with bounded backoff', async (t) => {
  let attempts = 0
  const delays: number[] = []
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++
    if (attempts === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    return attempts === 2 ? new Response('', { status: 503 }) : new Response('transcript')
  })
  assert.equal(
    await readRequest(
      'Fixture transcription',
      'https://example.invalid',
      {},
      (r) => r.text(),
      async (ms) => {
        delays.push(ms)
      },
    ),
    'transcript',
  )
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [1000, 2000])
})

test('exhausted input retries report stage and nested network cause without credentials', async (t) => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++
    throw new TypeError('fetch failed secret-token-url', {
      cause: new AggregateError([{ code: 'ETIMEDOUT' }]),
    })
  })
  await assert.rejects(
    readRequest(
      'Telegram attachment download',
      'https://example.invalid/secret-token',
      {},
      (r) => r.text(),
      async () => {},
    ),
    (error) => {
      assert.match((error as Error).message, /Telegram attachment download: ETIMEDOUT \(after 3 attempts\)/)
      assert.equal((error as Error).message.includes('secret-token'), false)
      return true
    },
  )
  assert.equal(attempts, 3)
})

test('authentication failures and certificate errors are not retried', async (t) => {
  let attempts = 0
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    attempts++
    return new Response('secret provider payload', { status: 401 })
  })
  await assert.rejects(
    readRequest(
      'STT',
      'https://example.invalid',
      {},
      (r) => r.text(),
      async () => assert.fail('must not retry'),
    ),
    /STT: HTTP 401 \(after 1 attempt\)/,
  )
  assert.equal(attempts, 1)
  fetch.mock.mockImplementation(async () => {
    throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } })
  })
  await assert.rejects(
    readRequest(
      'STT',
      'https://example.invalid',
      {},
      (r) => r.text(),
      async () => assert.fail('must not retry'),
    ),
    /CERT_HAS_EXPIRED.*1 attempt/,
  )
})

test('429 honors Retry-After and does not shorten a long provider cooldown', async (t) => {
  let attempts = 0
  const delays: number[] = []
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    ++attempts === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '5' } })
      : new Response('ok'),
  )
  await readRequest(
    'STT',
    'https://example.invalid',
    {},
    (r) => r.text(),
    async (ms) => {
      delays.push(ms)
    },
  )
  assert.deepEqual(delays, [5000])
  fetch.mock.mockImplementation(
    async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
  )
  await assert.rejects(
    readRequest(
      'STT',
      'https://example.invalid',
      {},
      (r) => r.text(),
      async () => assert.fail('must not retry before provider cooldown'),
    ),
    /HTTP 429.*1 attempt/,
  )
})

test('a socket failure while consuming the body is retried, not just fetch headers', async (t) => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'))
  const result = await readRequest(
    'Download',
    'https://example.invalid',
    {},
    async (r) => {
      if (++attempts === 1) throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })
      return r.text()
    },
    async () => {},
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
})
