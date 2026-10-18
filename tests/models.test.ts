import { describe, expect, test } from 'vitest'
import { BRAIN_RANK, brainsFor, canRun, clampBrain, MANAGER_MODELS, offeredBrains, runnableBrain } from '../src/shared/models'

describe('MANAGER_MODELS', () => {
  test('offers the Claude models, with Opus 5.5 recommended first and the older ones legacy (C239)', () => {
    expect(MANAGER_MODELS.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001'
    ])
    expect(MANAGER_MODELS[0]!.label).toBe('Opus 5.5')
    expect(MANAGER_MODELS.filter((m) => m.legacy).map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'])
  })

  test('every model has a human label', () => {
    for (const m of MANAGER_MODELS) {
      expect(m.label.length).toBeGreaterThan(2)
    }
  })
})

describe('clampBrain', () => {
  test('lowers a Claude brain that is above the ceiling', () => {
    expect(clampBrain('claude-fable-5', 'claude-sonnet-5')).toBe('claude-sonnet-5-5')
  })

  test('leaves a brain at or under the ceiling alone', () => {
    expect(clampBrain('claude-sonnet-5', 'claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(clampBrain('claude-haiku-4-5-20251001', 'claude-opus-5')).toBe('claude-haiku-4-5-20251001')
  })

  test('does nothing when no ceiling is set', () => {
    expect(clampBrain('claude-fable-5', '')).toBe('claude-fable-5')
  })

  test('ignores non-Claude brains, which are billed to a different account', () => {
    expect(clampBrain('openai-gpt', 'claude-haiku-4-5-20251001')).toBe('openai-gpt')
    expect(clampBrain('gemini', 'claude-haiku-4-5-20251001')).toBe('gemini')
  })

  test('passes an unknown id through rather than silently downgrading it', () => {
    expect(clampBrain('claude-something-new', 'claude-sonnet-5')).toBe('claude-something-new')
  })

  test('an unknown ceiling does not clamp anything', () => {
    expect(clampBrain('claude-fable-5', 'claude-not-a-model')).toBe('claude-fable-5')
  })

  test('the ranking covers every Claude brain the owner can pick', () => {
    for (const m of MANAGER_MODELS) {
      expect(BRAIN_RANK[m.id], `${m.id} is missing from BRAIN_RANK`).toBeGreaterThan(0)
    }
  })
})

describe('a legacy brain', () => {
  test('is not offered, and still runs for whoever has it', () => {
    for (const seat of ['manager', 'lead', 'agent'] as const) {
      expect(brainsFor(seat).map((m) => m.id)).not.toContain('claude-opus-5')
      expect(canRun(seat, 'claude-opus-5')).toBe(true)
      expect(runnableBrain(seat, 'claude-opus-5', 'claude-opus-5-5')).toBe('claude-opus-5')
    }
  })
  test('shows in the picker as itself only while it is the current choice', () => {
    expect(offeredBrains('lead', 'claude-opus-5').map((m) => m.id)).toContain('claude-opus-5')
    expect(offeredBrains('lead', 'claude-opus-5-5').map((m) => m.id)).not.toContain('claude-opus-5')
  })
})
