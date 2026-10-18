import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'src/main/lib/task-engine.ts'), 'utf8')
test('the retry is withheld when every objection is a blocked check', () => {
  expect(src).toContain(String.raw`const onlyBlocked = outcome.objections.length > 0 && outcome.objections.every(o => /^[^:\n]{1,80}: blocked: /.test(o.trim()))`)
  expect(src).toContain('this.roundsUsed(task) < this.maxRounds && !this.atCeiling(task) && !onlyBlocked')
})
test('the shape matches the reviewer’s blocked lines and not a failure', () => {
  const shape = /^[^:\n]{1,80}: blocked: /
  expect(shape.test('s2: blocked: All four originals matched their quoted sha256')).toBe(true)
  expect(shape.test('j4: fail: the report misstates the design doc')).toBe(false)
  expect(shape.test('The reviewer found the draft does not meet the criteria.')).toBe(false)
})
