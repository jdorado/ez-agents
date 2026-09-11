import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type WatchStatus = 'ok' | 'failed'
export type WatchSeverity = 'warning' | 'critical'
export type WatchEvent = { at: string; status: WatchStatus; activity?: string; error?: string; runId?: string; logsHint?: string; terminal?: boolean }
type Incident = { openedAt: number; reason: 'missed-check-in' | 'terminal-failure'; notifiedAt?: number }
type Worker = { id: string; tokenHash: string; checkInMs: number; graceMs: number; severity: WatchSeverity; runbookUrl?: string; createdAt: number; lastSeenAt: number; recoveryChecks: number; history: WatchEvent[]; incident?: Incident }
type State = { version: 1; workers: Record<string, Worker> }
export type EnrollRequest = { workerId: string; checkInSeconds: number; graceSeconds: number; severity?: WatchSeverity; runbookUrl?: string }
export type CheckInRequest = { status: WatchStatus; activity?: string; error?: string; runId?: string; logsHint?: string; terminal?: boolean }
export type WorkforceWatchOptions = { stateDir: string; enrollmentToken: string; recoveryThreshold?: number; notify?: (message: string) => Promise<void>; now?: () => number; log?: (message: string) => void }

const WORKER_ID = /^[a-z][a-z0-9-]{0,63}$/
const MAX_HISTORY = 5, MAX_BODY_BYTES = 8192
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const sameSecret = (candidate: string, expectedHash: string): boolean => {
  const a = Buffer.from(hash(candidate), 'hex'), b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
const positive = (value: unknown, field: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`)
  return value as number
}
const text = (value: unknown, field: string, maximum: number): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid ${field}`)
  return value.trim()
}
const validateEnroll = (value: unknown): EnrollRequest => {
  if (!value || typeof value !== 'object') throw new Error('Invalid enrollment')
  const input = value as Record<string, unknown>, severity = input.severity === undefined ? 'critical' : input.severity
  if (typeof input.workerId !== 'string' || !WORKER_ID.test(input.workerId)) throw new Error('Invalid workerId')
  if (severity !== 'warning' && severity !== 'critical') throw new Error('Invalid severity')
  const runbookUrl = text(input.runbookUrl, 'runbookUrl', 500)
  if (runbookUrl) { let url: URL; try { url = new URL(runbookUrl) } catch { throw new Error('Invalid runbookUrl') }; if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid runbookUrl') }
  return { workerId: input.workerId, checkInSeconds: positive(input.checkInSeconds, 'checkInSeconds', 10, 86400), graceSeconds: positive(input.graceSeconds, 'graceSeconds', 0, 86400), severity, runbookUrl }
}
const validateCheckIn = (value: unknown): CheckInRequest => {
  if (!value || typeof value !== 'object') throw new Error('Invalid check-in')
  const input = value as Record<string, unknown>
  if (input.status !== 'ok' && input.status !== 'failed') throw new Error('Invalid status')
  if (input.terminal !== undefined && typeof input.terminal !== 'boolean') throw new Error('Invalid terminal')
  return { status: input.status, activity: text(input.activity, 'activity', 300), error: text(input.error, 'error', 500), runId: text(input.runId, 'runId', 120), logsHint: text(input.logsHint, 'logsHint', 500), terminal: input.terminal }
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'unknown error'

export class WorkforceWatch {
  private readonly recoveryThreshold: number
  private readonly now: () => number
  private serial: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly options: WorkforceWatchOptions) {
    if (!options.enrollmentToken.trim()) throw new Error('EZ_WATCH_ENROLL_TOKEN is required')
    this.recoveryThreshold = positive(options.recoveryThreshold ?? 2, 'recoveryThreshold', 1, 10); this.now = options.now ?? Date.now
  }
  private get stateFile(): string { return join(this.options.stateDir, 'workforce-watch.json') }
  private async state(): Promise<State> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    await chmod(this.options.stateDir, 0o700)
    try { const parsed: unknown = JSON.parse(await readFile(this.stateFile, 'utf8')); if (!parsed || typeof parsed !== 'object' || (parsed as {version?:unknown}).version !== 1 || typeof (parsed as {workers?:unknown}).workers !== 'object') throw new Error('Invalid workforce watch state'); return parsed as State }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workers: {} }; throw error }
  }
  private async save(state: State): Promise<void> { const temporary = `${this.stateFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`; await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await rename(temporary, this.stateFile) }
  private enqueue<T>(work: () => Promise<T>): Promise<T> { const result = this.serial.then(work, work); this.serial = result.then(() => undefined, () => undefined); return result }
  private latest(worker: Worker): WatchEvent | undefined { return worker.history.at(-1) }
  private format(worker: Worker, action: 'opened' | 'recovered'): string {
    const latest = this.latest(worker), lines = [`Workforce Watch ${action === 'opened' ? 'alert' : 'recovered'}: ${worker.id}`, action === 'opened' ? `Reason: ${worker.incident?.reason === 'terminal-failure' ? 'terminal failure' : 'missed check-in'}` : 'Recovery: required clean check-ins received', `Severity: ${worker.severity}`]
    if (latest?.activity) lines.push(`Last activity: ${latest.activity}`); if (latest?.error) lines.push(`Last error: ${latest.error}`); if (latest?.runId) lines.push(`Run: ${latest.runId}`); if (latest) lines.push(`Last seen: ${latest.at}`); if (latest?.logsHint) lines.push(`Next: ${latest.logsHint}`); if (worker.runbookUrl) lines.push(`Runbook: ${worker.runbookUrl}`)
    return lines.join('\n')
  }
  private async notifyOpen(state: State, worker: Worker): Promise<void> { if (!worker.incident || worker.incident.notifiedAt !== undefined || !this.options.notify) return; await this.options.notify(this.format(worker, 'opened')); worker.incident.notifiedAt = this.now(); await this.save(state) }
  async enroll(token: string, input: unknown): Promise<{workerId:string;workerToken:string}> {
    if (!sameSecret(token, hash(this.options.enrollmentToken))) throw new Error('Unauthorized')
    const request = validateEnroll(input)
    return this.enqueue(async () => { const state = await this.state(); if (state.workers[request.workerId]) throw new Error('Worker already enrolled'); const workerToken = randomBytes(32).toString('base64url'), now = this.now(); state.workers[request.workerId] = { id:request.workerId, tokenHash:hash(workerToken), checkInMs:request.checkInSeconds*1000, graceMs:request.graceSeconds*1000, severity:request.severity ?? 'critical', runbookUrl:request.runbookUrl, createdAt:now, lastSeenAt:now, recoveryChecks:0, history:[] }; await this.save(state); return {workerId:request.workerId,workerToken} })
  }
  async checkIn(workerId: string, token: string, input: unknown): Promise<{incident:boolean}> {
    if (!WORKER_ID.test(workerId)) throw new Error('Unauthorized'); const request = validateCheckIn(input)
    return this.enqueue(async () => { const state = await this.state(), worker = state.workers[workerId]; if (!worker || !sameSecret(token,worker.tokenHash)) throw new Error('Unauthorized'); const now = this.now(), event:WatchEvent={at:new Date(now).toISOString(),...request}; worker.lastSeenAt=now; worker.history=[...worker.history,event].slice(-MAX_HISTORY)
      if (request.terminal) { worker.recoveryChecks=0; worker.incident ??= {openedAt:now,reason:'terminal-failure'} }
      else if (worker.incident && request.status==='ok') { worker.recoveryChecks += 1; if (worker.recoveryChecks >= this.recoveryThreshold) { const wasNotified=worker.incident.notifiedAt !== undefined; worker.incident=undefined; worker.recoveryChecks=0; await this.save(state); if (wasNotified && this.options.notify) await this.options.notify(this.format(worker,'recovered')); return {incident:false} } }
      else if (request.status==='failed') worker.recoveryChecks=0
      await this.save(state); await this.notifyOpen(state,worker); return {incident:Boolean(worker.incident)} })
  }
  async evaluate(): Promise<void> { await this.enqueue(async () => { const state=await this.state(), now=this.now(); let changed=false; for (const worker of Object.values(state.workers)) if (!worker.incident && now > worker.lastSeenAt+worker.checkInMs+worker.graceMs) { worker.incident={openedAt:now,reason:'missed-check-in'}; worker.recoveryChecks=0; changed=true }; if(changed) await this.save(state); for(const worker of Object.values(state.workers)) await this.notifyOpen(state,worker) }) }
  async inspect(workerId?: string): Promise<unknown> { return this.enqueue(async () => { const state=await this.state(); const redact=(worker:Worker) => ({id:worker.id,checkInSeconds:worker.checkInMs/1000,graceSeconds:worker.graceMs/1000,severity:worker.severity,runbookUrl:worker.runbookUrl,createdAt:new Date(worker.createdAt).toISOString(),lastSeenAt:new Date(worker.lastSeenAt).toISOString(),incident:worker.incident&&{openedAt:new Date(worker.incident.openedAt).toISOString(),reason:worker.incident.reason,notifiedAt:worker.incident.notifiedAt&&new Date(worker.incident.notifiedAt).toISOString()},history:worker.history}); if(workerId){const worker=state.workers[workerId];if(!worker)throw new Error('Not found');return redact(worker)} return Object.values(state.workers).map(redact) }) }
  start(evaluateMs: number): void { if(this.timer)return; void this.evaluate().catch(e=>this.options.log?.(`Initial evaluation failed: ${errorText(e)}`)); this.timer=setInterval(()=>void this.evaluate().catch(e=>this.options.log?.(`Evaluation failed: ${errorText(e)}`)),evaluateMs);this.timer.unref() }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=undefined }
}

const bearer = (request:IncomingMessage): string|undefined => request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined
const json = (response:ServerResponse,status:number,value:unknown):void => { response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value)) }
const requestJson = async (request:IncomingMessage):Promise<unknown> => { let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>MAX_BODY_BYTES)throw new Error('Request too large')}try{return JSON.parse(body)}catch{throw new Error('Invalid JSON')} }
export class WorkforceWatchServer {
  private server?:Server
  constructor(private readonly watch:WorkforceWatch,private readonly enrollmentToken:string,private readonly log:(message:string)=>void=console.error) {}
  async listen(port:number,host:string):Promise<void> { if(this.server)throw new Error('Server already listening');this.server=createServer((request,response)=>void this.route(request,response));await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(port,host,resolve)}) }
  async close():Promise<void> { if(!this.server)return;await new Promise<void>((resolve,reject)=>this.server!.close(error=>error?reject(error):resolve()));this.server=undefined }
  port():number { const address=this.server?.address(); if (!address || typeof address === 'string') throw new Error('Server is not listening'); return address.port }
  private authorized(token:string|undefined):boolean { return Boolean(token)&&sameSecret(token!,hash(this.enrollmentToken)) }
  private async route(request:IncomingMessage,response:ServerResponse):Promise<void> { try { const url=new URL(request.url??'/','http://localhost');if(request.method==='GET'&&url.pathname==='/healthz')return json(response,200,{status:'ok'});if(request.method==='POST'&&url.pathname==='/v1/enroll'){const token=bearer(request);if(!this.authorized(token))return json(response,401,{error:'unauthorized'});return json(response,201,await this.watch.enroll(token!,await requestJson(request)))}if(request.method==='GET'&&(url.pathname==='/v1/workers'||/^\/v1\/workers\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname))){if(!this.authorized(bearer(request)))return json(response,401,{error:'unauthorized'});return json(response,200,await this.watch.inspect(url.pathname==='/v1/workers'?undefined:url.pathname.slice(12)))}const match=request.method==='POST'&&url.pathname.match(/^\/v1\/workers\/([a-z][a-z0-9-]{0,63})\/check-in$/);if(match){try{return json(response,200,await this.watch.checkIn(match[1],bearer(request)??'',await requestJson(request)))}catch(error){if(errorText(error)==='Unauthorized')return json(response,401,{error:'unauthorized'});throw error}}return json(response,404,{error:'not found'}) }catch(error){this.log(`Workforce Watch request failed: ${errorText(error)}`);return json(response,400,{error:'invalid request'})} }
}
