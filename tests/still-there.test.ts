import { describe, expect, test } from 'vitest'
import { noticeDueAt, SILENCE_LIMIT_MS, waitingNotice } from '../src/shared/turn-patience'

const MIN = 60_000

describe('when Damon speaks up', () => {
  test('the first notice comes early, before anyone starts worrying', () => {
    expect(noticeDueAt(0)).toBeLessThanOrEqual(2 * MIN)
  })

  test('then at a steady interval, not accelerating and not stopping', () => {
    const gaps = [1, 2, 3, 4].map((n) => noticeDueAt(n) - noticeDueAt(n - 1))
    expect(new Set(gaps).size).toBe(1)
    expect(gaps[0]).toBeGreaterThanOrEqual(3 * MIN)
  })

  test('it keeps speaking right up to the moment it gives up', () => {
    const last = [...Array(20).keys()].map(noticeDueAt).filter((t) => t < SILENCE_LIMIT_MS).pop()
    expect(last).toBeGreaterThan(SILENCE_LIMIT_MS - 6 * MIN)
  })
})

describe('what the notice says', () => {
  const said = waitingNotice('Using PowerShell', 8 * MIN)

  test('it names what Damon is sitting on', () => {
    expect(said).toContain('PowerShell')
  })

  test('it says how long, so the number climbing is the proof it is alive', () => {
    expect(said).toContain('8 minutes')
  })

  test('it says when Damon will give up, so the wait has an end the owner can see', () => {
    expect(said).toMatch(/25 minutes|stop/i)
  })

  test('it does not sound like something has gone wrong', () => {
    const lower = said.toLowerCase()
    expect(lower).not.toContain('error')
    expect(lower).not.toContain('failed')
    expect(lower).not.toContain('stuck')
  })

  test('it copes with not knowing what it is waiting on', () => {
    const blind = waitingNotice(undefined, 5 * MIN)
    expect(blind.toLowerCase()).not.toContain('undefined')
    expect(blind).toContain('5 minutes')
  })
})

describe('the limit itself', () => {
  test('is long enough for a cold Rust build, which prints nothing out here', () => {
    expect(SILENCE_LIMIT_MS).toBeGreaterThanOrEqual(20 * MIN)
  })
})
