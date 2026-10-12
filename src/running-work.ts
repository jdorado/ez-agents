import type { Owner } from './control-state.js'
import { sameOwner } from './control-state.js'
import { readOnlyOwner, requireOwnerExecution } from './execution-authority.js'
import { redactFailure } from './failure.js'
import { ownsRun } from './identity.js'
import { activeSetup, retainedOutbox, RunStore, type RunRecord, type StoredOutboxItem } from './runs.js'
import { Scheduler, type Schedule } from './scheduler.js'

const timestamp = (value?: string): string | null =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const secondsSince = (value: string | null, now: number): number | null =>
  value && Date.parse(value) <= now ? Math.floor((now - Date.parse(value)) / 1000) : null
const label = (value: string): string => redactFailure(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 120)

// Current-owner relay records only, without application/channel request context.
// Nothing here queries native sessions, processes or provider state, or exports prompts.
const visible = (run: RunRecord, owner: Owner): boolean =>
  ownsRun(owner, run) && Date.parse(run.createdAt) >= Date.parse(owner.pairedAt) &&
  !run.external && !run.taskId &&
  (!run.scheduled || run.scheduled.pairedAt === owner.pairedAt)

export function projectRunningWork(records: RunRecord[], outbox: StoredOutboxItem[], schedules: Schedule[], owner: Owner, now = Date.now()) {
  const owned = records.filter(run => visible(run, owner))
  const active = owned.filter(run => run.status === 'running' || run.status === 'queued')
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') ||
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const runs = active.map(run => {
    const preset = activeSetup(run)
    const attempt = [...run.attempts ?? []].reverse().find(item => item.outcome !== 'skipped')
    const schedule = schedules.find(item => item.id === run.scheduled?.id &&
      item.revision === run.scheduled.revision && sameOwner(item.owner, owner))
    const originId = run.scheduled?.originRunId
    const origin = owned.find(item => item.id === originId)
    const events = [
      { at: timestamp(run.createdAt), kind: 'queued' },
      { at: timestamp(run.startedAt), kind: 'relay-started' },
      ...run.attempts?.flatMap(item => [
        { at: timestamp(item.startedAt), kind: item.outcome === 'skipped' ? 'setup-skipped' : 'setup-attempt-started' },
        { at: timestamp(item.endedAt), kind: item.outcome === 'skipped' ? 'setup-skipped' : 'setup-attempt-ended' },
      ]) ?? [],
      ...outbox.filter(item => item.runId === run.id && item.chatId === owner.telegramChatId &&
        Date.parse(item.createdAt) >= Date.parse(owner.telegramLinkedAt ?? owner.pairedAt))
        .map(item => ({ at: timestamp(item.createdAt), kind: 'delivery-enqueued' })),
    ].filter((item): item is { at: string; kind: string } => item.at !== null && Date.parse(item.at) <= now)
      .sort((a, b) => b.at.localeCompare(a.at))
    const latest = events[0]
    return {
      id: run.id, status: run.status,
      kind: run.script ? 'scheduled-script' : run.scheduled ? 'scheduled-agent' : run.sessionClose ? 'session-close' : run.application || run.telegramApplication ? 'application-foreground' : 'foreground',
      schedule: run.scheduled ? { id: run.scheduled.id, revision: run.scheduled.revision,
        name: schedule ? label(schedule.name) : null, dueAt: timestamp(run.scheduled.dueAt) } : null,
      script: run.script ? { id: run.script.id, revision: run.script.revision ?? null } : null,
      execution: run.script ? null : preset ? { cli: preset.cli, model: preset.model ?? null,
        effort: preset.effort ?? null, provider: preset.provider ?? null,
        source: attempt ? 'latest-attempt' : 'saved', attemptOutcome: attempt?.outcome ?? null } : null,
      createdAt: timestamp(run.createdAt), startedAt: timestamp(run.startedAt),
      elapsedSeconds: run.status === 'running' ? secondsSince(timestamp(run.startedAt), now) : null,
      queuedSeconds: run.status === 'queued' ? secondsSince(timestamp(run.createdAt), now) : null,
      lastObservedActivity: latest ? { ...latest, ageSeconds: secondsSince(latest.at, now) } : null,
      // This is request provenance, not proof of native parent/child delegation.
      origin: originId ? { runId: originId, relation: 'schedule-origin',
        status: origin?.status ?? null, retained: Boolean(origin) } : null,
      scheduledChildren: active.filter(item => item.scheduled?.originRunId === run.id)
        .map(item => ({ id: item.id, status: item.status })),
      nativeChildren: { state: 'unavailable' },
    }
  })
  return { schemaVersion: 1, observedAt: new Date(now).toISOString(),
    counts: { running: runs.filter(run => run.status === 'running').length, queued: runs.filter(run => run.status === 'queued').length },
    coverage: {
      scope: 'current-owner foreground and scheduled runs in this relay',
      retention: 'relay memory; resets on restart except adopted host runs; older origin records may be absent',
      activity: 'relay lifecycle, setup attempts and delivery enqueue times only; silence is not idle or completion',
      nativeActivity: 'unavailable; native tool and delegation events are not retained',
      relationships: 'schedule-origin links only; native child status is unknown',
      excluded: ['standalone CLI/desktop work', 'other installations', 'external/isolated tasks', 'prompts, messages, application context and raw engine output'],
    }, runs }
}

export type RunningWorkView = ReturnType<typeof projectRunningWork>

export async function runningWork(controlDir: string, options: { callerRunId?: string } = {}): Promise<RunningWorkView> {
  if (options.callerRunId !== undefined) {
    const caller = await new RunStore(controlDir).get(options.callerRunId)
    if (caller?.application || caller?.delivery || caller?.replyOnly)
      throw new Error('Running work requires Telegram owner execution or the bound operator')
    await requireOwnerExecution(controlDir, options.callerRunId)
  }
  const owner = await readOnlyOwner(controlDir)
  if (!owner) throw new Error('No authorized owner')
  const schedules = await new Scheduler(controlDir).listReadOnly()
  return projectRunningWork(await new RunStore(controlDir).list(), retainedOutbox(controlDir),
    schedules, owner)
}

const duration = (seconds: number | null): string => {
  if (seconds === null) return 'unknown'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

export function formatRunningWork(view: RunningWorkView): string {
  const lines = [`Queued and running work: ${view.counts.running} running, ${view.counts.queued} queued`, `Observed: ${view.observedAt}`]
  if (!view.runs.length) lines.push('No queued or running work observed in the retained relay ledger.')
  for (const run of view.runs) {
    lines.push('', `${run.id}  ${run.status}  ${run.kind}`)
    if (run.schedule) lines.push(`  Schedule: ${run.schedule.name ?? '(name unavailable)'} (${run.schedule.id}, revision ${run.schedule.revision}); due ${run.schedule.dueAt ?? 'unknown'}`)
    if (run.script) lines.push(`  Script: ${run.script.id}; engine/model: not applicable`)
    else lines.push(`  Engine/model: ${run.execution?.cli ?? 'unknown'} / ${run.execution?.model ?? 'unknown'}${run.execution?.effort ? `; effort ${run.execution.effort}` : ''}${run.execution ? ` (${run.execution.source}${run.execution.attemptOutcome ? `: ${run.execution.attemptOutcome}` : ''})` : ''}`)
    lines.push(`  Started: ${run.startedAt ?? (run.status === 'queued' ? 'not started' : 'unknown')}; elapsed: ${run.status === 'queued' ? 'not applicable' : duration(run.elapsedSeconds)}${run.status === 'queued' ? `; queued for ${duration(run.queuedSeconds)}` : ''}`)
    const activity = run.lastObservedActivity
    lines.push(`  Last observed: ${activity ? `${activity.at} (${duration(activity.ageSeconds)} ago; ${activity.kind})` : 'unknown'}`)
    if (run.origin) lines.push(`  Schedule origin: ${run.origin.runId} (${run.origin.status ?? 'status unknown; record unavailable'})`)
    if (run.scheduledChildren.length) lines.push(`  Active scheduled children: ${run.scheduledChildren.map(item => `${item.id} (${item.status})`).join(', ')}`)
    lines.push('  Native children: unavailable')
  }
  lines.push('', `Visibility: ${view.coverage.scope}.`, view.coverage.retention + '.', view.coverage.activity + '.',
    'Native tool activity and child status are unavailable. Schedule origins are request provenance.',
    'Standalone CLI/desktop work, other installations and external/isolated runs are outside this view.')
  return lines.join('\n')
}
