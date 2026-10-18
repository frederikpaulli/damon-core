import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { escalationTo, isForOwner, stallSummary } from '../src/shared/escalation'

const engine = readFileSync(join(__dirname, '..', 'src', 'main', 'lib', 'task-engine.ts'), 'utf8')

const STEMS = [
  'ended its turn without reporting back',
  'Required inputs could not be reserved',
  'The person this was given to is no longer on the team'
]

describe('the manager-bound stems', () => {
  test.each(STEMS)('"%s" is still written by task-engine.ts', (stem) => {
    expect(engine, `task-engine.ts no longer writes "${stem}" — update shared/escalation.ts with it`).toContain(stem)
  })

  test.each(STEMS)('a legacy row saying "%s" goes to the manager, not the owner', (stem) => {
    const task = { status: 'escalated' as const, result: `Something happened. ${stem}: and the rest of the sentence.` }
    expect(escalationTo(task)).toBe('manager')
    expect(isForOwner(task)).toBe(false)
    expect(stallSummary(task)).not.toBe('This went back to the manager unfinished.')
  })

  test('a legacy row with no known stem goes to the owner, so a fix for noise cannot hide a question', () => {
    const task = { status: 'escalated' as const, result: 'I need a decision about the pricing before I can go on.' }
    expect(escalationTo(task)).toBe('owner')
    expect(isForOwner(task)).toBe(true)
  })

  test('the recorded field wins over the words', () => {
    expect(escalationTo({ escalation: 'owner', result: `x ${STEMS[0]} y` })).toBe('owner')
    expect(escalationTo({ escalation: 'manager', result: 'please decide' })).toBe('manager')
  })
})
