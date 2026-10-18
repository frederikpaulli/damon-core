import { describe, expect, test } from 'vitest'
import { CONNECTOR_PRESETS, isPinned } from '../src/shared/connectors'

describe('what Damon offers to run on your computer', () => {
  test('every preset is pinned to an exact version', () => {
    for (const preset of CONNECTOR_PRESETS) {
      expect(isPinned(preset), `${preset.key} is not pinned`).toBe(true)
    }
  })

  test('nothing floats to latest, however it is written', () => {
    for (const preset of CONNECTOR_PRESETS) {
      const line = [preset.command ?? '', ...(preset.args ?? [])].join(' ')
      expect(line, `${preset.key}`).not.toMatch(/@latest\b/i)
    }
  })

  test('the pinned version really appears in the command that runs', () => {
    for (const preset of CONNECTOR_PRESETS) {
      const line = (preset.args ?? []).join(' ')
      expect(line, `${preset.key}`).toContain(preset.version)
    }
  })

  test('every preset says who publishes it and where the code lives', () => {
    for (const preset of CONNECTOR_PRESETS) {
      expect(preset.publisher.length, `${preset.key}`).toBeGreaterThan(1)
      expect(preset.source.length, `${preset.key}`).toBeGreaterThan(5)
    }
  })

  test('nothing claims to have been vetted, because nothing has been', () => {
    for (const preset of CONNECTOR_PRESETS) {
      const text = `${preset.name} ${preset.blurb} ${preset.publisher} ${preset.needs ?? ''}`
      expect(text, `${preset.key}`).not.toMatch(/checked by us|vetted|audited|verified by|approved by us/i)
    }
  })

  test('the Perplexity entry is the scoped package Perplexity actually publishes', () => {
    const p = CONNECTOR_PRESETS.find((x) => x.key === 'perplexity')!
    const line = (p.args ?? []).join(' ')
    expect(line).toContain('@perplexity-ai/mcp-server')
    expect(line).not.toContain('server-perplexity-ask')
  })

  test('no preset depends on an unscoped npm package name', () => {
    for (const preset of CONNECTOR_PRESETS) {
      if (preset.command !== 'npx') continue
      const pkg = (preset.args ?? []).find((a) => a !== '-y')
      expect(pkg, `${preset.key}`).toMatch(/^@[^/]+\//)
    }
  })
})
