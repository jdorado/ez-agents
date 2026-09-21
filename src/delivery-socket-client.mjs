import { createConnection } from 'node:net'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Plain-JS delivery transport shared by the TypeScript relay and the
// plain-Node tools (plugin manager, update supervisor, install status). The
// relay owns run records in memory; every other process reaches them through
// this socket on the shared control volume. Newline-delimited JSON frames:
// {id, op, payload} -> {id, ok, result?, error?}.
//
// Host-capable deployments publish a loopback TCP endpoint as well: on Docker
// Desktop/OrbStack the container's Unix socket is not connectable from the
// macOS host, so host processes fall back to the relay's authenticated
// loopback listener described by control/delivery-endpoint.json.
export const deliverySocketPath = controlDir => path.join(controlDir, 'delivery.sock')

const encode = value => `${JSON.stringify(value)}\n`
const endpointName = 'delivery-endpoint.json'
const connectFailureCodes = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPROTOTYPE'])

const unavailable = (target, cause) => {
  const error = new Error(`Delivery relay unavailable at ${target}`)
  if (cause !== undefined) error.cause = cause
  error.connectFailure = true
  return error
}

// A timeout is not a connect failure: the relay may already have processed the
// request, so replaying the frame elsewhere could duplicate an uncertain write.
const timedOut = target => new Error(`Delivery relay unavailable at ${target}`)

const exchange = (connect, envelope, timeoutMs, target) => new Promise((resolve, reject) => {
  let done = false
  const socket = connect()
  const timer = setTimeout(() => {
    if (done) return
    done = true
    socket.destroy()
    reject(timedOut(target))
  }, timeoutMs)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.once('error', error => {
    if (done) return
    done = true
    clearTimeout(timer)
    reject(error?.code && connectFailureCodes.has(error.code) ? unavailable(target, error) : error)
  })
  socket.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let response
      try { response = JSON.parse(line) } catch { continue }
      if (response.id !== envelope.id) continue
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (response.ok) resolve(response.result)
      else reject(new Error(typeof response.error === 'string' ? response.error : 'Delivery request failed'))
    }
  })
  socket.write(encode(envelope))
})

const readEndpoint = async controlDir => {
  try {
    const value = JSON.parse(await readFile(path.join(controlDir, endpointName), 'utf8'))
    if (value?.host !== '127.0.0.1' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) return null
    return value
  } catch { return null }
}

export const callDeliverySocket = async (socketPath, op, timeoutMs = 130_000) => {
  const id = `${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(16)}`
  try {
    return await exchange(() => createConnection(socketPath), { id, ...op }, timeoutMs, socketPath)
  } catch (error) {
    if (!error?.connectFailure) throw error
  }
  const endpoint = await readEndpoint(path.dirname(socketPath))
  if (!endpoint) throw unavailable(socketPath)
  const target = `${endpoint.host}:${endpoint.port}`
  try {
    return await exchange(() => createConnection({ host: endpoint.host, port: endpoint.port }), { id, token: endpoint.token, ...op }, timeoutMs, target)
  } catch (error) {
    if (!error?.connectFailure) throw error
    throw unavailable(`${socketPath} and ${target}`, error)
  }
}

export const deliverySocketAlive = async (socketPath, timeoutMs = 2000) => {
  try {
    await callDeliverySocket(socketPath, { op: 'ping' }, timeoutMs)
    return true
  } catch {
    return false
  }
}
