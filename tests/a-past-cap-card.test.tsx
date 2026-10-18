import { expect, test } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { Row } from '../src/renderer/src/components/YourTurnView'
import { closableQuestion, leadFor, type YourTurnItem } from '../src/shared/your-turn'
import { YourTurnStore } from '../src/main/lib/your-turn-store'

const card: YourTurnItem = {
  id: 'c1', title: 'Try “Sweep” once more?', what: 'Damon’s reviewers sent this work back 9 times across 2 tries.', kind: 'decide', by: 'Damon', at: '2026-10-11T03:00:00.000Z',
  key: 'past-cap:r:2', pastCap: { root: 'r', step: 2 }
}

test('the card shows Try once more and Stop here, each explained, and is not a plain question', () => {
  const html = renderToString(<Row item={card} projectId="p" busy={false} onDone={() => {}} onPastCap={() => {}} />)
  expect(html).toContain('>Try once more<')
  expect(html).toContain('>Stop here<')
  expect(html).not.toContain('>Done<')
  expect(leadFor(card)).toMatch(/Try once more/)
  expect(leadFor(card)).toMatch(/Stop here/)
  expect(closableQuestion(card)).toBe(false)
})

test('the store keeps the pastCap field on the card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-pastcap-'))
  const store = new YourTurnStore(dir)
  const { item } = store.add({ key: 'past-cap:r:2', kind: 'decide', by: 'Damon', title: 't', what: 'w', pastCap: { root: 'r', step: 2 } } as never)
  expect(item.pastCap).toEqual({ root: 'r', step: 2 })
})

test('his answer is recorded on the card and closes it as his', () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-pastcap-'))
  const store = new YourTurnStore(dir)
  const { item } = store.add({ key: 'past-cap:r:2', kind: 'decide', by: 'Damon', title: 't', what: 'w', pastCap: { root: 'r', step: 2 } } as never)
  const done = store.answerPastCap(item.id, false)
  expect(done).toMatchObject({ answeredBy: 'owner', pastCap: { answer: 'no' } })
  expect(done?.doneAt).toBeTruthy()
  expect(store.answerPastCap(item.id, true)).toBeNull()
  const again = store.add({ key: 'past-cap:r:3', kind: 'decide', by: 'Damon', title: 't2', what: 'w', pastCap: { root: 'r', step: 3 } } as never).item
  expect(store.list().find(i => i.id === again.id)?.pastCap?.answer).toBeUndefined()
})
