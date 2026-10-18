export type Repeat =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }
  | { kind: 'hours'; everyHours: number }

export interface Schedule {
  id: string
  text: string
  repeat: Repeat
  paused?: boolean
  nextAt: number
  lastRunAt?: number
  createdAt: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function parseTime(time: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

export function nextRunAt(repeat: Repeat, from: number): number {
  if (repeat.kind === 'hours') {
    const hours = Math.max(1, Math.floor(repeat.everyHours))
    return from + hours * 60 * 60 * 1000
  }
  const at = parseTime(repeat.time)
  if (!at) return from + 24 * 60 * 60 * 1000
  const d = new Date(from)
  d.setHours(at.hour, at.minute, 0, 0)
  if (repeat.kind === 'daily') {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const want = ((Math.floor(repeat.weekday) % 7) + 7) % 7
  let days = (want - d.getDay() + 7) % 7
  if (days === 0 && d.getTime() <= from) days = 7
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function dueSchedules(list: Schedule[], now: number): Schedule[] {
  return list.filter((s) => !s.paused && s.nextAt <= now)
}

export function afterRun(s: Schedule, now: number): Schedule {
  return { ...s, lastRunAt: now, nextAt: nextRunAt(s.repeat, now) }
}

export function describeRepeat(repeat: Repeat): string {
  if (repeat.kind === 'hours') {
    const h = Math.max(1, Math.floor(repeat.everyHours))
    return h === 1 ? 'Every hour' : `Every ${h} hours`
  }
  if (repeat.kind === 'daily') return `Every day at ${repeat.time}`
  return `Every ${WEEKDAYS[((Math.floor(repeat.weekday) % 7) + 7) % 7]} at ${repeat.time}`
}
