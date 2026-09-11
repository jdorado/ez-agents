import type { Owner } from './control-state.js'
import { nextOccurrence } from './schedule-time.js'
import type { Schedule } from './scheduler.js'

const weekdays: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' }
const time = (hour: string, minute: string) => `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`

export const ownsSchedule = (owner: Owner, schedule: Schedule) => schedule.owner.telegramUserId === owner.telegramUserId &&
  schedule.owner.telegramChatId === owner.telegramChatId && schedule.owner.pairedAt === owner.pairedAt

export const scheduleTitle = (schedule: Schedule) => schedule.name.replace(/\s+/g, ' ').trim().slice(0, 120)

export const scheduleTiming = (schedule: Schedule) => {
  const trigger = schedule.trigger
  if ('at' in trigger) return `Once · ${trigger.at}`
  if ('everySeconds' in trigger) return `Every ${trigger.everySeconds}s · starts ${trigger.start}`
  const [minute, hour, , , weekday] = trigger.cron.trim().split(/\s+/)
  const frequency = weekday === '*' ? 'Daily' : weekday === '1-5' ? 'Weekdays' : weekdays[weekday] ? `Weekly ${weekdays[weekday]}` : 'Recurring'
  return `${frequency} at ${time(hour, minute)} · ${trigger.timezone}`
}

export const scheduleNext = (schedule: Schedule, now = Date.now()) => {
  if (!schedule.enabled) return 'paused'
  const next = nextOccurrence(schedule.trigger, now)
  return next === null ? 'no future occurrence' : new Date(next).toISOString()
}

export const scheduledTasksText = (schedules: Schedule[], now = Date.now()) => {
  const ordered = [...schedules].sort((left, right) => scheduleTitle(left).localeCompare(scheduleTitle(right)))
  if (!ordered.length) return 'Scheduled tasks\nNone scheduled.'
  return ['Scheduled tasks', '', ...ordered.map((schedule) => `• ${scheduleTitle(schedule)}\n  ${scheduleTiming(schedule)} · ${schedule.enabled ? 'scheduled' : 'paused'} · next: ${scheduleNext(schedule, now)}`)].join('\n')
}
