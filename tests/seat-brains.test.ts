import { describe, expect, test } from 'vitest'
import { AGENT_MODELS, brainsFor, canRun, isReady, runnableBrain, whyNot } from '../src/shared/models'

describe('which brains can actually take which seat', () => {
  test('a worker can run on any provider Damon has watched finish a job', () => {
    expect(canRun('agent', 'claude-sonnet-5-5')).toBe(true)
    expect(canRun('agent', 'openai-gpt')).toBe(true)
  })

  test('a provider that cannot actually run work is not offered at all', () => {
    expect(isReady('gemini')).toBe(false)
    expect(canRun('agent', 'gemini')).toBe(false)
    expect(brainsFor('agent').some((m) => m.id === 'gemini')).toBe(false)
  })

  test('it says whose decision that was, so it does not read as a Damon fault', () => {
    const said = whyNot('agent', 'gemini')
    expect(said).toMatch(/Google/i)
    expect(said).toMatch(/not available/i)
    expect(said).toMatch(/paid Gemini key/i)
  })

  test('the ones Damon has watched work are ready', () => {
    expect(isReady('claude-opus-5')).toBe(true)
    expect(isReady('openai-gpt')).toBe(true)
  })

  test('a lead can only run on Claude, because that is all Damon can start', () => {
    expect(canRun('lead', 'claude-sonnet-5-5')).toBe(true)
    expect(canRun('lead', 'openai-gpt')).toBe(false)
    expect(canRun('lead', 'gemini')).toBe(false)
  })

  test('Damon itself can only run on Claude', () => {
    expect(canRun('manager', 'claude-opus-5')).toBe(true)
    expect(canRun('manager', 'openai-gpt')).toBe(false)
  })

  test('a made-up brain is refused in every seat', () => {
    for (const seat of ['manager', 'lead', 'agent'] as const) {
      expect(canRun(seat, 'gpt-9-turbo')).toBe(false)
      expect(canRun(seat, '')).toBe(false)
    }
  })

  test('the picker only ever offers what that seat can run', () => {
    expect(brainsFor('agent').every((m) => canRun('agent', m.id))).toBe(true)
    expect(brainsFor('lead').every((m) => canRun('lead', m.id))).toBe(true)
    expect(brainsFor('lead').every(m => m.provider === 'claude' || m.provider === 'openai')).toBe(true)
    expect(brainsFor('agent').every((m) => isReady(m.id))).toBe(true)
  })

  test('the refusal says why, in the owner words, and names the brain', () => {
    const said = whyNot('lead', 'openai-gpt')
    expect(said).toContain('GPT')
    expect(said).toContain('Claude')
    expect(said).not.toMatch(/launcher|spawn|argv|provider id|CLI/i)
    expect(whyNot('agent', 'openai-gpt')).toBe('')
    expect(whyNot('lead', 'claude-sonnet-5-5')).toBe('')
  })

  test('an unknown brain is refused in plain words rather than silently', () => {
    expect(whyNot('agent', 'gpt-9-turbo')).toContain('gpt-9-turbo')
  })

  test('a stored brain that cannot take the seat falls back instead of launching', () => {
    expect(runnableBrain('lead', 'openai-gpt', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(runnableBrain('lead', 'claude-opus-5', 'claude-sonnet-5-5')).toBe('claude-opus-5')
    expect(runnableBrain('agent', 'openai-gpt', 'claude-sonnet-5-5')).toBe('openai-gpt')
  })

  test('the fallback itself is checked, so a bad one cannot slip through', () => {
    expect(runnableBrain('lead', 'openai-gpt', 'openai-gpt')).toBe('claude-sonnet-5-5')
  })

  test('a brain that was switched off is not started from an old roster', () => {
    expect(runnableBrain('agent', 'gemini', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  })
})
