import { describe, expect, test } from 'vitest'
import { allowanceLines, meterOf, spendGroup, whereItWent } from '../src/shared/meter'
import type { SpendEntry } from '../src/shared/types'

const entry = (over: Partial<SpendEntry>): SpendEntry => ({
  at: '2026-08-27T10:00:00.000Z',
  actor: 'manager',
  name: 'Damon',
  model: 'claude-opus-5',
  provider: 'claude',
  costUsd: 0,
  tokens: 0,
  reported: true,
  ...over
})

describe('what a single turn is worth recording', () => {
  test('the conversation size is the total divided by the steps', () => {
    expect(meterOf(551_000, 10).contextTokens).toBe(55_100)
  })

  test('a turn with no step count records no conversation size rather than a wrong one', () => {
    expect(meterOf(551_000, undefined).contextTokens).toBeUndefined()
    expect(meterOf(551_000, undefined).steps).toBeUndefined()
  })

  test('the allowance reading travels with the run that was in flight', () => {
    const m = meterOf(24_000, 1, {
      utilization: 0.42,
      rateLimitType: 'seven_day',
      resetsAt: 1_772_000_000,
      isUsingOverage: false
    })
    expect(m.quota?.utilization).toBe(0.42)
    expect(m.quota?.rateLimitType).toBe('seven_day')
  })

  test('no reading is recorded as absent, never as zero', () => {
    expect(meterOf(24_000, 1).quota).toBeUndefined()
  })
})

describe('the groups the owner actually asked about', () => {
  test('a manager turn he started is not the same thing as one Damon started', () => {
    expect(spendGroup(entry({ actor: 'manager', turnKind: 'owner' }))).toBe('your messages')
    expect(spendGroup(entry({ actor: 'manager', turnKind: 'routine' }))).toBe('Damon working on its own')
  })

  test('a manager turn recorded before this existed is not guessed at', () => {
    expect(spendGroup(entry({ actor: 'manager' }))).toBe('Damon (not recorded which)')
  })

  test('the checker is told apart from the agents it checks', () => {
    expect(spendGroup(entry({ actor: 'agent', name: 'Reviewer' }))).toBe('the checker')
    expect(spendGroup(entry({ actor: 'agent', name: 'Database Engineer' }))).toBe('the team doing the work')
    expect(spendGroup(entry({ actor: 'lead', name: 'Backend Lead' }))).toBe('leads')
  })
})

describe('reading the answer back out of the log', () => {
  const window = { rateLimitType: 'seven_day', resetsAt: 1_772_000_000 }

  test('it attributes the allowance actually consumed, not the tokens', () => {
    const said = whereItWent([
      entry({ at: '2026-08-27T10:00:00.000Z', turnKind: 'owner', tokens: 500_000, quota: { utilization: 0.1, ...window } }),
      entry({ at: '2026-08-27T10:05:00.000Z', turnKind: 'owner', tokens: 500_000, quota: { utilization: 0.3, ...window } }),
      entry({ at: '2026-08-27T10:10:00.000Z', actor: 'agent', name: 'Scout', tokens: 2_000_000, quota: { utilization: 0.32, ...window } })
    ])
    expect(said.byActor['your messages']!.allowanceUsed).toBeCloseTo(0.2, 5)
    expect(said.byActor['the team doing the work']!.allowanceUsed).toBeCloseTo(0.02, 5)
  })

  test('the first reading is a baseline, not a bill', () => {
    const said = whereItWent([
      entry({ at: '2026-08-27T10:00:00.000Z', turnKind: 'owner', tokens: 1, quota: { utilization: 0.6, ...window } })
    ])
    expect(said.byActor['your messages']!.allowanceUsed).toBe(0)
  })

  test('a new window is a new baseline, never a refund', () => {
    const later = { rateLimitType: 'seven_day', resetsAt: 1_773_000_000 }
    const said = whereItWent([
      entry({ at: '2026-08-27T10:00:00.000Z', turnKind: 'owner', tokens: 1, quota: { utilization: 0.9, ...window } }),
      entry({ at: '2026-08-27T11:00:00.000Z', turnKind: 'owner', tokens: 1, quota: { utilization: 0.02, ...later } }),
      entry({ at: '2026-08-27T11:30:00.000Z', turnKind: 'owner', tokens: 1, quota: { utilization: 0.05, ...later } })
    ])
    expect(said.byActor['your messages']!.allowanceUsed).toBeCloseTo(0.03, 5)
  })

  test('runs with no reading are counted but never guessed at', () => {
    const said = whereItWent([
      entry({ actor: 'agent', name: 'Scout', tokens: 900, model: 'openai-gpt-5.5', provider: 'openai' }),
      entry({ actor: 'agent', name: 'Scout', tokens: 100, model: 'openai-gpt-5.5', provider: 'openai' })
    ])
    expect(said.byActor['the team doing the work']!.runs).toBe(2)
    expect(said.byActor['the team doing the work']!.tokens).toBe(1000)
    expect(said.byActor['the team doing the work']!.allowanceUsed).toBeUndefined()
  })

  test('it reports the average steps and conversation size per actor', () => {
    const said = whereItWent([
      entry({ tokens: 100_000, steps: 10, contextTokens: 10_000 }),
      entry({ tokens: 300_000, steps: 10, contextTokens: 30_000 })
    ])
    expect(said.byActor['Damon (not recorded which)']!.averageSteps).toBe(10)
    expect(said.byActor['Damon (not recorded which)']!.averageContext).toBe(20_000)
  })

  test('an empty log says nothing rather than zero', () => {
    const said = whereItWent([])
    expect(Object.keys(said.byActor)).toHaveLength(0)
    expect(said.readings).toBe(0)
  })

  test('it says how many real readings it had, so the answer can be judged', () => {
    const said = whereItWent([
      entry({ tokens: 1, quota: { utilization: 0.1, ...window } }),
      entry({ tokens: 1 }),
      entry({ tokens: 1, quota: { utilization: 0.2, ...window } })
    ])
    expect(said.readings).toBe(2)
  })
})

describe('what the owner reads on the Spending screen', () => {
  test('before any reading exists it says so instead of showing zeroes', () => {
    const said = allowanceLines(whereItWent([]))
    expect(said.lines).toHaveLength(0)
    expect(said.note.toLowerCase()).toContain('not recorded a reading yet')
  })

  test('the biggest user comes first and is named in plain words', () => {
    const window = { rateLimitType: 'seven_day', resetsAt: 1_772_000_000 }
    const said = allowanceLines(
      whereItWent([
        entry({ at: '2026-08-27T10:00:00.000Z', turnKind: 'owner', quota: { utilization: 0.0, ...window } }),
        entry({ at: '2026-08-27T10:01:00.000Z', actor: 'agent', name: 'Scout', quota: { utilization: 0.05, ...window } }),
        entry({ at: '2026-08-27T10:02:00.000Z', turnKind: 'owner', quota: { utilization: 0.45, ...window } })
      ])
    )
    expect(said.lines[0]).toContain('your messages')
    expect(said.lines[0]).toContain('40%')
    expect(said.lines[1]).toContain('the team doing the work')
  })

  test('it says how many readings it rests on, so a thin answer looks thin', () => {
    const window = { rateLimitType: 'seven_day', resetsAt: 1_772_000_000 }
    const said = allowanceLines(
      whereItWent([
        entry({ at: '2026-08-27T10:00:00.000Z', quota: { utilization: 0.1, ...window } }),
        entry({ at: '2026-08-27T10:01:00.000Z', quota: { utilization: 0.2, ...window } })
      ])
    )
    expect(said.note).toContain('2 readings')
  })

  test('a group that used nothing measurable is left out rather than shown as 0%', () => {
    const window = { rateLimitType: 'seven_day', resetsAt: 1_772_000_000 }
    const said = allowanceLines(
      whereItWent([
        entry({ at: '2026-08-27T10:00:00.000Z', turnKind: 'owner', quota: { utilization: 0.0, ...window } }),
        entry({ at: '2026-08-27T10:01:00.000Z', turnKind: 'owner', quota: { utilization: 0.4, ...window } }),
        entry({ at: '2026-08-27T10:02:00.000Z', actor: 'agent', name: 'Scout' })
      ])
    )
    expect(said.lines).toHaveLength(1)
    expect(said.lines[0]).toContain('your messages')
  })
})
