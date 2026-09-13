import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ControlStore, type Owner } from './control-state.js'
import { RunStore, type RunRecord, type OutboxItem } from './runs.js'
import { ownsRun } from './identity.js'
import { applicationId, validApplicationOrigin } from './application-origin.js'
import type { AiPreset } from './ai.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sameOwner = (left: Owner, right: Owner | null) => !!right && left.telegramUserId === right.telegramUserId && left.telegramChatId === right.telegramChatId && left.pairedAt === right.pairedAt
export const applicationScope = (bindingId: string, scope: string) => hash(JSON.stringify([bindingId, scope]))
type Binding = { id: string; bindingId: string; tokenHash: string; owner: Owner }

export class ApplicationBindings {
  constructor(private controlDir: string) {}
  async list(): Promise<Binding[]> {
    try {
      const bindings = JSON.parse(await readFile(join(this.controlDir, 'application-bindings.json'), 'utf8'))
      if (!Array.isArray(bindings) || bindings.some(binding => !applicationId(binding?.id) || !/^[a-f0-9-]{36}$/.test(binding.bindingId) || !/^[a-f0-9]{64}$/.test(binding.tokenHash) || !Number.isSafeInteger(binding.owner?.telegramUserId) || !Number.isSafeInteger(binding.owner?.telegramChatId) || typeof binding.owner?.pairedAt !== 'string')) throw new Error('Invalid application binding state')
      return bindings
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async register(id: string, token: string | null, owner: Owner): Promise<Binding | undefined> {
    if (!applicationId(id) || (token !== null && !/^[A-Za-z0-9_-]{43,200}$/.test(token))) throw new Error('Use a simple application ID and a random token of at least 256 bits encoded as base64url')
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 })
    const file = join(this.controlDir, 'application-bindings.json')
    const lock = await open(`${file}.lock`, 'wx', 0o600)
    try {
      const bindings = await this.list()
      const existing = bindings.find(binding => binding.id === id)
      if (token !== null && existing) throw new Error('Application already registered; revoke before replacing its authority')
      const binding = token === null ? undefined : { id, bindingId: randomUUID(), tokenHash: hash(token), owner }
      const next = [...bindings.filter(item => item.id !== id), ...(binding ? [binding] : [])]
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
      await rename(temporary, file)
      return binding
    } finally { await lock.close(); await unlink(`${file}.lock`) }
  }
  async authenticate(token: string): Promise<Binding> {
    if (!/^[A-Za-z0-9_-]{43,200}$/.test(token)) throw new Error('Unauthorized application')
    const fingerprint = Buffer.from(hash(token), 'hex')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const binding = (await this.list()).find(item => timingSafeEqual(fingerprint, Buffer.from(item.tokenHash, 'hex')) && sameOwner(item.owner, owner))
    if (!binding) throw new Error('Unauthorized application')
    return binding
  }
  async authorize(run: RunRecord): Promise<void> {
    if (!validApplicationOrigin(run.application)) throw new Error('Invalid application origin')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const binding = (await this.list()).find(item => item.bindingId === run.application!.bindingId)
    if (!binding || !sameOwner(binding.owner, owner) || !ownsRun(owner, run)) throw new Error('Application authority revoked')
  }
}

export class ApplicationChannel {
  private server?: Server
  private admissions = Promise.resolve()
  readonly bindings: ApplicationBindings
  constructor(private options: {
    controlDir: string; initial: AiPreset
    wake: () => void
    cancel: (id: string) => Promise<void>
  }) { this.bindings = new ApplicationBindings(options.controlDir) }
  private get runs() { return new RunStore(this.options.controlDir) }
  async submit(bindingId: string, input: unknown): Promise<RunRecord> {
    const work = this.admissions.then(async () => {
      const value = input as { requestId?: unknown; scope?: unknown; text?: unknown; context?: Record<string, unknown> }
      if (!value || !applicationId(value.requestId) || !applicationId(value.scope) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000 || Object.keys(value).some(key => !['requestId','scope','text','context'].includes(key))) throw new Error('Invalid application request')
      const application = { bindingId, requestId: value.requestId, scope: value.scope, ...(value.context === undefined ? {} : { context: value.context }) }
      if (!validApplicationOrigin(application)) throw new Error('Invalid application context')
      const binding = (await this.bindings.list()).find(item => item.bindingId === bindingId)
      if (!binding) throw new Error('Application authority revoked')
      const id = `r_app_${hash(JSON.stringify([bindingId, value.requestId]))}`
      const existing = await this.runs.get(id)
      if (existing) {
        await this.bindings.authorize(existing)
        if (existing.application?.scope !== value.scope || existing.texts[0] !== value.text) throw new Error('Application request ID conflicts with prior scope or text')
        return existing // Retried context never replaces already admitted capabilities.
      }
      const control = new ControlStore(this.options.controlDir, 900000)
      if (!sameOwner(binding.owner, (await control.status()).owner)) throw new Error('Application authority revoked')
      const execution = await control.captureApplicationChoice(this.options.initial, applicationScope(bindingId, value.scope))
      const run = await this.runs.create({ id, chatId: binding.owner.telegramChatId, telegramUserId: binding.owner.telegramUserId, texts: [value.text], execution, application })
      this.options.wake()
      return run
    })
    this.admissions = work.then(() => {}, () => {})
    return work
  }
  async snapshot(bindingId: string, id: string) {
    const run = await this.runs.get(id)
    if (!run || run.application?.bindingId !== bindingId) throw new Error('Unknown application run')
    await this.bindings.authorize(run)
    return { id: run.id, scope: run.application.scope, status: run.status, messages: await this.runs.applicationMessages(run.id), ...(run.status === 'failed' ? { error: 'Agent execution failed; inspect the core run' } : {}) }
  }
  async deliver(run: RunRecord, item: OutboxItem): Promise<void> {
    await this.bindings.authorize(run)
    if (item.type && item.type !== 'message') throw new Error('Application channel supports text messages only')
    await this.runs.markOutboxSent(item.id)
  }
  private async route(request: IncomingMessage, response: ServerResponse) {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
    let binding: Binding
    try { binding = await this.bindings.authenticate(request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '') }
    catch { send(401, { error: 'Unauthorized application' }); return }
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (request.method === 'POST' && path === '/v1/runs') {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Application request too large'); chunks.push(chunk) }
        const run = await this.submit(binding.bindingId, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        send(202, await this.snapshot(binding.bindingId, run.id)); return
      }
      const match = path.match(/^\/v1\/runs\/(r_app_[a-f0-9]{64})(\/cancel)?$/)
      if (match && ((!match[2] && request.method === 'GET') || (match[2] && request.method === 'POST'))) {
        await this.snapshot(binding.bindingId, match[1])
        if (match[2]) await this.options.cancel(match[1])
        send(200, await this.snapshot(binding.bindingId, match[1])); return
      }
      send(404, { error: 'Unknown application endpoint' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid application request'
      send(message.includes('conflicts') ? 409 : message === 'Unknown application run' ? 404 : 400, { error: /^(Invalid application|Application request|Application authority|Unknown application)/.test(message) ? message : 'Invalid application request' })
    }
  }
  async listen(port: number, host = '127.0.0.1') {
    this.server = createServer((request, response) => { void this.route(request, response) })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, host, resolve) })
    return this.server.address()
  }
  async stop() { await new Promise<void>((resolve, reject) => this.server ? this.server.close(error => error ? reject(error) : resolve()) : resolve()) }
}
