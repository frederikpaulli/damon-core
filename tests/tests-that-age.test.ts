import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_AFTER_MS } from '../src/main/lib/task-engine'

const DIR = 'tests'
const files = readdirSync(join(process.cwd(), DIR)).filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))

const drivesTheEngine = (text: string): boolean => /new TaskEngine\s*\(/.test(text)

const stamps = (text: string): string[] =>
  [...text.matchAll(/(?:createdAt|updatedAt):\s*'(\d{4}-\d{2}-\d{2}T[^']*)'/g)].map((m) => m[1]!)

describe('no test is waiting to fail on a date nobody chose', () => {
  test('a test that drives the engine uses no stamp older than the archive window', () => {
    const now = Date.now()
    const rotten: string[] = []
    for (const f of files) {
      const text = readFileSync(join(process.cwd(), DIR, f), 'utf8')
      if (!drivesTheEngine(text)) continue
      for (const at of stamps(text)) {
        const age = now - Date.parse(at)
        if (Number.isFinite(age) && age > ARCHIVE_AFTER_MS) {
          rotten.push(`${f} stamps ${at}, which is ${Math.round(age / 86_400_000)} days old against a ${Math.round(ARCHIVE_AFTER_MS / 86_400_000)}-day archive window`)
        }
      }
    }
    expect(
      rotten,
      'These will fail on a date nobody chose. Build the stamp from Date.now() instead:\n  ' + rotten.join('\n  ')
    ).toEqual([])
  })

  test('and the window this is measured against is the engine’s own, not a copy', () => {
    expect(ARCHIVE_AFTER_MS).toBeGreaterThan(0)
    const engine = readFileSync(join(process.cwd(), 'src/main/lib/task-engine.ts'), 'utf8')
    expect(engine).toMatch(/export const ARCHIVE_AFTER_MS/)
  })
})
