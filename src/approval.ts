import { assertId } from './identity.js'
import { ownerEpoch, ownerId, type Owner } from './control-state.js'

export type ApprovalDecision = 'pending' | 'approved' | 'denied'

export type ApprovalRecord = {
  version: 1 | 2
  actionId: string
  runId?: string
  prompt: string
  decision: ApprovalDecision
  createdAt: string
  decidedAt?: string
  decidedBy?: number
  decisionUpdateId?: number
  decidedOwnerId?: string
  decidedOwnerEpoch?: string
}

const isApprovalRecord = (value: unknown): value is ApprovalRecord => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ApprovalRecord>
  return (
    [1,2].includes(candidate.version ?? 0) &&
    typeof candidate.actionId === 'string' &&
    /^[a-zA-Z0-9_-]{1,40}$/.test(candidate.actionId) &&
    typeof candidate.prompt === 'string' &&
    ['pending', 'approved', 'denied'].includes(candidate.decision ?? '') &&
    typeof candidate.createdAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    (candidate.version === 1 || typeof candidate.decidedOwnerId === 'string' && typeof candidate.decidedOwnerEpoch === 'string')
  )
}

// Stateless pipe: approvals live in relay memory. Engine children request
// decisions through the delivery socket (folded into the approval send);
// callbacks and task arbitration record them in-relay. A restart drops
// pending approvals by design.
const approvalsByControl = new Map<string, Map<string, ApprovalRecord>>()

const approvalsFor = (controlDir: string): Map<string, ApprovalRecord> => {
  let map = approvalsByControl.get(controlDir)
  if (!map) { map = new Map(); approvalsByControl.set(controlDir, map) }
  return map
}

export class ApprovalStore {
  constructor(private readonly controlDir: string) {}

  private key(actionId: string): string {
    const safe = assertId(actionId)
    if (safe.length > 40) throw new Error('Approval identifier must be at most 40 characters')
    return safe
  }

  async requestApproval(actionId: string, prompt: string, runId?: string): Promise<ApprovalRecord> {
    if (!prompt.trim()) throw new Error('Approval prompt is empty')
    if (runId) assertId(runId)
    const store = approvalsFor(this.controlDir)
    const existing = store.get(this.key(actionId)) ?? null
    if (existing) {
      if (existing.runId !== runId || existing.prompt !== prompt)
        throw new Error('Approval ID already belongs to another request')
      return existing
    }

    const record: ApprovalRecord = {
      version: 1,
      actionId,
      runId,
      prompt,
      decision: 'pending',
      createdAt: new Date().toISOString(),
    }
    store.set(this.key(actionId), record)
    return record
  }

  async recordDecision(
    actionId: string,
    decision: 'approved' | 'denied',
    decidedBy: number,
    decisionUpdateId?: number,
  ): Promise<ApprovalRecord> {
    const store = approvalsFor(this.controlDir)
    const existing = store.get(this.key(actionId)) ?? null
    if (!existing) throw new Error('Unknown approval request')
    if (
      decisionUpdateId !== undefined &&
      existing.decisionUpdateId === decisionUpdateId &&
      existing.decidedBy === decidedBy &&
      existing.decision === decision
    )
      return existing
    if (existing.decision !== 'pending') throw new Error('Approval already decided')
    if (Date.now() - Date.parse(existing.createdAt) > 900_000) throw new Error('Approval expired')
    const record: ApprovalRecord = {
      ...existing,
      decision,
      decidedAt: new Date().toISOString(),
      decidedBy,
      decisionUpdateId,
    }
    store.set(this.key(actionId), record)
    return record
  }

  async recordOwnerDecision(actionId: string, decision: 'approved' | 'denied', owner: Owner): Promise<ApprovalRecord> {
    const store = approvalsFor(this.controlDir)
    const existing = store.get(this.key(actionId)) ?? null
    if (!existing) throw new Error('Unknown approval request')
    if (existing.decision !== 'pending') throw new Error('Approval already decided')
    if (Date.now() - Date.parse(existing.createdAt) > 900_000) throw new Error('Approval expired')
    const record: ApprovalRecord = {...existing,version:2,decision,decidedAt:new Date().toISOString(),decidedOwnerId:ownerId(owner),decidedOwnerEpoch:ownerEpoch(owner)}
    store.set(this.key(actionId), record)
    return record
  }

  async getDecision(actionId: string): Promise<ApprovalRecord | null> {
    const record = approvalsFor(this.controlDir).get(this.key(actionId)) ?? null
    if (record && (!isApprovalRecord(record) || record.actionId !== actionId))
      throw new Error('Invalid approval record shape')
    return record
  }
}
