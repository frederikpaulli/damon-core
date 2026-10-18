import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamPlanStore } from '../src/main/lib/team-plan-store'
import { clampBrain } from '../src/shared/models'

describe('the brain ceiling', () => {
  test('a proposal above the ceiling is stored clamped, so the gate cannot be walked around', () => {
    const store = new TeamPlanStore(mkdtempSync(join(tmpdir(), 'damon-ceiling-')))
    const ceiling = 'claude-sonnet-5'
    store.proposePlan(
      'map',
      [{ name: 'Spendy', role: 'writes', model: 'claude-fable-5', kind: 'agent' as const }].map((n) => ({
        ...n,
        model: clampBrain(n.model, ceiling)
      }))
    )

    expect(store.pending()!.nodes[0]!.model).toBe('claude-sonnet-5-5')
  })

  test('the owner is told exactly who was moved and to what', () => {
    const ceiling = 'claude-sonnet-5'
    const nodes = [
      { name: 'Spendy', role: 'writes', model: 'claude-fable-5', kind: 'agent' as const },
      { name: 'Thrifty', role: 'looks things up', model: 'claude-haiku-4-5-20251001', kind: 'agent' as const }
    ]
    const clamped = nodes.map((n) => ({ ...n, model: clampBrain(n.model, ceiling) }))
    const lowered = clamped.filter((n, i) => n.model !== nodes[i]!.model)

    expect(lowered.map((n) => `${n.name} moved to ${n.model}`)).toEqual(['Spendy moved to claude-sonnet-5-5'])
  })

  test('with no ceiling set, nothing is touched and nothing is announced', () => {
    const nodes = [{ name: 'Spendy', role: 'writes', model: 'claude-fable-5', kind: 'agent' as const }]
    const clamped = nodes.map((n) => ({ ...n, model: clampBrain(n.model, '') }))

    expect(clamped.filter((n, i) => n.model !== nodes[i]!.model)).toHaveLength(0)
  })
})
