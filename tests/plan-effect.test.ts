import { describe, expect, test } from 'vitest'
import { planEffect, proposalHeadline } from '../src/shared/plan-effect'
import { RosterStore } from '../src/main/lib/roster-store'
import { brainWords, brainShort } from '../src/shared/models'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const people = (names: string[]): Array<{ name: string; kind: 'agent' }> => names.map((name) => ({ name, kind: 'agent' }))

describe('what a plan does to the team you have', () => {
  const current = people(['A', 'B', 'C', 'D', 'E'])

  test('five kept and two added: 2 join, 5 stay, nobody stands down', () => {
    const e = planEffect(people(['A', 'B', 'C', 'D', 'E', 'F', 'G']), current)
    expect(e).toEqual({ joins: 2, stays: 5, standsDown: 0 })
    const line = proposalHeadline(e, 7)
    expect(line).toBe('I propose 2 more people; the 5 you have stay.')
    expect(line).not.toMatch(/replace/i)
  })

  test('names match the way the roster matches them: case and spaces do not make a new person', () => {
    expect(planEffect(people([' a ', 'B']), people(['A', 'b']))).toEqual({ joins: 0, stays: 2, standsDown: 0 })
  })

  test('a lead and a worker with one name are two seats', () => {
    const e = planEffect([{ name: 'Sam', kind: 'submanager' }], [{ name: 'Sam', kind: 'agent' }])
    expect(e).toEqual({ joins: 1, stays: 0, standsDown: 1 })
  })

  test('people who are not on the plan stand down, and the headline says so', () => {
    const e = planEffect(people(['A', 'X']), current)
    expect(e).toEqual({ joins: 1, stays: 1, standsDown: 4 })
    expect(proposalHeadline(e, 2)).toBe('I propose a team of 2: 1 join, 1 stay, 4 stand down.')
  })

  test('nobody on the team yet: a team of n', () => {
    expect(proposalHeadline(planEffect(people(['A', 'B']), []), 2)).toBe('I propose a team of 2.')
  })

  test('one more person is singular', () => {
    expect(proposalHeadline({ joins: 1, stays: 3, standsDown: 0 }, 4)).toBe('I propose 1 more person; the 3 you have stay.')
  })

  test('the roster rebuild agrees with the effect it announced', () => {
    const roster = new RosterStore(mkdtempSync(join(tmpdir(), 'plan-effect-')))
    for (const a of ['A', 'B', 'C']) roster.add(a, 'r', undefined)
    const nodes = [
      ...people(['A', 'B', 'N1', 'N2']).map((p) => ({ ...p, role: 'r', model: 'claude-sonnet-5-5' }))
    ]
    const e = planEffect(nodes, roster.list())
    const r = roster.buildFromPlan(nodes)
    expect({ joins: r.hired.length, stays: r.kept.length, standsDown: r.stoodDown.length }).toEqual(e)
  })
})

describe('the headline with exactly one person kept', () => {
  test('reads naturally', () => {
    expect(proposalHeadline({ joins: 2, stays: 1, standsDown: 0 }, 3)).toBe('I propose 2 more people; the one you have stays.')
    expect(proposalHeadline({ joins: 0, stays: 1, standsDown: 0 }, 1)).toBe('I propose no new people; the one you have stays.')
  })
})

describe('brain words', () => {
  test.each([
    ['claude-fable-5-1', 'the strongest brain', 'strongest brain'],
    ['claude-opus-5-5', 'a strong brain', 'strong brain'],
    ['claude-sonnet-5-5', 'a mid brain', 'mid brain'],
    ['claude-haiku-4-5-20251001', 'the quickest brain', 'quickest brain'],
    ['openai-gpt-5.5', "another provider's brain", 'other brain'],
    ['openai-gpt', "another provider's brain", 'other brain'],
    ['gemini', "another provider's brain", 'other brain'],
    ['something-new', 'a brain', 'brain']
  ])('%s', (id, words, short) => {
    expect(brainWords(id)).toBe(words)
    expect(brainShort(id)).toBe(short)
    expect(brainWords(id)).not.toMatch(/Haiku|Opus|Sonnet|Fable|GPT|Gemini/i)
  })
})
