import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamPlanStore, type TeamPlanNode } from '../src/main/lib/team-plan-store'

const nodes = (n: number): TeamPlanNode[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `Person ${i + 1}`,
    role: 'does a thing',
    model: 'claude-sonnet-5',
    kind: 'agent' as const
  }))

function store(): TeamPlanStore {
  return new TeamPlanStore(mkdtempSync(join(tmpdir(), 'damon-plan-')))
}

describe('an approved team', () => {
  test('stays approved after everyone in it has been created', () => {
    const s = store()
    const plan = s.proposePlan('the map', nodes(3))
    s.approve(plan.id)

    s.consumeApproval()
    s.consumeApproval()
    s.consumeApproval()

    expect(s.hasApprovedPlan()).toBe(true)
  })

  test('lets the manager add two more without proposing a new chart', () => {
    const s = store()
    const plan = s.proposePlan('the map', nodes(3))
    s.approve(plan.id)
    for (let i = 0; i < 3; i++) s.consumeApproval()

    expect(s.hasApprovedPlan()).toBe(true)
    s.consumeApproval()
    expect(s.hasApprovedPlan()).toBe(true)
    s.consumeApproval()
    expect(s.hasApprovedPlan()).toBe(true)

    expect(s.approved()?.plan.nodes).toHaveLength(3)
  })

  test('says which hires were beyond the headcount the owner saw', () => {
    const s = store()
    const plan = s.proposePlan('the map', nodes(2))
    s.approve(plan.id)

    expect(s.isExtraHire()).toBe(false)
    s.consumeApproval()
    expect(s.isExtraHire()).toBe(false)
    s.consumeApproval()

    expect(s.isExtraHire()).toBe(true)
    s.consumeApproval()
    expect(s.isExtraHire()).toBe(true)
  })

  test('nothing is approved before the owner has said yes to anything', () => {
    const s = store()
    expect(s.hasApprovedPlan()).toBe(false)
    s.proposePlan('the map', nodes(3))
    expect(s.hasApprovedPlan()).toBe(false)
  })

  test('a brand new proposal supersedes the old approval', () => {
    const s = store()
    const first = s.proposePlan('map one', nodes(2))
    s.approve(first.id)
    expect(s.hasApprovedPlan()).toBe(true)

    s.proposePlan('map two', nodes(5))
    expect(s.hasApprovedPlan()).toBe(false)
  })

  test('clearing the team clears the approval', () => {
    const s = store()
    const plan = s.proposePlan('the map', nodes(2))
    s.approve(plan.id)
    s.clearApproved()
    expect(s.hasApprovedPlan()).toBe(false)
  })

  test('the count never runs below zero, however many are added', () => {
    const s = store()
    const plan = s.proposePlan('the map', nodes(1))
    s.approve(plan.id)
    for (let i = 0; i < 20; i++) s.consumeApproval()
    expect(s.hasApprovedPlan()).toBe(true)
    expect(s.isExtraHire()).toBe(true)
  })
})
