import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('ten tries with a growing pause', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/lib/json-file.ts'), 'utf8')
  expect(src).toContain('for (let attempt = 0; attempt < 10; attempt++) {')
  expect(src).toContain("if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break")
  expect(src).toContain('40 * (attempt + 1)')
})
