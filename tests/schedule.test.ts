import { describe, expect, test } from 'vitest'
import { afterRun, describeRepeat, dueSchedules, nextRunAt, type Schedule } from '../src/shared/schedule'

const now = new Date(2026, 6, 24, 9, 30).getTime()
const at = (ms: number): Date => new Date(ms)

describe('nextRunAt', () => {
  test('every day: later today if it has not passed, otherwise tomorrow', () => {
    const later = at(nextRunAt({ kind: 'daily', time: '18:00' }, now))
    expect(later.getDate()).toBe(24)
    expect(later.getHours()).toBe(18)

    const tomorrow = at(nextRunAt({ kind: 'daily', time: '08:00' }, now))
    expect(tomorrow.getDate()).toBe(25)
    expect(tomorrow.getHours()).toBe(8)
  })

  test('every week: the next time that weekday comes round', () => {
    const monday = at(nextRunAt({ kind: 'weekly', time: '07:15', weekday: 1 }, now))
    expect(monday.getDay()).toBe(1)
    expect(monday.getDate()).toBe(27)
    expect(monday.getHours()).toBe(7)
    expect(monday.getMinutes()).toBe(15)
  })

  test('every week on today: later today counts, earlier means next week', () => {
    expect(at(nextRunAt({ kind: 'weekly', time: '18:00', weekday: 5 }, now)).getDate()).toBe(24)
    expect(at(nextRunAt({ kind: 'weekly', time: '08:00', weekday: 5 }, now)).getDate()).toBe(31)
  })

  test('every so many hours counts from now, and never zero', () => {
    expect(nextRunAt({ kind: 'hours', everyHours: 6 }, now)).toBe(now + 6 * 3600_000)
    expect(nextRunAt({ kind: 'hours', everyHours: 0 }, now)).toBe(now + 3600_000)
  })

  test('a nonsense time does not wedge the schedule', () => {
    expect(nextRunAt({ kind: 'daily', time: '99:99' }, now)).toBe(now + 24 * 3600_000)
  })
})

describe('dueSchedules', () => {
  const s = (id: string, nextAt: number, paused?: boolean): Schedule => ({
    id,
    text: 'check the orders',
    repeat: { kind: 'daily', time: '08:00' },
    nextAt,
    paused,
    createdAt: ''
  })

  test('only what is due, and never anything paused', () => {
    const due = dueSchedules([s('a', now - 1000), s('b', now + 1000), s('c', now - 5000, true)], now)
    expect(due.map((x) => x.id)).toEqual(['a'])
  })
})

describe('afterRun', () => {
  test('moves on to the next time rather than catching up on every one missed', () => {
    const missed: Schedule = {
      id: 'a',
      text: 'x',
      repeat: { kind: 'daily', time: '08:00' },
      nextAt: now - 3 * 24 * 3600_000,
      createdAt: ''
    }
    const moved = afterRun(missed, now)
    expect(moved.lastRunAt).toBe(now)
    expect(at(moved.nextAt).getDate()).toBe(25)
    expect(dueSchedules([moved], now)).toEqual([])
  })
})

describe('describeRepeat', () => {
  test('reads as plain English', () => {
    expect(describeRepeat({ kind: 'daily', time: '08:00' })).toBe('Every day at 08:00')
    expect(describeRepeat({ kind: 'weekly', time: '07:15', weekday: 1 })).toBe('Every Monday at 07:15')
    expect(describeRepeat({ kind: 'hours', everyHours: 6 })).toBe('Every 6 hours')
    expect(describeRepeat({ kind: 'hours', everyHours: 1 })).toBe('Every hour')
  })
})
