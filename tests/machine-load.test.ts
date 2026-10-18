import { describe, expect, test } from 'vitest'
import { MAX_AT_ONCE, agentsAtOnce, buildJobs } from '../src/main/lib/machine-load'

describe('how many agents a machine can actually carry', () => {
  test('a four-core ultrabook runs two, not three', () => {
    expect(agentsAtOnce(8)).toBe(2)
    expect(agentsAtOnce(4)).toBe(1)
  })

  test('a big machine is still capped, because cores stop being the limit', () => {
    expect(agentsAtOnce(64)).toBe(MAX_AT_ONCE)
  })

  test('a tiny machine still runs one, because zero agents is not a fleet', () => {
    expect(agentsAtOnce(1)).toBe(1)
    expect(agentsAtOnce(2)).toBe(1)
  })

  test('nonsense in does not produce a nonsense fleet size', () => {
    expect(agentsAtOnce(Number.NaN)).toBe(1)
    expect(agentsAtOnce(-4)).toBe(1)
  })
})

describe('how many threads one agent may compile with', () => {
  test('the cores are split between the agents that can run at once', () => {
    expect(buildJobs(8, 2)).toBe(3)
    expect(buildJobs(16, 3)).toBe(4)
  })

  test('never zero, however small the machine', () => {
    expect(buildJobs(2, 3)).toBe(1)
    expect(buildJobs(1, 1)).toBe(1)
  })

  test('the fleet never asks for more threads than the machine has', () => {
    for (const cores of [2, 4, 8, 12, 16, 32]) {
      const atOnce = agentsAtOnce(cores)
      expect(atOnce * buildJobs(cores, atOnce)).toBeLessThanOrEqual(cores)
    }
  })

  test('nonsense in does not produce a nonsense job count', () => {
    expect(buildJobs(Number.NaN, 2)).toBe(1)
    expect(buildJobs(8, 0)).toBeGreaterThanOrEqual(1)
  })
})
