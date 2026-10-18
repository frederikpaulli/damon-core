import { expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { projectVersionToCompare } from '../src/main/lib/project-version-to-compare'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'damon-compare-'))
mkdirSync(join(root, 'docs'))
const before = '# Metrics\nyield on value\n', landed = '# Metrics\nyield on value only\n'

test('the replaced version is used while it is still the project file', () => {
  writeFileSync(join(root, 'docs/METRICS.md'), before)
  expect(projectVersionToCompare(root, 'docs/METRICS.md', sha(before))).toEqual({ text: before, against: 'replaced' })
})
test('after an earlier result landed, the file as it stands is used and named', () => {
  writeFileSync(join(root, 'docs/METRICS.md'), landed)
  expect(projectVersionToCompare(root, 'docs/METRICS.md', sha(before))).toEqual({ text: landed, against: 'current' })
})
test('a missing file is still a refusal', () => {
  expect(() => projectVersionToCompare(root, 'docs/GONE.md', sha(before))).toThrow()
})
