import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Backend-only: identity must already have been resolved by the application.
// Each entry names a separately isolated ordinary Ez deployment, not a session.
export async function applicationBinding(file, principalId) {
  if (typeof principalId !== 'string' || !principalId) throw new Error('Application principal is required')
  const registry = JSON.parse(await readFile(file, 'utf8'))
  if (registry?.version !== 1 || !Array.isArray(registry.bindings)) throw new Error('Invalid application binding registry')
  const principals = new Set(), endpoints = new Set()
  for (const entry of registry.bindings) {
    if (typeof entry.principalId !== 'string' || !entry.principalId || principals.has(entry.principalId) ||
        typeof entry.tokenFile !== 'string' || !isAbsolute(entry.tokenFile) ||
        (entry.revoked !== undefined && typeof entry.revoked !== 'boolean')) throw new Error('Invalid application binding registry')
    const endpoint = applicationEndpoint(entry.url).origin
    if (endpoints.has(endpoint)) throw new Error('Independent principals require separate Ez endpoints')
    principals.add(entry.principalId); endpoints.add(endpoint)
  }
  const entry = registry.bindings.find(item => item.principalId === principalId && !item.revoked)
  if (!entry) throw new Error('No authorized Ez binding for this principal')
  const token = (await readFile(entry.tokenFile, 'utf8')).trim()
  if (!token) throw new Error('Ez application credential is missing')
  return { url: entry.url, token }
}

function applicationEndpoint(value) {
  const endpoint = new URL(value)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Invalid Ez application endpoint')
  return endpoint
}

export async function applicationCall(path, body, { url, token, fetchImpl = fetch, signal } = {}) {
  if (!token) throw new Error('Ez application credential is missing')
  if (!/^\/v1\/(?:control|runs(?:\/r_app_[a-f0-9]{64}(?:\/cancel)?)?)$/.test(path)) throw new Error('Invalid Ez application operation')
  let response
  try {
    response = await fetchImpl(new URL(path, applicationEndpoint(url)), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    throw Object.assign(new Error('Ez application transport unavailable', { cause }), { retryable: !signal?.aborted })
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw Object.assign(new Error(`Ez application returned HTTP ${response.status}`), {
      retryable: response.status >= 500 || [408, 429].includes(response.status), status: response.status,
      ...(typeof body?.admitted === 'boolean' ? { admitted: body.admitted } : {}),
      ...(typeof body?.runId === 'string' ? { runId: body.runId } : {}),
    })
  }
  try { return await response.json() }
  catch (cause) { throw Object.assign(new Error('Ez application response unavailable or invalid', { cause }), { retryable: true }) }
}

// Reconnect with the same requestId after transport failure. This client never
// creates another job, rotates its authority, or retries a domain mutation.
export async function runApplication(input, { pollMs = 1000, onAdmitted, signal, reconnect = false, ...connection } = {}) {
  const call = async (path, body) => {
    for (;;) {
      try { return await applicationCall(path, body, { ...connection, signal }) }
      catch (error) {
        if (!reconnect || !error.retryable || signal?.aborted) throw error
        await delay(pollMs, undefined, { signal })
      }
    }
  }
  let run = await call('/v1/runs', input)
  await onAdmitted?.(run.id)
  while (run.status === 'queued' || run.status === 'running') {
    await delay(pollMs, undefined, { signal })
    run = await call(`/v1/runs/${encodeURIComponent(run.id)}`)
  }
  if (run.status !== 'completed') throw Object.assign(new Error(run.error || `Ez application run ${run.status}`), {
    terminal: ['failed', 'cancelled'].includes(run.status),
  })
  const reply = run.messages?.filter(message => typeof message.text === 'string' && message.text.trim()).at(-1)?.text
  if (!reply) throw Object.assign(new Error('Ez application completed without a reply'), { terminal: true })
  return { ...run, reply }
}
