import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareLineRange } from '../src/shared/line-range'

const approved = '# Money\n§1 rent\n§2 costs\n§12 end\n'
test('unchanged earlier lines are identical, with the same hashes', () => {
  const draft = approved + '§13 accrual figures\n'
  const r = compareLineRange(draft, approved, 1, 4)
  expect(r.identical).toBe(true)
  expect(r.draftRangeSha256).toBe(r.projectRangeSha256)
})
test('a changed line is found and shown', () => {
  const r = compareLineRange(approved.replace('§2 costs', '§2 expenses'), approved, 1, 4)
  expect(r.identical).toBe(false)
  expect(r.firstDifferentLine).toBe(3)
  expect(r.draftText).toBe('§2 expenses')
})
test('Windows line endings are not a difference', () => {
  expect(compareLineRange(approved.replace(/\n/g, '\r\n'), approved, 1, 4).identical).toBe(true)
})
test('reviewers are offered it', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/lib/protected-review-tools.ts'), 'utf8')
  expect(src).toContain("guarded('compare_to_project'")
  expect(src).toContain('This draft file is new; there is no project version to compare it with.')
})
