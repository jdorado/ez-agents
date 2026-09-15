import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

export class ApprovalStore {
  private readonly approvalsDir: string

  constructor(controlDir: string) {
    this.approvalsDir = path.join(controlDir, 'approvals')
  }

  private async ensure(): Promise<void> {
    await mkdir(this.approvalsDir, { recursive: true, mode: 0o700 })
  }

  private filePath(actionId: string): string {
    const safe = assertId(actionId)
    if (safe.length > 40) throw new Error('Approval identifier must be at most 40 characters')
    return path.join(this.approvalsDir, `${safe}.json`)
  }

  async requestApproval(actionId: string, prompt: string, runId?: string): Promise<ApprovalRecord> {
    if (!prompt.trim()) throw new Error('Approval prompt is empty')
    if (runId) assertId(runId)
    await this.ensure()
    const existing = await this.getDecision(actionId)
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
    const file = this.filePath(actionId)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
    return record
  }

  async recordDecision(
    actionId: string,
    decision: 'approved' | 'denied',
    decidedBy: number,
    decisionUpdateId?: number,
  ): Promise<ApprovalRecord> {
    await this.ensure()
    const existing = await this.getDecision(actionId)
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
    const file = this.filePath(actionId)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
    return record
  }

  async recordOwnerDecision(actionId: string, decision: 'approved' | 'denied', owner: Owner): Promise<ApprovalRecord> {
    await this.ensure()
    const existing = await this.getDecision(actionId)
    if (!existing) throw new Error('Unknown approval request')
    if (existing.decision !== 'pending') throw new Error('Approval already decided')
    if (Date.now() - Date.parse(existing.createdAt) > 900_000) throw new Error('Approval expired')
    const record: ApprovalRecord = {...existing,version:2,decision,decidedAt:new Date().toISOString(),decidedOwnerId:ownerId(owner),decidedOwnerEpoch:ownerEpoch(owner)}
    const file=this.filePath(actionId),temporary=`${file}.${process.pid}.tmp`
    await writeFile(temporary,`${JSON.stringify(record,null,2)}\n`,{mode:0o600});await rename(temporary,file)
    return record
  }

  async getDecision(actionId: string): Promise<ApprovalRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath(actionId), 'utf8'))
      if (!isApprovalRecord(parsed) || parsed.actionId !== actionId)
        throw new Error('Invalid approval record shape')
      return parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}
