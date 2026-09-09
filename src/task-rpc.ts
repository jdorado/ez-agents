import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicTaskFile, Tasks } from './tasks.js'

// Shared control storage crosses the Docker/host boundary. It is never exposed
// to task model tools. Only the relay dispatches provider operations.
export async function taskCall(controlDir: string, runId: string, role: 'owner' | 'worker', command: string, args = {}) {
  const directory = join(controlDir, 'task-rpc')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const base = join(directory, randomUUID())
  await atomicTaskFile(`${base}.request.json`, { runId, role, command, args, expiresAt: Date.now() + 30000 })
  const deadline = Date.now() + 35000
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(`${base}.response.json`, 'utf8'))
      if (!result.ok) throw new Error(result.error)
      return result.data
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Task request outcome unknown; inspect task status before retrying')
}
export function taskRequests(tasks: Tasks) {
  let pending: Promise<void> | undefined
  return (): Promise<void> => pending ?? (pending = (async () => {
    const directory = join(tasks.controlDir, 'task-rpc')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.request\.json$/.test(file)) continue
      const base = join(directory, file.slice(0, -13))
      await rename(`${base}.request.json`, `${base}.claimed.json`)
      let result: unknown
      try {
        const request = JSON.parse(await readFile(`${base}.claimed.json`, 'utf8'))
        if (request.expiresAt < Date.now() || !Number.isFinite(request.expiresAt) || !request.args || typeof request.args !== 'object') throw new Error('Invalid or expired task request')
        // Both handlers independently verify the saved run. "role" is routing only.
        const data = request.role === 'owner' ? await tasks.ownerCall(request.runId, request.command, request.args)
          : request.role === 'worker' ? await tasks.workerCall(request.runId, request.command, request.args) : (() => { throw new Error('Invalid role') })()
        result = { ok: true, data }
      } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'Task request failed' } }
      await atomicTaskFile(`${base}.response.json`, result)
    }
  })().finally(() => { pending = undefined }))
}
