import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageVersion } from './version.js'

export type FailureEvidence = { error: string; relayVersion: string; hostVersion?: string }
export type FailureReview = { failedAt: string; reviewedAt: string; reviewerRunId?: string; status: 'resolved' | 'attention'; diagnosis: string; recovery: string; outcome: string }

// Keep diagnostic context, never a full conversation, stdout, or credentials.
export function redactFailure(text: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) text = text.split(secret).join('[redacted]')
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[redacted authorization]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[-_]?key)|authorization|cookie)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+|(?:bot)?\d{6,}:[\w-]{20,})\b/g, '[redacted credential]')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+\b/g, '[redacted JWT]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => { try { const url=new URL(value); url.username='';url.password='';url.search='';url.hash='';return url.toString() } catch { return '[redacted URL]' } })
    .replace(/\b[A-Za-z0-9_+/=-]{48,}\b/g, '[redacted opaque value]')
    .slice(-4096)
}
export async function failureEvidence(controlDir: string, error: string): Promise<FailureEvidence> {
  let hostVersion: string | undefined
  try { const h=JSON.parse(await readFile(join(controlDir,'host-executor','heartbeat.json'),'utf8')); if(typeof h.version==='string' && /^[0-9A-Za-z.+-]{1,80}$/.test(h.version))hostVersion=h.version } catch {}
  return { error: redactFailure(error), relayVersion: packageVersion, ...(hostVersion ? {hostVersion} : {}) }
}
export const failureStamp = (run: {endedAt?: string; createdAt: string}) => run.endedAt || run.createdAt
export const needsFailureReview = (run: {status: string; endedAt?: string; createdAt: string; failureReview?: FailureReview}) => run.status==='failed' && run.failureReview?.failedAt!==failureStamp(run)
export function validFailureReview(review: FailureReview) {
  return review && ['resolved','attention'].includes(review.status) && Number.isFinite(Date.parse(review.failedAt)) && Number.isFinite(Date.parse(review.reviewedAt)) &&
    (review.reviewerRunId===undefined || /^[a-zA-Z0-9_-]+$/.test(review.reviewerRunId)) &&
    [review.diagnosis,review.recovery,review.outcome].every(v=>typeof v==='string' && Boolean(v.trim()) && v.length<=2000)
}
