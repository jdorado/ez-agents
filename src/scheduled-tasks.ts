import { executionDefaults } from './model-policy.js'
import { presetLabel } from './ai.js'
import type { Owner } from './control-state.js'
import type { Schedule, ActiveSchedule } from './scheduler.js'

const ownsSchedule = (owner: Owner, schedule: Schedule) =>
  schedule.owner.telegramUserId === owner.telegramUserId &&
  schedule.owner.telegramChatId === owner.telegramChatId &&
  schedule.owner.pairedAt === owner.pairedAt

// Saved schedules created under an earlier model policy remain inspectable. The
// executor will apply the same defaults (and enforce its current policy) when
// it starts the run; an outdated saved selection must not hide every menu row.
const displayedPreset = (schedule: Schedule) => {
  try { return executionDefaults(schedule.execution.preset.cli, schedule.execution.preset) }
  catch { return schedule.execution.preset }
}

const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const time = (value: number | string) => {
  const date = new Date(value)
  return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()} · ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC`
}

const preview = (schedule: Schedule) => {
  const sentence = schedule.text.trim().replace(/\s+/gu,' ').split(/(?<=[.!?])\s/u)[0]
  const chars = Array.from(sentence)
  return chars.length > 140 ? chars.slice(0,139).join('')+'…' : sentence
}

const currentState = (schedule: ActiveSchedule) =>
  schedule.runState === 'running' ? '▶ Running' : schedule.runState === 'queued' ? '◌ Queued' : '● Active'

const lastRun = (schedule: ActiveSchedule) => {
  if (!schedule.lastRun) return '— Not run yet'
  const status = schedule.lastRun.status === 'completed' ? '✓ Completed' : schedule.lastRun.status === 'failed' ? '✕ Failed' : '⊘ Cancelled'
  return `${status} · ${time(schedule.lastRun.at)}${schedule.lastRun.currentRevision ? '' : ' · previous version'}`
}

export const ownedScheduledTasks = (schedules: ActiveSchedule[], owner: Owner) =>
  schedules.filter((schedule) => ownsSchedule(owner, schedule))
    .sort((a, b) => a.name.localeCompare(b.name))

export const scheduledTasksText = (schedules: ActiveSchedule[], owner: Owner) => {
  const owned = ownedScheduledTasks(schedules, owner)
  if (!owned.length) return '📅 Scheduled tasks\n\nNo active scheduled tasks.'
  return [`📅 Scheduled tasks · ${owned.length} active`, 'All times UTC. Use /tasks 2 for task details.', ...owned.map((schedule, index) => {
    const preset = displayedPreset(schedule)
    return `${index + 1} · ${schedule.name}\n  ${currentState(schedule)}\n  Next · ${schedule.nextAt === null ? '—' : time(schedule.nextAt)}\n  Last · ${lastRun(schedule)}\n  ${presetLabel(preset)}\n  ${preview(schedule)}`
  })].join('\n\n')
}

export const scheduledTaskDetailText = (schedule: ActiveSchedule, number: number) => {
  const preset = displayedPreset(schedule)
  return [
    `📅 ${number} · ${schedule.name}`,
    currentState(schedule),
    '',
    'Next run',
    schedule.nextAt === null ? '—' : time(schedule.nextAt),
    '',
    'Last run',
    lastRun(schedule),
    '',
    'Engine',
    presetLabel(preset),
    '',
    'Instructions',
    schedule.text.trim(),
  ].join('\n')
}
