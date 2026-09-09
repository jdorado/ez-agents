// Calendar plumbing only. The agent translates natural language to these explicit rules.
export type Trigger = { at: string } | { everySeconds: number; start: string; until?: string } |
  { cron: string; timezone: string; start: string; until?: string }

const instant = (value: string): number => {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('Use an ISO timestamp with an explicit timezone offset')
  return Date.parse(value)
}
const field = (text: string, min: number, max: number): number[] => {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!match) throw new Error('Unsupported cron field')
    const step = Number(match[2] || 1)
    const [lo, hi] = match[1] === '*' ? [min, max] : match[1].split('-').map(Number)
    const end = hi ?? (match[2] ? max : lo)
    if (step < 1 || step > max + 1 || lo < min || end > max || lo > end) throw new Error('Cron field out of range')
    for (let n = lo; n <= end; n += step) values.add(n)
  }
  return [...values].sort((a,b) => a-b)
}
const calendar = (cron: string) => {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('Use five cron fields: minute hour day month weekday (0 or 7 = Sunday)')
  return { parts, minutes: field(parts[0],0,59), hours: field(parts[1],0,23), days: field(parts[2],1,31),
    months: field(parts[3],1,12), weekdays: field(parts[4],0,7).map(n => n % 7) }
}
const formatter = (timezone: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
})
const wall = (f: Intl.DateTimeFormat, at: number): number => {
  const p = Object.fromEntries(f.formatToParts(at).map(p => [p.type, p.value]))
  return Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute)
}
export function validateTrigger(value: unknown): Trigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schedule trigger')
  const t = value as Trigger
  if ('at' in t) {
    if (Object.keys(t).some(k => k !== 'at')) throw new Error('One-time trigger cannot include recurrence')
    instant(t.at); return { at:t.at }
  }
  instant(t.start)
  if (t.until && instant(t.until) < instant(t.start)) throw new Error('End must follow start')
  if ('everySeconds' in t) {
    if (!Number.isSafeInteger(t.everySeconds) || !Number.isSafeInteger(t.everySeconds * 1000) || t.everySeconds < 60) throw new Error('Interval must be at least 60 seconds')
    return {everySeconds:t.everySeconds,start:t.start,...(t.until ? {until:t.until} : {})}
  }
  if (typeof t.cron !== 'string' || typeof t.timezone !== 'string') throw new Error('Cron requires an IANA timezone')
  calendar(t.cron); formatter(t.timezone).format()
  return {cron:t.cron,timezone:t.timezone,start:t.start,...(t.until ? {until:t.until} : {})}
}
export function nextOccurrence(trigger: Trigger, after: number): number | null {
  if ('at' in trigger) return instant(trigger.at) > after ? instant(trigger.at) : null
  const start = instant(trigger.start), until = trigger.until ? instant(trigger.until) : Infinity
  if ('everySeconds' in trigger) {
    const interval = trigger.everySeconds * 1000
    const next = start + Math.max(0, Math.floor((after-start)/interval)+1)*interval
    return next <= until ? next : null
  }
  const from = Math.max(after+1,start)
  if (from > until) return null
  const f = formatter(trigger.timezone), c = calendar(trigger.cron)
  const local = new Date(wall(f,from))
  const firstDay = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())
  // Bounded calendar search (includes leap-day schedules), not minute-by-minute polling.
  for (let d=0; d<=366*8; d++) {
    const day = firstDay+d*86400000, date = new Date(day)
    if (day-86400000 > until) break
    if (!c.months.includes(date.getUTCMonth()+1)) continue
    const dom = c.days.includes(date.getUTCDate()), dow = c.weekdays.includes(date.getUTCDay())
    if (!(c.parts[2].startsWith('*') || c.parts[4].startsWith('*') ? dom && dow : dom || dow)) continue
    const offsets = new Set([-86400000,0,86400000].map(delta => wall(f,day+delta)-(day+delta)))
    let best = Infinity
    for (const h of c.hours) for (const m of c.minutes) {
      const desired = day+h*3600000+m*60000
      const candidates = [...offsets].map(offset => desired-offset).filter(at => wall(f,at) === desired)
      // Skip nonexistent wall times; use the first occurrence of a repeated DST time.
      const at = Math.min(...candidates)
      if (at >= from && at <= until) best = Math.min(best,at)
    }
    if (Number.isFinite(best)) return best
  }
  return null
}
