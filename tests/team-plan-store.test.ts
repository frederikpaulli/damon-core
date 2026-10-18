import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamPlanStore } from '../src/main/lib/team-plan-store'

const dir = (): string => mkdtempSync(join(tmpdir(), 'damon-plan-'))

const nodes = [
  { name: 'Storefront Lead', role: 'leads the storefront', model: 'claude-sonnet-5', kind: 'submanager' as const },
  { name: 'Web Builder', role: 'builds pages', model: 'claude-sonnet-5', kind: 'agent' as const, parent: 'Storefront Lead' }
]

describe('TeamPlanStore', () => {
  test('propose sets a pending plan with an id; nothing approved yet', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('map text', nodes)
    expect(plan.id).toBeTruthy()
    expect(s.pending()?.id).toBe(plan.id)
    expect(s.approved()).toBeNull()
    expect(s.hasApprovedPlan()).toBe(false)
  })

  test('approve moves pending to approved and counts the headcount it covered', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('m', nodes)
    s.approve(plan.id)
    expect(s.pending()).toBeNull()
    expect(s.approved()?.plan.id).toBe(plan.id)
    expect(s.hasApprovedPlan()).toBe(true)

    expect(s.isExtraHire()).toBe(false)
    s.consumeApproval()
    expect(s.isExtraHire()).toBe(false)
    s.consumeApproval()

    expect(s.hasApprovedPlan()).toBe(true)
    expect(s.isExtraHire()).toBe(true)
  })

  test('approving an unknown id is a no-op', () => {
    const s = new TeamPlanStore(dir())
    s.proposePlan('m', nodes)
    s.approve('nope')
    expect(s.approved()).toBeNull()
  })

  test('an adjustment note is stored with the approval', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('m', nodes)
    s.approve(plan.id, 'go bigger on payments')
    expect(s.approved()?.adjustment).toBe('go bigger on payments')
  })

  test('state persists across instances', () => {
    const d = dir()
    const s = new TeamPlanStore(d)
    const plan = s.proposePlan('m', nodes)
    s.approve(plan.id)
    expect(new TeamPlanStore(d).hasApprovedPlan()).toBe(true)
  })

  test('a proposal keeps the reason given for each brain', () => {
    const s = new TeamPlanStore(dir())
    s.proposePlan('the map', [
      {
        name: 'Researcher',
        role: 'finds the facts',
        model: 'claude-haiku-4-5-20251001',
        kind: 'agent',
        modelWhy: 'Straightforward lookups, so the quickest brain is enough.'
      }
    ])

    expect(s.pending()!.nodes[0]!.modelWhy).toBe('Straightforward lookups, so the quickest brain is enough.')
  })

  test('the owner can change a brain on the pending plan', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('map', [
      { name: 'Writer', role: 'writes', model: 'claude-fable-5', kind: 'agent' }
    ])

    expect(s.setNodeModel(plan.id, 'Writer', 'claude-sonnet-5')).toBe(true)
    expect(s.pending()!.nodes[0]!.model).toBe('claude-sonnet-5')
  })

  test('a stale plan id changes nothing', () => {
    const s = new TeamPlanStore(dir())
    s.proposePlan('map', [{ name: 'Writer', role: 'writes', model: 'claude-fable-5', kind: 'agent' }])

    expect(s.setNodeModel('not-the-plan', 'Writer', 'claude-sonnet-5')).toBe(false)
    expect(s.pending()!.nodes[0]!.model).toBe('claude-fable-5')
  })

  test('an unknown person changes nothing', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('map', [
      { name: 'Writer', role: 'writes', model: 'claude-fable-5', kind: 'agent' }
    ])

    expect(s.setNodeModel(plan.id, 'Nobody', 'claude-sonnet-5')).toBe(false)
  })

  test('an approved plan can no longer be edited', () => {
    const s = new TeamPlanStore(dir())
    const plan = s.proposePlan('map', [
      { name: 'Writer', role: 'writes', model: 'claude-fable-5', kind: 'agent' }
    ])
    s.approve(plan.id)

    expect(s.setNodeModel(plan.id, 'Writer', 'claude-sonnet-5')).toBe(false)
    expect(s.approved()!.plan.nodes[0]!.model).toBe('claude-fable-5')
  })
})
