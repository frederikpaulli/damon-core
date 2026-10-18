import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedRequest } from '../src/main/lib/isolated-worker'

test('an argument of 60,000 characters is accepted', () => {
  expect(() => isolatedRequest.parse({ command: 'node', args: ['-e', 'x'.repeat(60_000)], inputs: [], outputs: ['a/b.md'], timeoutSeconds: 60 })).not.toThrow()
})
