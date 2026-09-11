import { assertEffort } from './model-policy.js'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPreset, type AiPreset, type ExecutionChoice } from './ai.js'

export type Owner = {
  kind?: 'group'
  telegramUserId: number
  telegramChatId: number
  pairedAt: string
}

export type PairingRequest = {
  kind?: 'group'
  title?: string
  telegramUserId: number
  telegramChatId: number
  requestedAt: string
  expiresAt: string
}

export type SessionState = {
  sessionId: string
  hasStarted: boolean
  cli?: string
  nativeSessionId?: string
}

type ControlState = {
  version: 1
  owner: Owner | null
  pending: PairingRequest[]
  activeSession?: SessionState | null
  ai?: { presets: AiPreset[]; defaultId: string; selectedId: string }
  sessions?: SessionState[]
}

type Clock = () => number

const emptyState = (): ControlState => ({ version: 1, owner: null, pending: [] })

const isPositiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isState = (value: unknown): value is ControlState => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ControlState>
  const identity = (person: unknown): boolean => {
    if (!person || typeof person !== 'object') return false
    const p = person as Owner
    return isPositiveId(p.telegramUserId) && (p.kind === 'group'
      ? Number.isSafeInteger(p.telegramChatId) && p.telegramChatId < 0
      : p.kind === undefined && isPositiveId(p.telegramChatId))
  }
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.pending) &&
    candidate.pending.every((p) => identity(p) && Number.isFinite(Date.parse(p.expiresAt))) &&
    (candidate.owner === null || identity(candidate.owner)) &&
    (candidate.ai === undefined || (Array.isArray(candidate.ai.presets) &&
      candidate.ai.presets.every(isPreset) &&
      candidate.ai.presets.some((p) => p.id === candidate.ai!.defaultId) &&
      candidate.ai.presets.some((p) => p.id === candidate.ai!.selectedId))) &&
    (candidate.sessions === undefined || (Array.isArray(candidate.sessions) && candidate.sessions.every(
      (s) => /^[0-9a-f-]{36}$/i.test(s.sessionId) && typeof s.hasStarted === 'boolean'))) &&
    (candidate.activeSession == null ||
      (typeof candidate.activeSession.sessionId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(candidate.activeSession.sessionId) &&
        typeof candidate.activeSession.hasStarted === 'boolean'))
  )
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
      if (state.owner) return 'owner-exists'
      if (
        state.pending.some(
          (request) => request.telegramUserId === telegramUserId && request.telegramChatId === telegramChatId,
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

  async approveOwner(telegramUserId: number, group = false): Promise<Owner> {
    if (!(group ? Number.isSafeInteger(telegramUserId) && telegramUserId < 0 : isPositiveId(telegramUserId))) throw new Error('Supply a positive user ID or negative group ID')
    return this.withLock(async () => {
      const state = this.prune(await this.readState())
      if (state.owner) throw new Error('An owner is already paired; revoke locally before replacing it')
      const request = state.pending.find((candidate) => group
        ? candidate.kind === 'group' && candidate.telegramChatId === telegramUserId
        : candidate.kind === undefined && candidate.telegramUserId === telegramUserId)
      if (!request) throw new Error('No active pairing request exists for that Telegram user ID')
      const owner: Owner = {
        ...(group ? {kind: 'group' as const} : {}),
        telegramUserId: request.telegramUserId,
        telegramChatId: request.telegramChatId,
        pairedAt: new Date(this.clock()).toISOString(),
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

  async resetSession(): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
      const next: SessionState = {
        sessionId: crypto.randomUUID(),
        hasStarted: false,
        cli: state.ai?.presets.find((p) => p.id === state.ai!.defaultId)?.cli,
      }
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
      state.ai ??= { presets: [initial], defaultId: initial.id, selectedId: initial.id }
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
      state.ai ??= { presets: [first], defaultId: first.id, selectedId: first.id }
      const ai = state.ai
      // Refresh discovery entries, but never rewrite an active/default or user-saved choice.
      const preserved = ai.presets.filter((p) => !p.id.startsWith('detected_') ||
        p.id === ai.selectedId || p.id === ai.defaultId)
      ai.presets = [...preserved, ...discovered.filter((p) => !preserved.some((old) => old.id === p.id))]
      if (initial.id === 'chat-default' && !ai.presets.some(p => p.id === initial.id)) ai.presets.push(initial)
      await this.writeState(state)
    })
  }

  async captureChoice(initial: AiPreset): Promise<ExecutionChoice> {
    return this.withLock(async () => {
      const state = await this.readState()
      state.ai ??= { presets: [initial], defaultId: initial.id, selectedId: initial.id }
      const preset = state.ai.presets.find((p) => p.id === state.ai!.selectedId)!
      state.activeSession ??= { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli }
      if (!state.activeSession.cli && !state.activeSession.hasStarted) state.activeSession.cli = preset.cli
      await this.writeState(state)
      return { sessionId: state.activeSession.sessionId, preset }
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

  async savePreset(preset: AiPreset): Promise<void> {
    if (!isPreset(preset)) throw new Error('Invalid AI preset')
    assertEffort(preset.effort)
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.ai) throw new Error('AI settings not initialized')
      if (state.ai.presets.length >= 12 && !state.ai.presets.some((p) => p.id === preset.id))
        throw new Error('Keep it small: at most 12 saved AIs.')
      state.ai.presets = [...state.ai.presets.filter((p) => p.id !== preset.id), preset]
      await this.writeState(state)
    })
  }

  async selectPreset(id: string, expectedSession: string | null, fresh = false): Promise<boolean> {
    return this.withLock(async () => {
      const state = await this.readState()
      const ai = state.ai
      const preset = ai?.presets.find((p) => p.id === id)
      if (!ai || !preset) throw new Error('Saved AI no longer exists')
      assertEffort(preset.effort)
      if ((state.activeSession?.sessionId ?? null) !== expectedSession) throw new Error('Menu expired. Open Choose AI again.')
      const current = ai.presets.find((p) => p.id === ai.selectedId)!
      if (state.activeSession && (current.cli !== preset.cli || !state.activeSession.cli) && !fresh) return false
      if (fresh || !state.activeSession) {
        if (state.activeSession) (state.sessions ??= []).push(state.activeSession)
        state.activeSession = { sessionId: crypto.randomUUID(), hasStarted: false, cli: preset.cli }
      }
      ai.selectedId = id
      await this.writeState(state)
      return true
    })
  }

  async defaultPreset(id: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.ai?.presets.some((p) => p.id === id)) throw new Error('Unknown AI preset')
      assertEffort(state.ai.presets.find(p => p.id === id)!.effort)
      state.ai.defaultId = id
      await this.writeState(state)
    })
  }
}
