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

export const scheduledTasksText = (schedules: ActiveSchedule[], owner: Owner) => {
  const owned = schedules.filter((schedule) => ownsSchedule(owner, schedule))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!owned.length) return 'Active scheduled tasks\n\nNo active scheduled tasks for this owner.'
  return ['Active scheduled tasks', ...owned.map((schedule) => {
    const preset = displayedPreset(schedule)
    const sentence = schedule.text.trim().replace(/\s+/gu,' ').split(/(?<=[.!?])\s/u)[0]
    const chars = Array.from(sentence)
    const preview = chars.length > 140 ? chars.slice(0,139).join('')+'…' : sentence
    const next = schedule.nextAt === null ? '' : `Next: ${new Date(schedule.nextAt).toISOString().replace('T',' ').replace('.000Z',' UTC')}`
    const timing = [schedule.runState === 'running' ? 'Running' : schedule.runState === 'queued' ? 'Queued' : '',next].filter(Boolean).join(' · ')
    return `• ${schedule.name}\n  ${presetLabel(preset)}\n  ${timing}\n  ${preview}`
  })].join('\n\n')
}
