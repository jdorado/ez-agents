import { assertEffort } from './model-policy.js'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPreset, persistedPreset, type AiPreset, type ExecutionChoice } from './ai.js'

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
  title?: string
  archived?: boolean
  preset?: AiPreset
}

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

const isRecentIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 3 && new Set(value).size === value.length &&
  value.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(id))

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
  const session = (s: SessionState) => s && /^[0-9a-f-]{36}$/i.test(s.sessionId) && typeof s.hasStarted === 'boolean' &&
    (s.title === undefined || (typeof s.title === 'string' && s.title.length <= 80)) &&
    (s.archived === undefined || typeof s.archived === 'boolean') &&
    (s.preset === undefined || (isPreset(s.preset) && s.preset.cli === s.cli))
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.pending) &&
    candidate.pending.every((p) => identity(p) && Number.isFinite(Date.parse(p.expiresAt))) &&
    (candidate.owner === null || identity(candidate.owner)) &&
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

  async listSessions(): Promise<SessionState[]> {
    const state = await this.status()
    return [...(state.activeSession ? [state.activeSession] : []), ...(state.sessions ?? []).slice().reverse()]
  }

  async switchSession(sessionId: string): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
      if (state.activeSession?.sessionId === sessionId) return state.activeSession
      const session = state.sessions?.find(s => s.sessionId === sessionId)
      if (!session || session.archived) throw new Error('Conversation unavailable. Open /chats again.')
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

  async resetSession(): Promise<SessionState> {
    return this.withLock(async () => {
      const state = await this.readState()
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
      if (state.activeSession.cli === preset.cli) state.activeSession.preset = preset
      if (!state.activeSession.title && !state.activeSession.hasStarted && title?.trim())
        state.activeSession.title = title.replace(/\s+/g, ' ').trim().slice(0, 80)
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
    assertEffort(preset.effort, preset.model, preset.cli)
    await this.withLock(async () => {
      const state = await this.readState()
      if (!state.ai) throw new Error('AI settings not initialized')
      if (state.ai.presets.length >= 12 && !state.ai.presets.some((p) => p.id === preset.id))
        throw new Error('Keep it small: at most 12 saved AIs.')
      state.ai.presets = [...state.ai.presets.filter((p) => p.id !== preset.id), persistedPreset(preset)]
      await this.writeState(state)
    })
  }

  async selectPreset(id: string, expectedSession: string | null, fresh = false): Promise<boolean> {
    return this.withLock(async () => {
      const state = await this.readState()
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
