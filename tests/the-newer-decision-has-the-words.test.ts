import { expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { YourTurnStore } from '../src/main/lib/your-turn-store'

const card = (round: string) => ({ kind: 'decide', by: 'Damon', taskId: 'metrics', title: `Keep METRICS.md over the reviewer's objection? (${round})`, what: `The reviewer said: ${round} objection.` })

test('the third round is decided on the third round’s words', () => {
  const store = new YourTurnStore(mkdtempSync(join(tmpdir(), 'damon-newer-')))
  store.add(card('first'))
  const { item, added } = store.add(card('third'))
  expect(added).toBe(false)
  expect(store.list().filter(i => !i.doneAt)).toHaveLength(1)
  expect(item.title).toContain('third')
  expect(item.what).toContain('third objection')
})
test('a plain hand-over for the same job does not take the decision’s words', () => {
  const store = new YourTurnStore(mkdtempSync(join(tmpdir(), 'damon-newer-')))
  store.add(card('first'))
  const { item } = store.add({ kind: 'review', by: 'Damon', taskId: 'metrics', title: 'Files came back', what: 'Two files.' })
  expect(item.kind).toBe('decide')
  expect(item.what).toContain('first objection')
})
