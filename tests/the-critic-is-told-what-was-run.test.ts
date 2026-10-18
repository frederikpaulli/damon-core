import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkResults } from '../src/shared/intended-work'

const intent = { outcome: 'x', assumptions: [], scenarios: [{ id: 'outcome', when: 'a', expected: 'b', check: 'c' }, { id: 'handoff', when: 'a', expected: 'b', check: 'c' }] } as never
const line = (items: unknown[]): string => 'CHECK RESULTS: ' + JSON.stringify(items)
const ok = (id: string) => ({ id, status: 'pass', observed: 'read it', evidence: ['docs/METRICS.md'] })
const tools = [{ tool: 'read_project_file', detail: 'docs/METRICS.md', summary: 'read', ok: true }]

test('an extra check the critic added is set aside, not a problem', () => {
  const r = checkResults(line([ok('outcome'), ok('handoff'), ok('j1')]), intent, tools)
  expect(r.problems).toEqual([])
})
test('a required scenario left out is still "not tested", and a duplicate still counts', () => {
  expect(checkResults(line([ok('outcome'), ok('j1')]), intent, tools).problems).toEqual(['handoff: not tested.'])
  expect(checkResults(line([ok('outcome'), ok('outcome'), ok('handoff')]), intent, tools).problems).toEqual(['Unknown, missing or duplicate scenario ID.'])
})
