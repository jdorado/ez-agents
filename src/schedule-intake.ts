import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type Trigger, validateTrigger } from './schedule-time.js'

type Stage = 'title' | 'text' | 'when'
export type ScheduleDraft = { version: 1; userId: number; chatId: number; pairedAt: string; stage: Stage; title?: string; text?: string; trigger?: Trigger }
type Drafts = Record<string, ScheduleDraft>

const key = (userId: number, chatId: number) => `${userId}:${chatId}`
const validDraft = (value: unknown): value is ScheduleDraft => {
  const draft = value as Partial<ScheduleDraft>
  return draft?.version === 1 && Number.isSafeInteger(draft.userId) && Number.isSafeInteger(draft.chatId) && Number.isFinite(Date.parse(draft.pairedAt ?? '')) &&
    ['title', 'when', 'text'].includes(draft.stage ?? '') &&
    (draft.title === undefined || (typeof draft.title === 'string' && draft.title.length <= 120)) &&
    (draft.text === undefined || (typeof draft.text === 'string' && draft.text.length <= 8000)) &&
    (draft.trigger === undefined || (() => { try { validateTrigger(draft.trigger); return true } catch { return false } })())
}

export const scheduleWhenHelp = [
  'Send when this should run:',
  '• once 2026-09-12T09:00:00+04:00',
  '• daily 09:00 Asia/Dubai',
  '• weekdays 09:00 Asia/Dubai',
  '• weekly mon 09:00 Asia/Dubai',
  '• cron 0 9 * * 1-5 Asia/Dubai',
  '',
  'Use an IANA timezone for recurring work. Send cancel to abandon this draft.',
].join('\n')

const weekday: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const parseTime = (value: string) => {
  const match = /^(\d\d):(\d\d)$/.exec(value)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Use a 24-hour time, for example 09:00.')
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export const parseScheduleWhen = (text: string, now = new Date()): Trigger => {
  const once = /^once\s+(.+)$/i.exec(text.trim())
  if (once) return validateTrigger({ at: once[1] })
  const cron = /^cron\s+(.+?)\s+([A-Za-z_]+(?:\/[A-Za-z_+\-\d]+)+)$/i.exec(text.trim())
  if (cron) return validateTrigger({ cron: cron[1], timezone: cron[2], start: now.toISOString() })
  const recurring = /^(daily|weekdays|weekly)\s+(?:(sun|mon|tue|wed|thu|fri|sat)\s+)?(\d\d:\d\d)\s+([A-Za-z_]+(?:\/[A-Za-z_+-]+)+)$/i.exec(text.trim())
  if (!recurring || (recurring[1].toLowerCase() === 'weekly') !== Boolean(recurring[2]))
    throw new Error('Use one of the shown formats, for example daily 09:00 Asia/Dubai.')
  const { hour, minute } = parseTime(recurring[3])
  const day = recurring[1].toLowerCase() === 'daily' ? '*' : recurring[1].toLowerCase() === 'weekdays' ? '1-5' : String(weekday[recurring[2].toLowerCase()])
  return validateTrigger({ cron: `${minute} ${hour} * * ${day}`, timezone: recurring[4], start: now.toISOString() })
}

// This short-lived owner input is persisted so a relay restart never turns a
// following message into agent work. It is not a schedule until Scheduler.save.
export class ScheduleIntake {
  private readonly file: string
  constructor(controlDir: string) { this.file = join(controlDir, 'schedule-drafts.json') }
  private async read(): Promise<Drafts> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(validDraft)) throw new Error('Invalid schedule drafts')
      return value as Drafts
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  private async write(drafts: Drafts) {
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(drafts)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }) }
  }
  async get(userId: number, chatId: number, pairedAt?: string) {
    const draft = (await this.read())[key(userId, chatId)]
    return draft && (!pairedAt || draft.pairedAt === pairedAt) ? draft : undefined
  }
  async start(userId: number, chatId: number, pairedAt: string) {
    const drafts = await this.read()
    drafts[key(userId, chatId)] = { version: 1, userId, chatId, pairedAt, stage: 'title' }
    await this.write(drafts)
  }
  async cancel(userId: number, chatId: number) {
    const drafts = await this.read()
    delete drafts[key(userId, chatId)]
    await this.write(drafts)
  }
  async accept(userId: number, chatId: number, pairedAt: string, text: string): Promise<{ reply: string; complete?: { title: string; trigger: Trigger; text: string } }> {
    const drafts = await this.read(), draft = drafts[key(userId, chatId)]
    if (!draft || draft.pairedAt !== pairedAt) throw new Error('Schedule draft expired')
    if (text.trim().toLowerCase() === 'cancel') {
      delete drafts[key(userId, chatId)]; await this.write(drafts)
      return { reply: 'Schedule draft cancelled.' }
    }
    if (draft.stage === 'title') {
      const title = text.trim().replace(/\s+/g, ' ')
      if (!title || title.length > 120) return { reply: 'Send a title of 1–120 characters.' }
      drafts[key(userId, chatId)] = { ...draft, title, stage: 'text' }; await this.write(drafts)
      return { reply: `Title: ${title}\n\nNow send the task instructions. They will be stored exactly as written.` }
    }
    if (draft.stage === 'text') {
      const body = text.trim()
      if (!body || body.length > 8000) return { reply: 'Send task instructions of 1–8,000 characters.' }
      drafts[key(userId, chatId)] = { ...draft, text: body, stage: 'when' }; await this.write(drafts)
      return { reply: scheduleWhenHelp }
    }
    if (draft.stage === 'when') {
      try {
        const trigger = parseScheduleWhen(text)
        return { reply: '', complete: { title: draft.title!, trigger, text: draft.text! } }
      } catch (error) { return { reply: `${error instanceof Error ? error.message : 'Invalid schedule.'}\n\n${scheduleWhenHelp}` } }
    }
    throw new Error('Invalid schedule draft')
  }
}
