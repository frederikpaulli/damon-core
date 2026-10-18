import { describe, expect, test } from 'vitest'
import {
  AGENT_MODELS,
  brainsFor,
  canRun,
  openaiLaunchFor,
  OPENAI_AGENT_MODELS,
  providerForModel,
  runnableBrain,
  whyNot
} from '../src/shared/models'
import { codexAdapter } from '../src/main/lib/providers/codex'

const launchArgs = (model: string): string[] =>
  codexAdapter.launch(
    { cliPath: 'codex', model, cwd: '/tmp/x', skipPermissions: true },
    '/tmp/report.txt'
  ).args

describe('the brain the owner chose is actually passed to Codex', () => {
  test('it names a model, which it never used to', () => {
    const args = launchArgs('openai-gpt-5.5')
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5')
  })

  test('the three settings differ only in how hard it thinks', () => {
    expect(openaiLaunchFor('openai-gpt-5.5-low')).toEqual({ model: 'gpt-5.5', effort: 'low' })
    expect(openaiLaunchFor('openai-gpt-5.5')).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    expect(openaiLaunchFor('openai-gpt-5.5-high')).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })

  test('the effort reaches the command line', () => {
    expect(launchArgs('openai-gpt-5.5-high').join(' ')).toContain('model_reasoning_effort=high')
    expect(launchArgs('openai-gpt-5.5-low').join(' ')).toContain('model_reasoning_effort=low')
  })

  test('every offered GPT brain maps to a model the account can actually reach', () => {
    for (const m of OPENAI_AGENT_MODELS) {
      expect(openaiLaunchFor(m.id).model, `${m.id} maps to an unreachable model`).toBe('gpt-5.5')
    }
  })

  test('an id nobody recognises falls back rather than being sent', () => {
    expect(openaiLaunchFor('openai-something-invented')).toEqual({ model: 'gpt-5.5' })
    expect(launchArgs('openai-something-invented').join(' ')).not.toContain('invented')
  })
})

describe('the agents hired before this existed', () => {
  test('a GPT agent from yesterday still runs', () => {
    expect(canRun('agent', 'openai-gpt')).toBe(true)
    expect(whyNot('agent', 'openai-gpt')).toBe('')
    expect(runnableBrain('agent', 'openai-gpt', 'claude-sonnet-5')).toBe('openai-gpt')
  })

  test('and it launches on the same model as the plain setting', () => {
    expect(openaiLaunchFor('openai-gpt').model).toBe('gpt-5.5')
  })

  test('but nobody is offered it any more', () => {
    expect(brainsFor('agent').some((m) => m.id === 'openai-gpt')).toBe(false)
    expect(AGENT_MODELS.some((m) => m.id === 'openai-gpt')).toBe(false)
  })

  test('a retired brain in the wrong seat still gets a real explanation', () => {
    const said = whyNot('lead', 'openai-gpt')
    expect(said).toContain('GPT')
    expect(said.toLowerCase()).toContain('cannot lead a group')
  })
})

describe('the rest of the rules are unmoved by this', () => {
  test('the new ids are still recognised as OpenAI', () => {
    for (const m of OPENAI_AGENT_MODELS) expect(providerForModel(m.id)).toBe('openai')
    expect(providerForModel('openai-gpt')).toBe('openai')
  })

  test('GPT can run Damon and lead a group', () => {
    expect(canRun('manager', 'openai-gpt-5.5')).toBe(true)
    expect(canRun('lead', 'openai-gpt-5.5')).toBe(true)
    expect(canRun('agent', 'openai-gpt-5.5')).toBe(true)
  })
})
