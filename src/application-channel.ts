import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ControlStore, type Owner, sameOwner, validOwner, ownerId, ownerEpoch } from './control-state.js'
import { RunStore, type RunRecord, type OutboxItem } from './runs.js'
import { ownsRun } from './identity.js'
import { applicationId, validApplicationOrigin } from './application-origin.js'
import { isPreset, type AiPreset } from './ai.js'
import { assertEffort } from './model-policy.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const applicationScope = (bindingId: string, scope: string) => hash(JSON.stringify([bindingId, scope]))
type Binding = { id: string; bindingId: string; tokenHash: string; owner: Owner; shareTelegram?: boolean }

export function validateApplicationRegistration(id: string, token: string | null): void {
  if (!applicationId(id) || (token !== null && !/^[A-Za-z0-9_-]{43,200}$/.test(token))) throw new Error('Use a simple application ID and a random token of at least 256 bits encoded as base64url')
}

export class ApplicationBindings {
  constructor(private controlDir: string) {}
  async list(): Promise<Binding[]> {
    try {
      const bindings = JSON.parse(await readFile(join(this.controlDir, 'application-bindings.json'), 'utf8'))
      if (!Array.isArray(bindings) || bindings.some(binding => !applicationId(binding?.id) || !/^[a-f0-9-]{36}$/.test(binding.bindingId) || !/^[a-f0-9]{64}$/.test(binding.tokenHash) || !validOwner(binding.owner) || (binding.shareTelegram !== undefined && typeof binding.shareTelegram !== 'boolean')) || ['tokenHash','id','bindingId'].some(key => new Set(bindings.map(b => b[key])).size !== bindings.length)) throw new Error('Invalid application binding state')
      return bindings
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async register(id: string, token: string | null, owner: Owner, shareTelegram = false, rotate = false): Promise<Binding | undefined> {
    validateApplicationRegistration(id, token)
    await mkdir(this.controlDir, { recursive: true, mode: 0o700 })
    const file = join(this.controlDir, 'application-bindings.json')
    const lock = await open(`${file}.lock`, 'wx', 0o600)
    try {
      const bindings = await this.list()
      const existing = bindings.find(binding => binding.id === id)
      if (!sameOwner(owner, (await new ControlStore(this.controlDir, 900000).status()).owner)) throw new Error('Application authority revoked')
      if (rotate && (!existing || !token || !sameOwner(existing.owner, owner))) throw new Error('Rotation requires a current binding and new token')
      if (token && bindings.some(item => item.id !== id && item.tokenHash === hash(token))) throw new Error('Application credential already registered')
      if (token !== null && existing && !rotate) throw new Error('Application already registered; rotate its token or revoke before replacing its authority')
      const binding = token === null ? undefined : rotate ? {...existing!, tokenHash: hash(token)} : { id, bindingId: randomUUID(), tokenHash: hash(token), owner, ...(shareTelegram ? { shareTelegram: true } : {}) }
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
    const origin = run.application ?? run.delivery
    if (!origin || !validApplicationOrigin({...origin, requestId: run.application?.requestId ?? run.id})) throw new Error('Invalid application origin')
    const owner = (await new ControlStore(this.controlDir, 900000).status()).owner
    const binding = (await this.list()).find(item => item.bindingId === origin.bindingId)
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
      // Channel-neutral name for the existing shared owner conversation option.
      if (input && typeof input === 'object' && 'followOwner' in input) {
        const {followOwner, ...rest} = input as Record<string, unknown>
        if ('followTelegram' in rest) throw new Error('Invalid application request: choose one conversation option')
        input = {...rest, followTelegram: followOwner}
      }
      const value = input as { requestId?: unknown; scope?: unknown; text?: unknown; context?: Record<string, unknown>; expectedNativeSessionId?: unknown; activateTelegram?: unknown; followTelegram?: unknown; ai?: { cli?: unknown; model?: unknown; effort?: unknown } }
      if (!value || !applicationId(value.requestId) || !applicationId(value.scope) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000 || Object.keys(value).some(key => !['requestId','scope','text','context','expectedNativeSessionId','activateTelegram','followTelegram','ai'].includes(key))) throw new Error('Invalid application request')
      if (value.expectedNativeSessionId !== undefined && (typeof value.expectedNativeSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.expectedNativeSessionId))) throw new Error('Invalid application native session assertion')
      if (value.activateTelegram !== undefined && typeof value.activateTelegram !== 'boolean') throw new Error('Invalid application Telegram activation')
      if (value.followTelegram !== undefined && typeof value.followTelegram !== 'boolean') throw new Error('Invalid application Telegram following')
      if (value.followTelegram && (value.activateTelegram || value.ai !== undefined || value.expectedNativeSessionId !== undefined)) throw new Error('Invalid application request: following Telegram uses its current conversation and AI')
      let requestedPreset: AiPreset | undefined
      if (value.ai !== undefined) {
        const candidate = { ...value.ai, id: 'application', name: 'Application selection' }
        if (!value.ai || Object.keys(value.ai).some(key => !['cli', 'model', 'effort'].includes(key)) || !isPreset(candidate)) throw new Error('Invalid application AI selection')
        assertEffort(candidate.effort, candidate.model, candidate.cli)
        requestedPreset = candidate
      }
      const application = { bindingId, requestId: value.requestId, scope: value.scope, ...(value.followTelegram ? { followTelegram: true } : {}), ...(value.context === undefined ? {} : { context: value.context }) }
      if (!validApplicationOrigin(application)) throw new Error('Invalid application context')
      const binding = (await this.bindings.list()).find(item => item.bindingId === bindingId)
      if (!binding) throw new Error('Application authority revoked')
      if (value.followTelegram && !binding.shareTelegram) throw new Error('Application authority does not permit following Telegram')
      const id = `r_app_${hash(JSON.stringify([bindingId, value.requestId]))}`
      const existing = await this.runs.get(id)
      if (existing) {
        await this.bindings.authorize(existing)
        if (requestedPreset && (existing.execution?.preset.cli !== requestedPreset.cli || existing.execution?.preset.model !== requestedPreset.model || existing.execution?.preset.effort !== requestedPreset.effort)) throw new Error('Application request ID conflicts with prior AI selection')
        if (Boolean(existing.application?.followTelegram) !== Boolean(value.followTelegram) || existing.application?.scope !== value.scope || existing.texts[0] !== value.text) throw new Error('Application request ID conflicts with prior scope or text')
        return existing // Retried context never replaces already admitted capabilities.
      }
      const control = new ControlStore(this.options.controlDir, 900000)
      if (!sameOwner(binding.owner, (await control.status()).owner)) throw new Error('Application authority revoked')
      const execution = value.followTelegram ? await control.captureChoice(this.options.initial) : await control.captureApplicationChoice(this.options.initial, applicationScope(bindingId, value.scope), binding.shareTelegram === true && value.activateTelegram === true, requestedPreset, value.expectedNativeSessionId as string | undefined)
      const run = await this.runs.create({ id, ownerId: ownerId(binding.owner), ownerEpoch: ownerEpoch(binding.owner), texts: [value.text], execution, application })
      this.options.wake()
      return run
    })
    this.admissions = work.then(() => {}, () => {})
    return work
  }
  async snapshot(bindingId: string, id: string) {
    const run = await this.runs.get(id)
    if (!run || (run.application ?? run.delivery)?.bindingId !== bindingId) throw new Error('Unknown application run')
    await this.bindings.authorize(run)
    const state = await new ControlStore(this.options.controlDir, 900000).status()
    const session = state.activeSession?.sessionId === run.execution?.sessionId ? state.activeSession : state.sessions?.find(item => item.sessionId === run.execution?.sessionId)
    return { ...(session ? { sessionId: session.sessionId, nativeSessionId: session.nativeSessionId, cli: session.cli } : {}), ...(run.scheduled?.originRunId ? {originRunId:run.scheduled.originRunId} : {}), id: run.id, scope: (run.application ?? run.delivery)!.scope, status: run.status, messages: await this.runs.applicationMessages(run.id), ...(run.status === 'failed' ? { error: 'Agent execution failed; inspect the core run' } : {}) }
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
    let admissionId: string | undefined
    try {
      const url = new URL(request.url ?? '/', 'http://localhost'), path = url.pathname
      if (request.method === 'GET' && path === '/v1/registration') {
        send(200, {ownerId: ownerId(binding.owner), bindingId: binding.bindingId, channel: binding.id}); return
      }
      if (request.method === 'GET' && path === '/v1/runs') {
        const all = (await this.runs.list()).filter(run => (run.application ?? run.delivery)?.bindingId === binding.bindingId)
        const before = url.searchParams.get('before')
        const end = before ? all.findIndex(run => run.id === before) : all.length
        if (end < 0) throw new Error('Invalid application inbox cursor')
        const records = all.slice(Math.max(0,end-100),end)
        send(200, {runs: await Promise.all(records.map(run => this.snapshot(binding.bindingId, run.id))), nextCursor:end>100?records[0].id:null}); return
      }
      if (request.method === 'POST' && path === '/v1/runs') {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Application request too large'); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (applicationId(input?.requestId)) admissionId = `r_app_${hash(JSON.stringify([binding.bindingId, input.requestId]))}`
        const run = await this.submit(binding.bindingId, input)
        send(202, await this.snapshot(binding.bindingId, run.id)); return
      }
      const match = path.match(/^\/v1\/runs\/(r_(?:app|schedule)_[a-f0-9]{64})(\/cancel)?$/)
      if (match && ((!match[2] && request.method === 'GET') || (match[2] && request.method === 'POST'))) {
        await this.snapshot(binding.bindingId, match[1])
        if (match[2]) await this.options.cancel(match[1])
        send(200, await this.snapshot(binding.bindingId, match[1])); return
      }
      send(404, { error: 'Unknown application endpoint' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid application request'
      let admission: { admitted: boolean; runId?: string } | undefined
      if (admissionId) {
        try { const existing = await this.runs.get(admissionId); admission = { admitted: !!existing, ...(existing ? { runId: existing.id } : {}) } } catch { /* Unreadable state is not proof of non-admission. */ }
      }
      send(message.includes('conflicts') ? 409 : message === 'Unknown application run' ? 404 : 400, { ...admission, error: /^(Invalid application|Application request|Application authority|Unknown application)/.test(message) ? message : 'Invalid application request' })
    }
  }
  async listen(port: number, host = '127.0.0.1') {
    this.server = createServer((request, response) => { void this.route(request, response) })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, host, resolve) })
    return this.server.address()
  }
  async stop() { await new Promise<void>((resolve, reject) => this.server ? this.server.close(error => error ? reject(error) : resolve()) : resolve()) }
}
