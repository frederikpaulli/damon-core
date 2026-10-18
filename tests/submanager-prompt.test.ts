import { describe, expect, test } from 'vitest'
import { submanagerSystemPrompt } from '../src/main/lib/manager-prompt'

describe('submanagerSystemPrompt', () => {
  test('frames a silent, scoped boss that reports via complete_assignment', () => {
    const p = submanagerSystemPrompt('Shop', 'the storefront', 'Owner prefers DKK.')
    expect(p).toContain('the storefront')
    expect(p.toLowerCase()).toContain('complete_assignment')
    expect(p.toLowerCase()).toMatch(/do not (address|talk to|message|contact) the owner|never (address|talk to|contact) the owner/)
    expect(p).toContain('DKK')
  })

  test('does not offer to appoint further submanagers (three-tier cap)', () => {
    const p = submanagerSystemPrompt('Shop', 'payments', '')
    expect(p.toLowerCase()).not.toContain('create_submanager')
  })
})
