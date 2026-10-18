import { describe, expect, test } from 'vitest'
import {
  contextSizeOf,
  HEAVY_CONTEXT,
  isHeavy,
  recentTalk,
  seedFrom,
  type SeedParts
} from '../src/shared/manager-memory'
import { toManagerEvents } from '../src/main/lib/stream-parser'

const parts = (over: Partial<SeedParts> = {}): SeedParts => ({
  brain: 'The shop sells candles. Decided: no discounts before December.',
  openTasks: [{ title: 'Build the checkout', status: 'working', who: 'Shop Builder' }],
  people: [{ name: 'Shop Builder', role: 'builds the storefront' }],
  recent: [{ role: 'owner', text: 'make the checkout work' }],
  ...over
})

describe('working out how big the conversation is', () => {
  test('the total divided by the steps', () => {
    expect(contextSizeOf(1_000_000, 10)).toBe(100_000)
  })

  test('a busy turn on a small conversation is not called heavy', () => {
    expect(isHeavy(contextSizeOf(800_000, 40))).toBe(false)
  })

  test('a short turn on a huge conversation IS heavy', () => {
    expect(isHeavy(contextSizeOf(300_000, 3))).toBe(true)
  })

  test('missing figures never trigger a replacement', () => {
    expect(isHeavy(contextSizeOf(0, 0))).toBe(false)
  })

  test('the threshold is about double the cost of standing a fresh one up', () => {
    expect(HEAVY_CONTEXT).toBeGreaterThan(38_000 * 1.5)
  })
})

describe('the steps figure reaches the code that needs it', () => {
  test('it is read off the result', () => {
    const [event] = toManagerEvents({
      type: 'result',
      subtype: 'success',
      num_turns: 12,
      usage: { input_tokens: 100, cache_read_input_tokens: 1_200_000 }
    })
    expect(event).toMatchObject({ kind: 'result', steps: 12 })
    expect(contextSizeOf((event as { tokens?: number }).tokens ?? 0, 12)).toBe(100_008)
  })
})

describe('what the fresh conversation is told', () => {
  test('it says outright that this is a continuation', () => {
    const s = seedFrom(parts())
    expect(s).toMatch(/picking this project up mid-flight/i)
    expect(s).toMatch(/do not start again/i)
    expect(s).toMatch(/do not re-plan/i)
  })

  test('it carries the brain, the open jobs, the team and the recent talk', () => {
    const s = seedFrom(parts())
    expect(s).toContain('no discounts before December')
    expect(s).toContain('Build the checkout')
    expect(s).toContain('Shop Builder')
    expect(s).toContain('make the checkout work')
  })

  test('it says where to look for anything missing', () => {
    const s = seedFrom(parts())
    expect(s).toMatch(/read_brain/)
    expect(s).toMatch(/list_tasks/)
    expect(s).toMatch(/rather than guessing/i)
  })

  test('an empty project says so plainly instead of leaving blanks', () => {
    const s = seedFrom(parts({ brain: '', openTasks: [], people: [], recent: [] }))
    expect(s).toContain('(nothing recorded yet)')
    expect(s).toContain('(none open)')
    expect(s).toContain('(nobody has been hired yet)')
  })

  test('a giant brain is cut rather than becoming the thing it replaces', () => {
    const s = seedFrom(parts({ brain: 'x'.repeat(40_000) }))
    expect(s.length).toBeLessThan(20_000)
    expect(s).toMatch(/cut, 40000 characters in all/)
  })
})

describe('which of the conversation comes across', () => {
  const talk = [
    { role: 'user', text: 'first' },
    { role: 'activity', text: 'Damon started a job' },
    { role: 'manager', text: 'second' },
    { role: 'notice', text: 'a package looked odd' },
    { role: 'user', text: 'third' }
  ]

  test('only what was actually said between the two of them', () => {
    expect(recentTalk(talk).map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  test("the owner's lines are the ones the chat store really writes, and are named for the manager", () => {
    const out = recentTalk(talk)
    expect(out[0]).toEqual({ role: 'owner', text: 'first' })
    expect(out.filter((m) => m.role === 'owner')).toHaveLength(2)
    expect(recentTalk([{ role: 'owner', text: 'x' }])).toEqual([{ role: 'owner', text: 'x' }])
  })

  test('the tail, not the head, and in the order it was said', () => {
    expect(recentTalk(talk, 2).map((m) => m.text)).toEqual(['second', 'third'])
  })
})
