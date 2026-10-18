import { describe, expect, test } from 'vitest'
import { buildManagerArgs } from '../src/main/lib/manager-session'
import { toManagerEvents } from '../src/main/lib/stream-parser'
import { LAST_CALL, MAX_AGENT_TURNS, MAX_MANAGER_TURNS, outOfStepsNote } from '../src/shared/turns'

const result = (subtype: string): Record<string, unknown> => ({
  type: 'result',
  subtype,
  result: '',
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.5
})

describe('telling "stopped by us" apart from "broke"', () => {
  test('a capped run is marked as out of steps', () => {
    const [event] = toManagerEvents(result('error_max_turns'))
    expect(event).toMatchObject({ kind: 'result', ok: false, outOfSteps: true })
  })

  test('a genuine failure is NOT', () => {
    const [event] = toManagerEvents(result('error_during_execution'))
    expect(event).toMatchObject({ kind: 'result', ok: false })
    expect((event as { outOfSteps?: boolean }).outOfSteps).toBeUndefined()
  })

  test('a capped run still reports what it spent', () => {
    const [event] = toManagerEvents(result('error_max_turns'))
    expect(event).toMatchObject({ tokens: 15, costUsd: 0.5 })
  })
})

describe('the cap reaches the command line', () => {
  test('the manager is capped, where before it was not capped at all', () => {
    const args = buildManagerArgs({ model: 'claude-sonnet-5', skipPermissions: true, maxTurns: MAX_MANAGER_TURNS })
    expect(args).toContain('--max-turns')
    expect(args[args.indexOf('--max-turns') + 1]).toBe(String(MAX_MANAGER_TURNS))
  })

  test('the last-call step carries no tools', () => {
    const args = buildManagerArgs({ model: 'claude-sonnet-5', skipPermissions: true, maxTurns: 1, noTools: true })
    expect(args).not.toContain('Bash')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('""')
  })

  test('an empty tool list still means the default set, not no tools', () => {
    const args = buildManagerArgs({ model: 'claude-sonnet-5', skipPermissions: true, baseTools: [] })
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('Bash')
  })
})

describe('what the last-call step asks for', () => {
  test('it forbids tools and demands the unfinished part', () => {
    expect(LAST_CALL).toMatch(/do not use any tools/i)
    expect(LAST_CALL).toMatch(/did not finish/i)
    expect(LAST_CALL).toMatch(/HANDOVER:/)
  })

  test('it refuses to let partial work be described as done', () => {
    expect(LAST_CALL).toMatch(/not describe unfinished work as done/i)
  })
})

describe('what the manager is told', () => {
  test('the note says it is a progress report, not finished work', () => {
    const note = outOfStepsNote('Schema Engineer', MAX_AGENT_TURNS)
    expect(note).toContain('Schema Engineer')
    expect(note).toContain(String(MAX_AGENT_TURNS))
    expect(note).toMatch(/progress note rather than finished work/i)
  })

  test('it says to split rather than resend', () => {
    expect(outOfStepsNote('Any', 100)).toMatch(/split/i)
  })
})

describe('the caps themselves', () => {
  test('agents get less rope than the manager', () => {
    expect(MAX_AGENT_TURNS).toBeLessThan(MAX_MANAGER_TURNS)
  })

  test('the cap clears the median job by a wide margin', () => {
    expect(MAX_AGENT_TURNS).toBeGreaterThan(38 * 2)
  })
})
