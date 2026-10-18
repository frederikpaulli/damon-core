import { expect, test } from 'vitest'
import { objectionTag } from '../src/shared/review-checklist'

test('an account of the review is not a gap', () => {
  expect(objectionTag('Round 4. I read all four pages of draft docs/qa/MONEY_GOLDEN.md (sha 001a11bc…, 2150 lines). compare_to_project shows lines 1–1480 byte-identical.', []).gap).toBe(false)
  expect(objectionTag('I read the whole draft docs/qa/MONEY_GOLDEN.md and re-added every table.', []).gap).toBe(false)
  expect(objectionTag('The reviewer found the draft does not meet the criteria. I read both files.', []).gap).toBe(false)
})
test('a long untagged paragraph is not a gap', () => {
  expect(objectionTag('Every figure must state its basis. '.repeat(12), []).gap).toBe(false)
})
test('a short untagged rule, or a tagged gap, still is', () => {
  expect(objectionTag('Every money table must state the as-of date it was computed at.', []).gap).toBe(true)
  expect(objectionTag('[gap] Round figures must be shown in kroner, not øre.', []).gap).toBe(true)
})
