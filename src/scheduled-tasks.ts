import type { Owner } from './control-state.js'
import { nextOccurrence, type Trigger } from './schedule-time.js'
import type { Schedule } from './scheduler.js'

const ownsSchedule = (owner: Owner, schedule: Schedule) =>
  schedule.owner.telegramUserId === owner.telegramUserId &&
  schedule.owner.telegramChatId === owner.telegramChatId &&
  schedule.owner.pairedAt === owner.pairedAt

const timing = (trigger: Trigger) => {
  if ('at' in trigger) return `One time · ${trigger.at}`
  if ('everySeconds' in trigger) return `Every ${trigger.everySeconds} seconds · from ${trigger.start}${trigger.until ? ` · until ${trigger.until}` : ''}`
  return `Cron ${trigger.cron} · ${trigger.timezone} · from ${trigger.start}${trigger.until ? ` · until ${trigger.until}` : ''}`
}

export const scheduledTasksText = (schedules: Schedule[], owner: Owner, now = Date.now()) => {
  const owned = schedules.filter((schedule) => ownsSchedule(owner, schedule))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!owned.length) return 'Scheduled tasks\n\nNo scheduled tasks for this owner.'
  return ['Scheduled tasks', ...owned.map((schedule) => {
    const next = schedule.enabled ? nextOccurrence(schedule.trigger, now) : null
    const state = !schedule.enabled ? 'Paused' : next === null ? 'Completed' :
      schedule.when === 'unreviewed-failures' ? 'Scheduled when unreviewed failures exist' : 'Scheduled'
    return [
      '',
      `Title: ${schedule.name}`,
      `Instructions:\n${schedule.text}`,
      `Timing: ${timing(schedule.trigger)}`,
      `State: ${state}`,
      `Next run: ${next === null ? 'None' : new Date(next).toISOString()}`,
    ].join('\n')
  })].join('\n')
}
