import { escapeHtml } from './format.js'
import { activeSetup, type RunRecord } from './runs.js'

// Owner `/status` as Telegram HTML. Pure render of relay state the caller
// already read: nothing is stored, polled or read from the engine.
export type StatusInput = {
  now: number
  runs: RunRecord[]
  // Schedule id → name, so a scheduled run reads as its task.
  names: Map<string, string>
  // `Key: value` lines (software status, selected AI); `Plugins` splits per plugin.
  system: string[]
  scheduledLimit: number
  incoming: { pending: number; failed: number }
  // createdAt of each failed or unconfirmed send, oldest first.
  delivery: { failed: string[]; unknown: string[] }
  unavailableSources: string[]
  // The foreground run that waits for the workspace, if any.
  waitingRunId?: string
  // Message previews appear in private owner chats only.
  privateChat: boolean
  note?: string
}
export type StatusView = { html: string; stop: boolean; cancel: boolean; retry: boolean }

const ROWS = 5, FAILURE_HOURS = 24, FAILURES = 3

const age = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
}
const since = (iso: string | undefined, now: number): string | undefined =>
  iso && Date.parse(iso) <= now ? age(now - Date.parse(iso)) : undefined
const clip = (text: string, max: number): string => {
  const plain = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  // Cut by code point: a UTF-16 slice can split an emoji, which Telegram rejects.
  const chars = Array.from(plain)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : plain
}
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

const label = (run: RunRecord, input: StatusInput): string =>
  run.scheduled ? input.names.get(run.scheduled.id) ?? run.scheduled.id
    : run.external ? `source ${run.external.sourceId}`
    : run.script ? `script ${run.script.id}`
    : run.sessionClose ? 'conversation close'
    : run.application || run.telegramApplication ? 'application message'
    : input.privateChat && run.texts[0]?.trim() ? `chat "${clip(run.texts[0], 28)}"` : 'chat message'

const engine = (run: RunRecord): string => {
  const preset = activeSetup(run)
  return preset ? `${preset.cli}${preset.authProfile ? `@${preset.authProfile}` : ''}${preset.model ? ` · ${preset.model}` : ''}` : ''
}

const workRow = (run: RunRecord, input: StatusInput): string => {
  const waiting = run.id === input.waitingRunId
  const state = run.status === 'running'
    ? `${waiting ? 'waiting for the workspace' : 'running'} ${since(run.startedAt ?? run.createdAt, input.now) ?? ''}`.trim()
    : `queued ${since(run.createdAt, input.now) ?? ''}`.trim()
  const quota = run.status === 'queued' && run.quotaWait
    ? ` · waiting for quota, ${run.quotaWait.retryAt ? `next check ${run.quotaWait.retryAt}` : 'awaiting availability or /retry_quota'}` : ''
  return `${run.status === 'running' && !waiting ? '▶' : '⏳'} <b>${escapeHtml(label(run, input))}</b> · ${escapeHtml(state)}` +
    `${engine(run) ? ` · ${escapeHtml(engine(run))}` : ''}${escapeHtml(quota)}`
}

const systemBlock = (lines: string[]): string => {
  const rows = lines.map((line): [string, string[]] => {
    const at = line.indexOf(': ')
    const key = at < 0 ? '' : line.slice(0, at), value = at < 0 ? line : line.slice(at + 2)
    return [key, key === 'Plugins' && value.includes(', ') ? value.split(', ') : [value]]
  })
  const width = Math.max(0, ...rows.map(([key]) => key.length)) + 2
  return `<b>System</b>\n<pre>${escapeHtml(rows.flatMap(([key, values]) =>
    values.map((value, index) => `${(index ? '' : key).padEnd(width)}${value}`)).join('\n'))}</pre>`
}

export const statusReport = (input: StatusInput): StatusView => {
  const { now, runs } = input
  const active = runs.filter(run => run.status === 'running' || run.status === 'queued')
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.createdAt.localeCompare(b.createdAt))
  const scheduled = runs.filter(run => run.scheduled && run.status === 'running').length

  const workLines = active.slice(0, ROWS).map(run => workRow(run, input))
  if (active.length > ROWS) workLines.push(`+${active.length - ROWS} more`)
  const counts = [...(scheduled ? [`${scheduled} of ${input.scheduledLimit} scheduled`] : []),
    ...(input.incoming.pending ? [`${plural(input.incoming.pending, 'incoming message')} waiting`] : [])]
  if (counts.length) workLines.push(counts.join(' · '))
  else if (!workLines.length) workLines.push('Nothing running or queued.')

  const blocked = runs.filter(run => run.blockReason === 'external-execution-unavailable')
  // Items are HTML: every dynamic piece is escaped where it is inserted.
  const oldest = (items: string[], suffix = ''): string => since(items[0], now) ? ` · oldest ${escapeHtml(since(items[0], now)!)}${suffix}` : ''
  const attention = [
    ...(input.delivery.failed.length ? [`${plural(input.delivery.failed.length, 'message')} failed to send${oldest(input.delivery.failed, ' ago')}`] : []),
    ...(input.delivery.unknown.length ? [`${plural(input.delivery.unknown.length, 'delivery', 'deliveries')} awaiting confirmation${oldest(input.delivery.unknown)} · inspect before retrying`] : []),
    ...(blocked.length > 3 ? [`${blocked.length} external runs blocked: isolated execution unavailable`]
      : blocked.map(run => `<b>${escapeHtml(label(run, input))}</b> blocked: isolated execution unavailable`)),
    ...(input.unavailableSources.length ? [`Event sources unavailable: ${escapeHtml(input.unavailableSources.join(', '))}`] : []),
  ].map(item => `• ${item}`)

  const failures = [
    ...runs.filter(run => run.status === 'failed' && run.endedAt && Date.parse(run.endedAt) <= now &&
        now - Date.parse(run.endedAt) < FAILURE_HOURS * 3_600_000)
      .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!)).slice(0, FAILURES).map(run => {
        const reason = run.failure?.error ? clip(run.failure.error.split('\n')[0], 80) : ''
        return `<b>${escapeHtml(label(run, input))}</b> · ${escapeHtml(since(run.endedAt, now)!)} ago${reason ? ` · ${escapeHtml(reason)}` : ''}`
      }),
    ...(input.incoming.failed ? [`${plural(input.incoming.failed, 'incoming batch', 'incoming batches')} failed`] : []),
  ]

  const hostDown = input.system.includes('Host transport: unavailable')
  const state = active.some(run => run.status === 'running') ? 'running' : active.length ? 'queued' : 'idle'
  const headline = `<b>${hostDown ? '🔴' : attention.length ? '🟡' : '🟢'} Ez · ${[state,
    ...(hostDown ? ['host transport unavailable'] : []),
    ...(attention.length ? [`${attention.length} ${attention.length === 1 ? 'needs' : 'need'} attention`] : [])].join(' · ')}</b>`

  const sections = [
    headline,
    `<b>▶ Work</b>\n${workLines.join('\n')}`,
    ...(attention.length ? [`<b>⚠ Needs attention</b>\n${attention.join('\n')}`] : []),
    ...(failures.length ? [`<b>Recent failures</b> (current work unaffected)\n${failures.join('\n')}`] : []),
    systemBlock(input.system),
    ...(input.note ? [`ℹ ${escapeHtml(input.note)}`] : []),
  ]
  // Telegram rejects replies over 4096 characters; drop whole trailing sections, never cut inside a tag.
  let html = sections[0]
  for (const section of sections.slice(1)) {
    if (html.length + section.length + 2 > 4000) { html += '\n\n…'; break }
    html += `\n\n${section}`
  }
  return { html, stop: active.some(run => run.status === 'running'),
    cancel: active.some(run => run.status === 'queued') || input.incoming.pending > 0, retry: input.incoming.failed > 0 }
}
