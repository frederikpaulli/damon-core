import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDER_NOT_ALLOWED } from '../src/main/lib/execution-policy'

const policy = readFileSync(join(process.cwd(), 'src/main/lib/execution-policy.ts'), 'utf8')
const engine = readFileSync(join(process.cwd(), 'src/main/lib/task-engine.ts'), 'utf8')
test('the refusal names the provider separately from a switched-off project', () => {
  expect(PROVIDER_NOT_ALLOWED).toBe('This project’s execution permissions do not include')
  expect(policy).toContain("if (!record.providers.includes(provider)) throw Error(`${PROVIDER_NOT_ALLOWED}")
})
test('the engine escalates it to the manager before the generic re-queue', () => {
  const escalate = engine.indexOf('/execution permissions do not include/i.test(outcome.resultText')
  const requeue = engine.indexOf('/could not (?:be admitted|start)|waited too long for protected execution capacity/i.test(outcome.resultText')
  expect(escalate).toBeGreaterThan(0)
  expect(escalate).toBeLessThan(requeue)
})
test('a job whose wait for a free seat ran out goes back in the queue, not to failed (C317)', () => {
  expect(engine).toContain('/could not (?:be admitted|start)|waited too long for protected execution capacity/i.test(outcome.resultText')
})
