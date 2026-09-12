import type { Owner } from './control-state.js'
import type { Schedule } from './scheduler.js'

const ownsSchedule = (owner: Owner, schedule: Schedule) =>
  schedule.owner.telegramUserId === owner.telegramUserId &&
  schedule.owner.telegramChatId === owner.telegramChatId &&
  schedule.owner.pairedAt === owner.pairedAt

export const scheduledTasksText = (schedules: Schedule[], owner: Owner) => {
  const owned = schedules.filter((schedule) => ownsSchedule(owner, schedule))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!owned.length) return 'Scheduled tasks\n\nNo scheduled tasks for this owner.'
  return ['Scheduled tasks', '', ...owned.map((schedule) => `• ${schedule.name}`)].join('\n')
}
