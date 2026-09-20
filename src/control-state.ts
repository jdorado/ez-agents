import { assertEffort } from './model-policy.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPreset, persistedPreset, type AiPreset, type ExecutionChoice } from './ai.js'

export type Owner = {
  id?: string
  generation?: string
  kind?: 'group'
  telegramUserId?: number
  telegramChatId?: number
  telegramLinkedAt?: string
  pairedAt: string
}

export type TelegramOwner = Owner & { telegramUserId: number; telegramChatId: number }
export const telegramOwner = (owner: Owner | null): TelegramOwner | null =>
  owner && Number.isSafeInteger(owner.telegramUserId) && Number.isSafeInteger(owner.telegramChatId) ? owner as TelegramOwner : null
export const ownerId = (owner: Owner): string => owner.id ?? `telegram:${owner.telegramUserId}:${owner.telegramChatId}`
export const ownerEpoch = (owner: Owner): string => owner.generation ?? owner.pairedAt
export const sameOwner = (left: Owner, right: Owner | null): boolean =>
  !!right && ownerId(left) === ownerId(right) && ownerEpoch(left) === ownerEpoch(right)
export const validOwner = (owner: unknown): owner is Owner => {
  if (!owner || typeof owner !== 'object') return false
  const p = owner as Owner
  const linked = p.telegramUserId !== undefined || p.telegramChatId !== undefined
  return typeof p.pairedAt === 'string' && Number.isFinite(Date.parse(p.pairedAt)) &&
    (p.generation === undefined || typeof p.generation === 'string' && /^[a-f0-9-]{36}$/.test(p.generation)) &&
    (p.telegramLinkedAt === undefined || typeof p.telegramLinkedAt === 'string') &&
    (p.id === undefined ? linked : typeof p.id === 'string' && /^[a-zA-Z0-9_:.-]{1,200}$/.test(p.id)) &&
    (!linked ? p.kind === undefined : Number.isSafeInteger(p.telegramUserId) && p.telegramUserId! > 0 &&
      Number.isSafeInteger(p.telegramChatId) && (p.kind === 'group' ? p.telegramChatId! < 0 : p.kind === undefined && p.telegramChatId! > 0))
}

type TelegramPairingRequest = {
  kind?: 'group'
  title?: string
  telegramUserId: number
  telegramChatId: number
  requestedAt: string
  expiresAt: string
}

type ApplicationPairingRequest = {
  application: {
    bindingId: string
    tokenHash: string
    owner: Owner
  }
  requestedAt: string
  expiresAt: string
}

export type PairingRequest = TelegramPairingRequest | ApplicationPairingRequest

export type SessionState = {
  sessionId: string
  hasStarted: boolean
  cli?: string
  nativeSessionId?: string
  title?: string
  archived?: boolean
  preset?: AiPreset
  applicationScope?: string
  telegramShared?: boolean
}

export type ControlGuard = { owner: Owner; authorize: () => Promise<unknown>; expectedSession?: string | null; applicationScope?: string }

type ControlState = {
  version: 1
  owner: Owner | null
  pending: PairingRequest[]
  activeSession?: SessionState | null
  ai?: { presets: AiPreset[]; defaultId: string; selectedId: string; recentIds?: string[] }
  sessions?: SessionState[]
}

type Clock = () => number

const emptyState = (): ControlState => ({ version: 1, owner: null, pending: [] })

const isPositiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const applicationPairing = (request: PairingRequest): request is ApplicationPairingRequest =>
  'application' in request

const telegramPairing = (request: PairingRequest): request is TelegramPairingRequest =>
  !applicationPairing(request)

const applicationBindingId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)

const pairingToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

const pairingDigest = (value: string): string => createHash('sha256').update(value).digest('hex')

const isRecentIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 3 && new Set(value).size === value.length &&
  value.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(id))

const isState = (value: unknown): value is ControlState => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ControlState>
  const telegramIdentity = (person: unknown): boolean => {
    if (!person || typeof person !== 'object') return false
    const p = person as Owner
    return isPositiveId(p.telegramUserId) && (p.kind === 'group'
      ? Number.isSafeInteger(p.telegramChatId) && p.telegramChatId! < 0
      : p.kind === undefined && isPositiveId(p.telegramChatId))
  }
  const pairing = (request: unknown): request is PairingRequest => {
    if (!request || typeof request !== 'object') return false
    const value = request as Partial<ApplicationPairingRequest & TelegramPairingRequest>
    if (!Number.isFinite(Date.parse(value.expiresAt ?? '')) || !Number.isFinite(Date.parse(value.requestedAt ?? '')))
      return false
    if (value.application !== undefined) {
      const application = value.application
      return Object.keys(value).every((key) => ['application', 'requestedAt', 'expiresAt'].includes(key)) &&
        !!application && applicationBindingId(application.bindingId) && /^[a-f0-9]{64}$/.test(application.tokenHash) && validOwner(application.owner)
    }
    return telegramIdentity(value)
  }
  const session = (s: SessionState) => s && /^[0-9a-f-]{36}$/i.test(s.sessionId) && typeof s.hasStarted === 'boolean' &&
    (s.title === undefined || (typeof s.title === 'string' && s.title.length <= 80)) &&
    (s.archived === undefined || typeof s.archived === 'boolean') &&
    (s.applicationScope === undefined || /^[a-f0-9]{64}$/.test(s.applicationScope)) &&
    (s.telegramShared === undefined || typeof s.telegramShared === 'boolean') &&
    (s.preset === undefined || (isPreset(s.preset) && s.preset.cli === s.cli))
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.pending) &&
    candidate.pending.every(pairing) &&
    (candidate.owner === null || validOwner(candidate.owner)) &&
    (candidate.ai === undefined || (Array.isArray(candidate.ai.presets) &&
      candidate.ai.presets.every(isPreset) &&
      candidate.ai.presets.some((p) => p.id === candidate.ai!.defaultId) &&
      candidate.ai.presets.some((p) => p.id === candidate.ai!.selectedId) &&
      (candidate.ai.recentIds === undefined || isRecentIds(candidate.ai.recentIds)))) &&
    (candidate.sessions === undefined || (Array.isArray(candidate.sessions) && candidate.sessions.every(
      session))) &&
    (candidate.activeSession == null ||
      session(candidate.activeSession))
  )
}

export const sessionTitle = (session: SessionState): string =>
  session.title || `Conversation ${session.sessionId.slice(0, 8)}`

const rememberPreset = (state: ControlState) => {
  const preset = state.ai?.presets.find(p => p.id === state.ai!.selectedId)
  if (state.activeSession && preset && state.activeSession.cli === preset.cli)
    state.activeSession.preset = preset
}

const currentApplicationSession = (state: ControlState, scope: string) =>
  [state.activeSession, ...(state.sessions ?? [])].find(session => session?.applicationScope === scope && !session.archived)

const requireControlGuard = async (state: ControlState, guard?: ControlGuard) => {
  if (!guard) return
  // The callback may inspect binding authority, but must not acquire this store's lock.
  await guard.authorize()
  const expected = guard.owner
  if (!sameOwner(expected, state.owner)) throw new Error('Control owner changed. Refresh the connection.')
  const current = guard.applicationScope ? currentApplicationSession(state, guard.applicationScope) : state.activeSession
  if (guard.applicationScope && current && (current.telegramShared || current === state.activeSession))
    throw new Error('Application scope is shared; use shared controls')
  if (guard.expectedSession !== undefined && (current?.sessionId ?? null) !== guard.expectedSession) throw new Error('Conversation changed. Refresh controls before trying again.')
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export class ControlStore {
  private readonly statePath: string
  private readonly lockPath: string

  constructor(
    controlDir: string,
    private readonly pairingTtlMs: number,
    private readonly clock: Clock = () => Date.now(),
  ) {
    this.statePath = path.join(controlDir, 'control-state.json')
    this.lockPath = path.join(controlDir, 'control-state.lock')
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 })
  }

  private async readState(): Promise<ControlState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!isState(parsed)) throw new Error('Control state has an unsupported shape')
      if (parsed.ai) {
        parsed.ai.presets = parsed.ai.presets.map(persistedPreset)
        parsed.ai.recentIds = (parsed.ai.recentIds ?? [parsed.ai.selectedId])
          .filter((id) => parsed.ai!.presets.some((preset) => preset.id === id))
          .slice(0, 3)
      }
      return parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  private async writeState(state: ControlState): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.statePath)
  }

  private prune(state: ControlState): ControlState {
    const now = this.clock()
    return { ...state, pending: state.pending.filter((request) => Date.parse(request.expiresAt) > now) }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        try {
          return await work()
        } finally {
          await handle.close()
          await rm(this.lockPath, { force: true })
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await wait(25)
      }
    }
    throw new Error('Timed out waiting for the authority control lock')
  }

  async status(): Promise<ControlState> {
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      await this.writeState(state)
      return state
    })
  }

  async requestPairing(
    telegramUserId: number,
    telegramChatId: number,
    groupTitle?: string,
  ): Promise<'requested' | 'pending' | 'capacity' | 'owner-exists'> {
    if (!isPositiveId(telegramUserId) || !(groupTitle !== undefined
      ? Number.isSafeInteger(telegramChatId) && telegramChatId < 0
      : isPositiveId(telegramChatId)))
      throw new Error('Telegram identity must be a positive numeric ID')
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      if (telegramOwner(state.owner)) return 'owner-exists'
      if (
        state.pending.some(
          (request) => telegramPairing(request) && request.telegramUserId === telegramUserId && request.telegramChatId === telegramChatId,
        )
      ) {
        await this.writeState(state)
        return 'pending'
      }
      if (state.pending.length >= 3) return 'capacity'
      const now = this.clock()
      state.pending.push({
        ...(groupTitle !== undefined ? {kind: 'group' as const, title: groupTitle.slice(0, 256)} : {}),
        telegramUserId,
        telegramChatId,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.pairingTtlMs).toISOString(),
      })
      await this.writeState(state)
      return 'requested'
    })
  }

  async bootstrapApplicationOwner(operatorId: number): Promise<Owner> {
    if (!isPositiveId(operatorId)) throw new Error('Supply the real administrator Telegram user ID')
    return this.withLock(async () => {
      const state = await this.readState()
      if (state.owner) throw new Error('An owner already exists; application bootstrap cannot replace it')
      const owner: Owner = { generation: crypto.randomUUID(), telegramUserId: operatorId, telegramChatId: operatorId, pairedAt: new Date(this.clock()).toISOString() }
      state.owner = owner
      state.pending = []
      await this.writeState(state)
      return owner
    })
  }

  async registerOwner(id: string): Promise<Owner> {
    if (!/^[a-zA-Z0-9_:.-]{1,200}$/.test(id)) throw new Error('Invalid owner ID')
    return this.withLock(async () => {
      const state = await this.readState()
      if (state.owner) {
        if (ownerId(state.owner) !== id) throw new Error('Installation already has a different owner')
        return state.owner
      }
      const bindings = await readFile(path.join(path.dirname(this.statePath), 'application-bindings.json'), 'utf8')
        .then(text => JSON.parse(text), error => { if (error.code === 'ENOENT') return []; throw error })
      if (!Array.isArray(bindings) || bindings.some(binding => !validOwner(binding?.owner)) || state.activeSession || state.sessions?.length)
        throw new Error('Existing unowned state requires explicit ownership recovery')
      state.owner = {id, generation: crypto.randomUUID(), pairedAt: new Date(this.clock()).toISOString()}
      await this.writeState(state)
      return state.owner
    })
  }

  async unlinkTelegram(): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.owner) throw new Error('No installation owner')
      state.owner = {id: ownerId(state.owner), generation: state.owner.generation, pairedAt: state.owner.pairedAt}
      state.pending = []
      await this.writeState(state)
    })
  }

  async createApplicationTelegramPairing(bindingId: string, expectedOwner: Owner): Promise<{ token: string; expiresAt: string } | null> {
    if (!applicationBindingId(bindingId) || !validOwner(expectedOwner)) throw new Error('Invalid application Telegram pairing request')
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      if (!sameOwner(expectedOwner, state.owner)) throw new Error('Application authority revoked')
      if (telegramOwner(state.owner)) {
        await this.writeState(state)
        return null
      }
      const retained = state.pending.filter((request) => !applicationPairing(request) || request.application.bindingId !== bindingId)
      if (retained.length >= 3) throw new Error('Telegram pairing capacity reached')
      const token = randomBytes(32).toString('base64url')
      const now = this.clock()
      const expiresAt = new Date(now + this.pairingTtlMs).toISOString()
      state.pending = [...retained, {
        application: { bindingId, tokenHash: pairingDigest(token), owner: expectedOwner },
        requestedAt: new Date(now).toISOString(),
        expiresAt,
      }]
      await this.writeState(state)
      return { token, expiresAt }
    })
  }

  async claimApplicationTelegramPairing(
    token: string,
    telegramUserId: number,
    telegramChatId: number,
    authorize: (bindingId: string, owner: Owner) => Promise<boolean>,
  ): Promise<Owner | null> {
    if (!pairingToken(token) || !isPositiveId(telegramUserId) || !isPositiveId(telegramChatId)) return null
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      const request = state.pending.find((candidate): candidate is ApplicationPairingRequest =>
        applicationPairing(candidate) && /^[a-f0-9]{64}$/.test(candidate.application.tokenHash) &&
        timingSafeEqual(Buffer.from(candidate.application.tokenHash, 'hex'), Buffer.from(pairingDigest(token), 'hex')))
      if (!request || telegramOwner(state.owner) || !sameOwner(request.application.owner, state.owner)) {
        if (request) state.pending = state.pending.filter((candidate) => candidate !== request)
        await this.writeState(state)
        return null
      }
      if (!await authorize(request.application.bindingId, request.application.owner)) {
        state.pending = state.pending.filter((candidate) => candidate !== request)
        await this.writeState(state)
        return null
      }
      const owner: Owner = {
        id: ownerId(state.owner!),
        generation: state.owner!.generation,
        telegramUserId,
        telegramChatId,
        telegramLinkedAt: crypto.randomUUID(),
        pairedAt: state.owner!.pairedAt,
      }
      state.owner = owner
      state.pending = []
      await this.writeState(state)
      return owner
    })
  }

  async approveOwner(telegramUserId: number, group = false): Promise<Owner> {
    if (!(group ? Number.isSafeInteger(telegramUserId) && telegramUserId < 0 : isPositiveId(telegramUserId))) throw new Error('Supply a positive user ID or negative group ID')
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      if (telegramOwner(state.owner)) throw new Error('An owner is already paired; unlink locally before replacing its Telegram channel')
      const request = state.pending.find((candidate): candidate is TelegramPairingRequest => telegramPairing(candidate) && (group
        ? candidate.kind === 'group' && candidate.telegramChatId === telegramUserId
        : candidate.kind === undefined && candidate.telegramUserId === telegramUserId))
      if (!request) throw new Error('No active pairing request exists for that Telegram user ID')
      const owner: Owner = {
        generation: state.owner ? state.owner.generation : crypto.randomUUID(),
        ...(state.owner ? {id: ownerId(state.owner), telegramLinkedAt: crypto.randomUUID()} : {}),
        ...(group ? {kind: 'group' as const} : {}),
        telegramUserId: request.telegramUserId,
        telegramChatId: request.telegramChatId,
        pairedAt: state.owner?.pairedAt ?? new Date(this.clock()).toISOString(),
      }
      state.owner = owner
      state.pending = []
      await this.writeState(state)
      return owner
    })
  }

  async revokeOwner(): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      const hadOwner = Boolean(state.owner)
      state.owner = null
      state.pending = []
      state.activeSession = null
      state.ai = undefined
      state.sessions = undefined
      await this.writeState(state)
      return hadOwner
    })
  }

  async getActiveSession(): Promise<SessionState | null> {
    return this.withLock(async () => {
      const state = await this.readState()
      return state.activeSession ?? null
    })
  }

  async ensureActiveSession(): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
      if (state.activeSession) return state.activeSession
      const activeSession: SessionState = {
        sessionId: crypto.randomUUID(),
        hasStarted: false,
      }
      state.activeSession = activeSession
      await this.writeState(state)
      return activeSession
    })
  }

  async markSessionStarted(sessionId: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState()
      const session = state.activeSession?.sessionId === sessionId ? state.activeSession
        : state.sessions?.find((s) => s.sessionId === sessionId)
      if (session) {
        session.hasStarted = true
        await this.writeState(state)
      }
    })
  }

  async listSessions(): Promise<SessionState[]> {
    const state = await this.status()
    return [...(state.activeSession ? [state.activeSession] : []), ...(state.sessions ?? []).filter(session => !session.applicationScope || session.telegramShared).slice().reverse()]
  }

  async switchSession(sessionId: string, expectedSession?: string | null, guard?: ControlGuard): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
      await requireControlGuard(state, guard)
      if (expectedSession !== undefined && (state.activeSession?.sessionId ?? null) !== expectedSession) throw new Error('Conversation changed. Refresh controls before trying again.')
      if (state.activeSession?.sessionId === sessionId) return state.activeSession
      const session = state.sessions?.find(s => s.sessionId === sessionId)
      if (!session || session.archived || (session.applicationScope && !session.telegramShared)) throw new Error('Conversation unavailable. Open /chats again.')
      if (session.cli === 'agy')
        throw new Error('Antigravity only resumes its latest conversation; selecting an older session is not supported.')
      const ai = state.ai
      // Older sessions did not record their model. Reuse a known preset for the
      // same CLI; never resume an engine ID through a different client.
      const preset = session.preset ?? ai?.presets.find(p => p.cli === session.cli)
      if (!ai || !preset || preset.cli !== session.cli)
        throw new Error('This older conversation has no saved AI binding. Start a new conversation.')
      if (session.hasStarted && ['codex', 'codex-gui', 'opencode'].includes(session.cli!) && !session.nativeSessionId)
        throw new Error('This conversation has no native session ID. Start a new conversation.')
      assertEffort(preset.effort, preset.model, preset.cli)
      rememberPreset(state)
      state.sessions = state.sessions!.filter(s => s.sessionId !== sessionId)
      if (state.activeSession) state.sessions.push(state.activeSession)
      state.activeSession = session
      ai.presets = [...ai.presets.filter(p => p.id !== preset.id), persistedPreset(preset)]
      ai.selectedId = preset.id
      await this.writeState(state)
      return session
    })
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState()
      const session = state.activeSession?.sessionId === sessionId ? state.activeSession
        : state.sessions?.find(s => s.sessionId === sessionId)
      if (!session) throw new Error('Conversation unavailable. Open /chats again.')
      if (archived && state.activeSession === session) {
        rememberPreset(state)
        state.sessions ??= []
        state.sessions.push(session)
        state.activeSession = null
        if (state.ai) state.ai.selectedId = state.ai.defaultId
      }
      session.archived = archived
      await this.writeState(state)
    })
  }

  async renameSession(title: string): Promise<void> {
    title = title.replace(/\s+/g, ' ').trim()
    if (!title || title.length > 80) throw new Error('Use /rename followed by a name of 1–80 characters.')
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.activeSession) throw new Error('Open a conversation first with /chats or /new.')
      state.activeSession.title = title
      await this.writeState(state)
    })
  }

  async resetSession(expectedSession?: string | null, guard?: ControlGuard): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
      await requireControlGuard(state, guard)
      if (expectedSession !== undefined && (state.activeSession?.sessionId ?? null) !== expectedSession) throw new Error('Conversation changed. Refresh controls before trying again.')
      const next: SessionState = {
        sessionId: crypto.randomUUID(),
        hasStarted: false,
        cli: state.ai?.presets.find((p) => p.id === state.ai!.defaultId)?.cli,
      }
      rememberPreset(state)
      if (state.activeSession) (state.sessions ??= []).push(state.activeSession)
      if (state.ai) state.ai.selectedId = state.ai.defaultId
      state.activeSession = next
      await this.writeState(state)
      return next
    })
  }

  async aiState(initial: AiPreset) {
    return this.withLock(async () => {
      const state = await this.readState()
      state.ai ??= { presets: [persistedPreset(initial)], defaultId: initial.id, selectedId: initial.id, recentIds: [] }
      await this.writeState(state)
      return state.ai
    })
  }

  async syncClientPresets(initial: AiPreset, discovered: AiPreset[]): Promise<void> {
    if (!discovered.every(isPreset)) throw new Error('Invalid discovered AI settings')
    await this.withLock(async () => {
      const state = await this.readState()
      const first = initial.cli === 'codex' || initial.cli === 'codex-gui'
        ? initial : discovered.find((p) => p.cli === initial.cli) ?? initial
      state.ai ??= { presets: [persistedPreset(first)], defaultId: first.id, selectedId: first.id, recentIds: [] }
      const ai = state.ai
      // Refresh discovery entries, but never rewrite an active/default or user-saved choice.
      const preserved = ai.presets.filter((p) => !p.id.startsWith('detected_') ||
        p.id === ai.selectedId || p.id === ai.defaultId).map(persistedPreset)
      ai.presets = [...preserved, ...discovered.map(persistedPreset).filter((p) => !preserved.some((old) => old.id === p.id))]
      ai.recentIds = (ai.recentIds ?? []).filter((id) => ai.presets.some((preset) => preset.id === id)).slice(0, 3)
      if (initial.id === 'chat-default' && !ai.presets.some(p => p.id === initial.id)) ai.presets.push(persistedPreset(initial))
      await this.writeState(state)
    })
  }

  async captureChoice(initial: AiPreset, title?: string): Promise<ExecutionChoice> {
    return this.withLock(async () => {
      const state = await this.readState()
      state.ai ??= { presets: [persistedPreset(initial)], defaultId: initial.id, selectedId: initial.id, recentIds: [] }
      const preset = state.ai.presets.find((p) => p.id === state.ai!.selectedId)!
      state.activeSession ??= { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli }
      if (!state.activeSession.cli && !state.activeSession.hasStarted) state.activeSession.cli = preset.cli
      if (state.activeSession.cli === preset.cli) {
        const previous = state.activeSession.preset
        // Same CLI, different provider/model: web/Telegram must not resume the old native thread.
        // Undefined is the native client default and is a distinct selection.
        if (state.activeSession.hasStarted && previous &&
            (previous.provider !== preset.provider || previous.model !== preset.model)) {
          ;(state.sessions ??= []).push(state.activeSession)
          state.activeSession = { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli, preset }
        } else {
          state.activeSession.preset = preset
        }
      }
      if (!state.activeSession.title && !state.activeSession.hasStarted && title?.trim())
        state.activeSession.title = title.replace(/\s+/g, ' ').trim().slice(0, 80)
      await this.writeState(state)
      return { sessionId: state.activeSession.sessionId, preset }
    })
  }

  async captureApplicationChoice(initial: AiPreset, scope: string, shareTelegram = false, requested?: AiPreset, expectedNativeSessionId?: string): Promise<ExecutionChoice> {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid application scope')
    return this.withLock(async () => {
      const state = await this.readState()
      state.ai ??= { presets: [persistedPreset(initial)], defaultId: initial.id, selectedId: initial.id }
      state.sessions ??= []
      const previous = currentApplicationSession(state, scope)
      if (expectedNativeSessionId !== undefined && previous?.nativeSessionId !== expectedNativeSessionId) throw new Error('Application request conflicts with native session; import the existing scope before cutover')
      const activate = (session: SessionState) => {
        if (!shareTelegram) return
        session.telegramShared = true
        session.archived = false
        if (state.activeSession?.sessionId !== session.sessionId) {
          state.sessions = state.sessions!.filter(item => item.sessionId !== session.sessionId)
          if (state.activeSession) state.sessions.push(state.activeSession)
          state.activeSession = session
        }
        state.ai!.presets = [...state.ai!.presets.filter(item => item.id !== session.preset!.id), session.preset!]
        state.ai!.selectedId = session.preset!.id
      }
      if (previous?.preset) {
        if (requested && requested.cli !== previous.cli) throw new Error('Application request conflicts with existing session engine')
        if (requested) previous.preset = requested
        activate(previous)
        if (shareTelegram || requested) await this.writeState(state)
        return { sessionId: previous.sessionId, preset: previous.preset }
      }
      const preset = requested ?? state.ai.presets.find(item => item.id === state.ai!.selectedId)!
      if (preset.cli === 'agy') throw new Error('Application scopes require an engine with explicit session selection')
      const session: SessionState = { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli, preset, applicationScope: scope }
      state.sessions.push(session)
      activate(session)
      await this.writeState(state)
      return { sessionId: session.sessionId, preset }
    })
  }

  async applicationSession(scope: string): Promise<SessionState | undefined> {
    return currentApplicationSession(await this.status(), scope) ?? undefined
  }

  async changeApplicationSession(scope: string, guard: ControlGuard, preset?: AiPreset): Promise<SessionState> {
    if (!/^[a-f0-9]{64}$/.test(scope) || guard.applicationScope !== scope || guard.expectedSession === undefined)
      throw new Error('Invalid application scope control')
    return this.withLock(async () => {
      const state = await this.readState()
      await requireControlGuard(state, guard)
      const previous = currentApplicationSession(state, scope)
      if (previous && (previous.telegramShared || previous === state.activeSession))
        throw new Error('Application scope is shared; use shared controls')
      const nextPreset = preset ?? state.ai?.presets.find(item => item.id === state.ai!.defaultId)
      if (!nextPreset || !isPreset(nextPreset) || nextPreset.cli === 'agy') throw new Error('Invalid application AI selection')
      if (preset && previous?.cli === preset.cli) {
        previous.preset = persistedPreset(preset)
        await this.writeState(state)
        return previous
      }
      // Retire the binding, not its native session. Admitted work still resolves
      // the old immutable session ID; private history stays absent from /chats.
      if (previous) previous.archived = true
      const next: SessionState = {sessionId:crypto.randomUUID(), hasStarted:false,
        cli:nextPreset.cli, preset:persistedPreset(nextPreset), applicationScope:scope}
      ;(state.sessions ??= []).push(next)
      await this.writeState(state)
      return next
    })
  }

  async executionSession(choice: ExecutionChoice): Promise<SessionState> {
    const state = await this.status()
    const session = state.activeSession?.sessionId === choice.sessionId ? state.activeSession
      : state.sessions?.find((s) => s.sessionId === choice.sessionId)
    if (!session || session.cli !== choice.preset.cli)
      throw new Error('Conversation has no matching CLI binding. Use New conversation explicitly; files are preserved.')
    if (session.hasStarted && ['codex', 'codex-gui', 'opencode'].includes(session.cli) && !session.nativeSessionId)
      throw new Error('Native session ID missing. Use New conversation explicitly; no automatic reset.')
    return session
  }

  async saveNativeSession(sessionId: string, nativeSessionId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(nativeSessionId)) throw new Error('Invalid native session ID')
    await this.withLock(async () => {
      const state = await this.readState()
      const session = state.activeSession?.sessionId === sessionId ? state.activeSession
        : state.sessions?.find((s) => s.sessionId === sessionId)
      if (!session) throw new Error('Unknown conversation')
      if (session.nativeSessionId && session.nativeSessionId !== nativeSessionId)
        throw new Error('Native session changed unexpectedly')
      session.nativeSessionId = nativeSessionId
      // Native session creation is durable even if the subsequent turn fails.
      session.hasStarted = true
      await this.writeState(state)
    })
  }

  async savePreset(preset: AiPreset, guard?: ControlGuard): Promise<void> {
    if (!isPreset(preset)) throw new Error('Invalid AI preset')
    assertEffort(preset.effort, preset.model, preset.cli)
    await this.withLock(async () => {
      const state = await this.readState()
      await requireControlGuard(state, guard)
      if (!state.ai) throw new Error('AI settings not initialized')
      if (state.ai.presets.length >= 12 && !state.ai.presets.some((p) => p.id === preset.id))
        throw new Error('Keep it small: at most 12 saved AIs.')
      state.ai.presets = [...state.ai.presets.filter((p) => p.id !== preset.id), persistedPreset(preset)]
      await this.writeState(state)
    })
  }

  async selectPreset(id: string, expectedSession: string | null, fresh = false, guard?: ControlGuard): Promise<boolean> {
    return this.withLock(async () => {
      const state = await this.readState()
      await requireControlGuard(state, guard)
      const ai = state.ai
      const preset = ai?.presets.find((p) => p.id === id)
      if (!ai || !preset) throw new Error('Saved AI no longer exists')
      assertEffort(preset.effort, preset.model, preset.cli)
      if ((state.activeSession?.sessionId ?? null) !== expectedSession) throw new Error('Menu expired. Open Choose AI again.')
      const current = ai.presets.find((p) => p.id === ai.selectedId)!
      if (state.activeSession && (current.cli !== preset.cli || !state.activeSession.cli) && !fresh) return false
      if (fresh || !state.activeSession) {
        rememberPreset(state)
        if (state.activeSession) (state.sessions ??= []).push(state.activeSession)
        state.activeSession = { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli }
      }
      ai.selectedId = id
      ai.recentIds = [id, ...(ai.recentIds ?? []).filter((recentId) => recentId !== id)].slice(0, 3)
      await this.writeState(state)
      return true
    })
  }

  async defaultPreset(id: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.ai?.presets.some((p) => p.id === id)) throw new Error('Unknown AI preset')
      const preset = state.ai.presets.find(p => p.id === id)!
      assertEffort(preset.effort, preset.model, preset.cli)
      state.ai.defaultId = id
      await this.writeState(state)
    })
  }
}
