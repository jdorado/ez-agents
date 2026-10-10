import { executionDefaults } from './model-policy.js'
import { presetLabel, type AiPreset } from './ai.js'
import { AUTH_PROFILE_CLIS } from './auth-profile.js'
import type { Owner } from './control-state.js'
import type { Schedule, ScheduledTaskView } from './scheduler.js'

const ownsSchedule = (owner: Owner, schedule: Schedule) =>
  schedule.owner.telegramUserId === owner.telegramUserId &&
  schedule.owner.telegramChatId === owner.telegramChatId &&
  schedule.owner.pairedAt === owner.pairedAt

// Saved schedules created under an earlier model policy remain inspectable. The
// executor will apply the same defaults (and enforce its current policy) when
// it starts the run; an outdated saved selection must not hide every menu row.
const displayedPreset = (preset: AiPreset) => {
  try { return executionDefaults(preset.cli, preset) }
  catch { return preset }
}

const setupLabel = (preset: AiPreset) => {
  const label = presetLabel(displayedPreset(preset))
  return AUTH_PROFILE_CLIS.includes(preset.cli) && preset.authProfile === undefined
    ? `${preset.cli} (default login)${label.slice(preset.cli.length)}` : label
}

// Script schedules have no AI preset; show what core actually invokes.
const engineLabel = (schedule: ScheduledTaskView) => schedule.script
  ? `Script · ${schedule.script.id} · ${schedule.scriptRevision ? `rev ${schedule.scriptRevision.slice(0, 8)}` : 'not registered'}`
  : [schedule.execution!.preset, ...schedule.execution!.fallbacks ?? []].map(setupLabel).join(' → ')

const every = (count: number, unit: string) => `Every ${count === 1 ? '' : `${count} `}${unit}${count === 1 ? '' : 's'}`
const frequency = (schedule: Schedule) => {
  const trigger = schedule.trigger
  if ('at' in trigger) return 'Once'
  if ('everySeconds' in trigger) {
    const seconds = trigger.everySeconds
    for (const [size, unit] of [[86400,'day'],[3600,'hour'],[60,'minute']] as const)
      if (seconds % size === 0) return every(seconds / size, unit)
    return every(seconds, 'second')
  }
  const cron = trigger.cron.trim().replace(/\s+/g, ' ')
  const [minute, hour, day, month, weekday] = cron.split(' ')
  let label = `Cron ${cron}`
  if (`${hour} ${day} ${month} ${weekday}` === '* * * *') {
    const step = /^\*\/(\d+)$/.exec(minute)
    if (minute === '*') label = 'Every minute'
    else if (step && Number(step[1]) > 0 && 60 % Number(step[1]) === 0) label = every(Number(step[1]), 'minute')
    else if (/^\d+$/.test(minute)) label = `Hourly at :${minute.padStart(2,'0')}`
  } else if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && ['*','1-5'].includes(weekday)) {
    label = `${weekday === '*' ? 'Daily' : 'Weekdays'} at ${hour.padStart(2,'0')}:${minute.padStart(2,'0')}`
  }
  return `${label} · ${trigger.timezone}`
}

const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const time = (value: number | string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()} · ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC`
}

const preview = (schedule: Schedule) => {
  if (schedule.script) return schedule.script.args.length ? `Arguments: ${schedule.script.args.join(' ')}`.slice(0, 140) : 'No saved arguments'
  const sentence = schedule.text.trim().replace(/\s+/gu,' ').split(/(?<=[.!?])\s/u)[0]
  const chars = Array.from(sentence)
  return chars.length > 140 ? chars.slice(0,139).join('')+'…' : sentence
}

const currentState = (schedule: ScheduledTaskView) =>
  [schedule.runState === 'running' ? '▶ Running' : schedule.runState === 'queued' ? '◌ Queued' : undefined,
    !schedule.enabled ? '⏸ Paused' : undefined].filter(Boolean).join(' · ') || '● Active'

const lastRun = (schedule: ScheduledTaskView) => {
  if (!schedule.lastRun) return '— Not run yet'
  const status = schedule.lastRun.status === 'completed' ? '✓ Completed' : schedule.lastRun.status === 'failed' ? '✕ Failed' : '⊘ Cancelled'
  return `${status} · ${time(schedule.lastRun.at)}${schedule.lastRun.currentRevision ? '' : ' · previous version'}`
}

export const ownedScheduledTasks = (schedules: ScheduledTaskView[], owner: Owner) =>
  schedules.filter((schedule) => ownsSchedule(owner, schedule))
    .sort((a, b) => a.name.localeCompare(b.name))

export const scheduledTasksText = (schedules: ScheduledTaskView[], owner: Owner) => {
  const owned = ownedScheduledTasks(schedules, owner)
  if (!owned.length) return '📅 Scheduled tasks\n\nNo scheduled tasks.'
  const paused = owned.filter(schedule => !schedule.enabled).length
  return [`📅 Scheduled tasks · ${owned.length - paused} active · ${paused} paused`, 'Next/last times UTC. Use /tasks 1 for task details.', ...owned.map((schedule, index) =>
    `${index + 1} · ${schedule.name}\n  ${currentState(schedule)}\n  Schedule · ${frequency(schedule)}\n  Next · ${schedule.nextAt === null ? '—' : time(schedule.nextAt)}\n  Last · ${lastRun(schedule)}\n  Execution · ${engineLabel(schedule)}\n  ${preview(schedule)}`
  )].join('\n\n')
}

export const scheduledTaskDetailText = (schedule: ScheduledTaskView, number: number, total?: number) => {
  const instructions = schedule.script ? preview(schedule) : schedule.text.trim()
  const capped = instructions.length > 2000 ? instructions.slice(0, 2000) + '… (truncated; full text lives in the workspace)' : instructions
  return [
    `📅 ${number}${total === undefined ? '' : ` of ${total}`} · ${schedule.name}`,
    currentState(schedule),
    '',
    'Schedule',
    frequency(schedule),
    '',
    'Next run',
    schedule.nextAt === null ? '—' : time(schedule.nextAt),
    '',
    'Last run',
    lastRun(schedule),
    '',
    'Execution path',
    engineLabel(schedule),
    '',
    schedule.script ? 'Script arguments' : 'Instructions',
    capped,
  ].join('\n')
}
