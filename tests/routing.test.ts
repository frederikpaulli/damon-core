import { describe, expect, test } from 'vitest'
import { allowedBrains, checkRouting, trainsOnYourWork } from '../src/shared/routing'

const OPEN = { touchesPersonalData: false, noTrainingProviders: false }
const PERSONAL = { touchesPersonalData: true, noTrainingProviders: false }
const STRICT = { touchesPersonalData: false, noTrainingProviders: true }

describe('which providers train on your work', () => {
  test('Claude does not, the others do', () => {
    expect(trainsOnYourWork('claude-opus-5')).toBe(false)
    expect(trainsOnYourWork('openai-gpt')).toBe(true)
    expect(trainsOnYourWork('gemini')).toBe(true)
  })
})

describe('deciding where work may go', () => {
  test('ordinary work goes anywhere, with nothing to say about it', () => {
    expect(checkRouting('openai-gpt', OPEN)).toEqual({ allow: true })
    expect(checkRouting('claude-opus-5', OPEN)).toEqual({ allow: true })
  })

  test('work involving real people warns before it goes to a training provider', () => {
    const verdict = checkRouting('gemini', PERSONAL)
    expect(verdict.allow).toBe(true)
    expect(verdict.warn).toMatch(/real people/i)
    expect(verdict.warn).toContain('Gemini')
    expect(verdict.warn).toMatch(/train/i)
  })

  test('the same work on Claude says nothing, because there is nothing to say', () => {
    expect(checkRouting('claude-sonnet-5', PERSONAL)).toEqual({ allow: true })
  })

  test('a project set to keep work off training providers refuses, it does not warn', () => {
    const verdict = checkRouting('openai-gpt', STRICT)
    expect(verdict.allow).toBe(false)
    expect(verdict.warn).toMatch(/train/i)
    expect(verdict.warn).toMatch(/Claude/i)
  })

  test('refusing wins over warning when both are set', () => {
    const verdict = checkRouting('gemini', { touchesPersonalData: true, noTrainingProviders: true })
    expect(verdict.allow).toBe(false)
  })

  test('nothing reads like a legal notice', () => {
    for (const handling of [PERSONAL, STRICT]) {
      const said = checkRouting('gemini', handling).warn ?? ''
      expect(said).not.toMatch(/PII|GDPR|data processor|compliance|terms of service/i)
    }
  })
})

describe('narrowing the picker instead of refusing afterwards', () => {
  const brains = [{ id: 'claude-opus-5' }, { id: 'openai-gpt' }, { id: 'gemini' }]

  test('an ordinary project is offered everything', () => {
    expect(allowedBrains(brains, OPEN)).toHaveLength(3)
  })

  test('a strict project is only offered what it can actually use', () => {
    expect(allowedBrains(brains, STRICT).map((b) => b.id)).toEqual(['claude-opus-5'])
  })

  test('a project that only warns still gets the full choice', () => {
    expect(allowedBrains(brains, PERSONAL)).toHaveLength(3)
  })
})
