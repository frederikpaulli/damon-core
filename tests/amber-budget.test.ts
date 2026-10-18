import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
const files = ['src/renderer/src/styles.css', ...readdirSync('src/renderer/src/styles').map((f) => `src/renderer/src/styles/${f}`)]
const rules = files.flatMap((f) => [...readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ f, sel: m[1]!.trim(), body: m[2]! })))
const AMBER = /var\(--amber(?:-deep|-lift)?\)|rgba\(232,\s*161,\s*61/
describe('no card border or divider is amber', () => {
  test('border and inset-edge declarations never take amber, except on focus and fields being edited', () => {
    const bad = rules.filter((r) => /border(?:-left|-color|-left-color)?\s*:[^;]*/.test(r.body) && r.body.split(';').some((d) => /^\s*border/.test(d) && AMBER.test(d)))
      .filter((r) => !/:focus|textarea|input|\.project-rename-input|\.msg\.typing|\.your-turn-edit|\.your-turn-sending|\.incidents-waiting|\.release-prepared|\.acc-update|\.data-use\.warn|\.onboarding-choice:hover/.test(r.sel))
    expect(bad.map((r) => `${r.f.split('/').pop()} ${r.sel}`)).toEqual([])
  })
  test('the rail spends no amber', () => {
    const rail = rules.filter((r) => /\.rail\b|\.rail-row\.selected/.test(r.sel) && AMBER.test(r.body))
    expect(rail.map((r) => r.sel)).toEqual([])
    expect(rules.find((r) => r.sel === '.rail .status-dot.needs-you, .rail .status-dot.working')?.body).toMatch(/var\(--text\)/)
  })
  test('a link is text-coloured at rest and amber only when pointed at or focused', () => {
    for (const sel of ['.linkish', '.dash-link']) {
      expect(rules.find((r) => r.sel === sel)?.body).toMatch(/color:\s*var\(--text\)/)
    }
  })
})
