import { describe, expect, test } from 'vitest'
import { PROVIDERS } from '../src/shared/providers'

const byId = (id: string): (typeof PROVIDERS)[number] => PROVIDERS.find((p) => p.id === id)!

describe('what each provider does with your work', () => {
  test('every provider says, so none can be connected without the owner knowing', () => {
    for (const p of PROVIDERS) {
      expect(p.dataUse.what.length).toBeGreaterThan(20)
      expect(p.dataUse.change.length).toBeGreaterThan(10)
    }
  })

  test('native subscription accounts do not claim their actual privacy settings were checked', () => {
    for (const id of ['claude', 'openai']) {
      expect(byId(id).dataUse.settingsUnverified).toBe(true)
      expect(byId(id).dataUse.what).toContain('Damon has not checked your setting')
    }
  })

  test('a provider that trains says how to stop it, or says plainly that you cannot', () => {
    expect(byId('openai').dataUse.change).toMatch(/Data Controls/i)
    expect(byId('gemini').dataUse.change).toMatch(/key|Workspace/i)
    expect(byId('gemini').dataUse.what).toMatch(/no switch/i)
  })

  test('none of it reads like a legal notice', () => {
    for (const p of PROVIDERS) {
      const text = `${p.dataUse.what} ${p.dataUse.change}`
      expect(text).not.toMatch(/pursuant|herein|terms of service|opt-in|opt-out|telemetry|PII/i)
    }
  })
})
