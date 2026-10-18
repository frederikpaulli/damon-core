import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
test('the shape it accepts', () => {
  const ok = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)
  expect(ok(String.raw`C:\dev\Pet Tracker`)).toBe(true)
  expect(ok('C:devPet Tracker')).toBe(false)
})
