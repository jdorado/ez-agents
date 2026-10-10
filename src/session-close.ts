import type { SessionState, Owner } from './control-state.js'
import { ownerId, ownerEpoch } from './control-state.js'
import type { RunStore, RunRecord } from './runs.js'

// A chat conversation has no native end. Before one is replaced, its engine
// gets one silent turn in that same native session to keep durable facts in
// the workspace. Ez only transports this literal; the engine decides whether
// anything is written. No reply mechanism is offered, so nothing is delivered.
// Owner conversations only: a close turn carries owner authority, so a private
// application scope (which runs under its binding's narrower authority) gets none.
export const SESSION_CLOSE_PROMPT = '[conversation closing] This conversation is ending. Save anything a future conversation will need where AGENTS.md says to keep memory; otherwise do nothing.'

export async function queueSessionClose(runs: RunStore, owner: Owner | null, session: SessionState | null | undefined): Promise<RunRecord | undefined> {
  if (!owner || !session?.hasStarted || !session.preset || session.applicationScope) return undefined
  return runs.create({ ownerId: ownerId(owner), ownerEpoch: ownerEpoch(owner), texts: [SESSION_CLOSE_PROMPT],
    execution: { sessionId: session.sessionId, preset: session.preset }, sessionClose: true })
}
