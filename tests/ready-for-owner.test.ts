import { describe, expect, test } from 'vitest'
import { readyForOwner, type YourTurnItem } from '../src/shared/your-turn'

const item = (kind: YourTurnItem['kind'], doneAt?: string): YourTurnItem => ({
  id: kind + (doneAt ?? ''),
  title: 't',
  what: 'w',
  kind,
  by: 'Damon',
  at: '2026-09-06T08:00:00.000Z',
  doneAt
})

describe('what counts as ready for the owner', () => {
  test('an open item that asks something counts; finished files and done items do not', () => {
    const items = [item('send'), item('decide'), { ...item('check'), file: 'out/report.md' }, item('login', '2026-09-06T09:00:00.000Z')]
    expect(readyForOwner({ items })).toBe(2)
  })

  test('an open connection Damon cannot reach counts; a resolved one does not', () => {
    expect(readyForOwner({ items: [], blockers: [{}, { resolvedAt: '2026-09-06T09:00:00.000Z' }] })).toBe(1)
  })

  test('a question Damon is waiting on counts', () => {
    expect(readyForOwner({ items: [item('pay')], blockers: [{}], needs: 1 })).toBe(3)
  })
})

import { readyForOwner as ready2, groupItems as group2, type YourTurnItem as Item2 } from '../src/shared/your-turn'
test('a card waiting on Damon is counted nowhere and drawn under Not ready yet', () => {
  const card: Item2 = { id: 'w', title: 'Submit it', what: 'x', kind: 'submit', by: 'Damon', at: '2026-09-16T20:00:00.000Z', url: 'https://example.com/a', waitingOn: 'Resolve and independently review: a check is open.' }
  expect(ready2({ items: [card] })).toBe(0)
  expect(group2([card]).map(g => g.key)).toEqual(['waiting'])
  expect(ready2({ items: [{ ...card, waitingOn: undefined }] })).toBe(1)
})
