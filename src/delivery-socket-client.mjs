import { createConnection } from 'node:net'
import path from 'node:path'

// Plain-JS delivery transport shared by the TypeScript relay and the
// plain-Node tools (plugin manager, update supervisor, install status). The
// relay owns run records in memory; every other process reaches them through
// this socket on the shared control volume. Newline-delimited JSON frames:
// {id, op, payload} -> {id, ok, result?, error?}.
export const deliverySocketPath = controlDir => path.join(controlDir, 'delivery.sock')

const encode = value => `${JSON.stringify(value)}\n`

export const callDeliverySocket = async (socketPath, op, timeoutMs = 130_000) => {
  const id = `${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(16)}`
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      socket.destroy()
      reject(new Error(`Delivery relay unavailable at ${socketPath}`))
    }, timeoutMs)
    const socket = createConnection(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', error => {
      if (done) return
      done = true
      clearTimeout(timer)
      const code = error.code
      reject(code === 'ENOENT' || code === 'ECONNREFUSED'
        ? new Error(`Delivery relay unavailable at ${socketPath}`)
        : error)
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
        if (response.id !== id) continue
        if (done) return
        done = true
        clearTimeout(timer)
        socket.destroy()
        if (response.ok) resolve(response.result)
        else reject(new Error(typeof response.error === 'string' ? response.error : 'Delivery request failed'))
      }
    })
    socket.write(encode({ id, ...op }))
  })
}

export const deliverySocketAlive = async (socketPath, timeoutMs = 2000) => {
  try {
    await callDeliverySocket(socketPath, { op: 'ping' }, timeoutMs)
    return true
  } catch {
    return false
  }
}
