import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { request } from 'node:http'
import type { Owner } from './control-state.js'

export type ExternalOrigin = { sourceId: string; bindingId: string; eventIds: string[] }
export type SourceEvent = { id: string; conversationId: string; receivedAt: number; text: string }
export type EventSource = { id: string; bindingId: string; socketPath: string; initialCursor: number; owner: Owner }
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s)
export const validOrigin = (o: unknown): o is ExternalOrigin => {
  const v = o as ExternalOrigin | undefined
  return !!v && identifier(v.sourceId) && identifier(v.bindingId) && Array.isArray(v.eventIds) && v.eventIds.length > 0 && v.eventIds.length <= 10 && v.eventIds.every(identifier)
}
const cursorOK = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
export const validEvents = (v: unknown): v is SourceEvent[] => Array.isArray(v) && v.length <= 10 && v.every(e =>
  identifier(e?.id) && typeof e.conversationId === 'string' && e.conversationId.length > 0 && e.conversationId.length <= 200 &&
  Number.isFinite(e.receivedAt) && typeof e.text === 'string' && e.text.length <= 16000) && new Set(v.map(e => e.id)).size === v.length
const sameOwner = (a: Owner, b: Owner) => a.telegramUserId === b.telegramUserId && a.telegramChatId === b.telegramChatId
async function read<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new Error('Unreadable event-source state') }
}
async function atomic(path: string, data: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = await open(tmp, 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify(data)); await fd.sync() } finally { await fd.close() }
  await rename(tmp, path)
}
export function sourceCall(socketPath: string, command: string, args = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/', method: 'POST', timeout: 3000 }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 256000) req.destroy(new Error('Event-source response too large')) })
      res.on('error', () => reject(new Error('Event-source response interrupted')))
      res.on('end', () => {
        try { const result = JSON.parse(body); if (res.statusCode !== 200 || result.ok !== true) throw new Error(); resolve(result.data) }
        catch { reject(new Error('Invalid event-source response')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Event source unavailable')))
    req.on('error', () => reject(new Error('Event source unavailable')))
    req.end(JSON.stringify({ command, args }))
  })
}
export class EventSources {
  constructor(private dir: string) {}
  private get registry() { return join(this.dir, 'event-sources.json') }
  async list(): Promise<EventSource[]> {
    const value = await read<{ version: number; sources: EventSource[] }>(this.registry, { version: 1, sources: [] })
    if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.some(s => !identifier(s.id) || !identifier(s.bindingId) ||
      typeof s.socketPath !== 'string' || !isAbsolute(s.socketPath) || !cursorOK(s.initialCursor) ||
      !Number.isSafeInteger(s.owner?.telegramUserId) || s.owner.telegramUserId <= 0 || !Number.isSafeInteger(s.owner.telegramChatId) ||
      (s.owner.kind === 'group' ? s.owner.telegramChatId >= 0 : s.owner.kind !== undefined || s.owner.telegramChatId <= 0)) ||
      new Set(value.sources.map(s => s.id)).size !== value.sources.length) throw new Error('Invalid event-source registry')
    return value.sources
  }
  async register(id: string, socketPath: string | null, owner: Owner) {
    if (!identifier(id) || (socketPath !== null && !isAbsolute(socketPath))) throw new Error('Use a simple source name and absolute socket path')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const lockPath = join(this.dir, 'event-sources.lock')
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      const sources = await this.list()
      const existing = sources.find(s => s.id === id)
      if (socketPath === null) {
        await atomic(this.registry, { version: 1, sources: sources.filter(s => s.id !== id) }); return
      }
      if (existing) {
        if (existing.socketPath === socketPath && sameOwner(existing.owner, owner)) return existing
        throw new Error('Source name already bound; remove it explicitly before replacing')
      }
      if (!(await lstat(socketPath)).isSocket()) throw new Error('Expected a local Unix socket')
      const head = await sourceCall(socketPath, 'events-head')
      if (!cursorOK(head?.cursor)) throw new Error('Invalid event-source cursor')
      const source = { id, bindingId: randomUUID(), socketPath, initialCursor: head.cursor, owner }
      await atomic(this.registry, { version: 1, sources: [...sources, source] })
      return source
    } finally { await lock.close(); await unlink(lockPath) }
  }
  async available(owner: Owner) { return (await this.list()).filter(s => sameOwner(s.owner, owner)) }
  async batch(source: EventSource) {
    const after = await read<number>(join(this.dir, `events-${source.bindingId}.json`), source.initialCursor)
    if (!cursorOK(after)) throw new Error('Invalid stored event cursor')
    const pending = await read<{ cursor: number; events: SourceEvent[] } | null>(join(this.dir, `events-pending-${source.bindingId}.json`), null)
    if (pending) {
      if (!cursorOK(pending.cursor) || pending.cursor < after || !validEvents(pending.events)) throw new Error('Invalid pending event batch')
      return pending
    }
    const batch = await sourceCall(source.socketPath, 'events', { after })
    if (!cursorOK(batch?.cursor) || batch.cursor < after || !validEvents(batch.events) || (batch.events.length > 0 && batch.cursor === after)) throw new Error('Invalid event batch')
    return batch as { cursor: number; events: SourceEvent[] }
  }
  async remember(source: EventSource, batch: { cursor: number; events: SourceEvent[] }) {
    await atomic(join(this.dir, `events-pending-${source.bindingId}.json`), batch)
  }
  async advance(source: EventSource, cursor: number) {
    if (!cursorOK(cursor)) throw new Error('Invalid cursor')
    await atomic(join(this.dir, `events-${source.bindingId}.json`), cursor)
    await unlink(join(this.dir, `events-pending-${source.bindingId}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  async check(origin: ExternalOrigin, owner: Owner): Promise<SourceEvent[]> {
    if (!validOrigin(origin)) throw new Error('Invalid external run origin')
    const source = (await this.available(owner)).find(s => s.id === origin.sourceId && s.bindingId === origin.bindingId)
    if (!source) return []
    const result = await sourceCall(source.socketPath, 'events-check', { ids: origin.eventIds })
    if (!validEvents(result?.events) || result.events.some((e: SourceEvent) => !origin.eventIds.includes(e.id))) throw new Error('Invalid event recheck')
    return result.events
  }
}
export const eventRunId = (source: EventSource, events: SourceEvent[]) => 'event_' + createHash('sha256')
  .update(JSON.stringify([source.bindingId, events.map(e => e.id)])).digest('hex')
export const batchReady = (events: SourceEvent[], now = Date.now()) => events.length === 0 || events.length >= 10 ||
  now - Math.max(...events.map(e => e.receivedAt)) >= 2000 || now - Math.min(...events.map(e => e.receivedAt)) >= 10000
