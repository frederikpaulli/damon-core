import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { Row } from '../src/renderer/src/components/YourTurnView'
import { BUTTON, type YourTurnItem } from '../src/shared/your-turn'

const card: YourTurnItem = {
  id: 'private-page:a1', title: 'A teammate wants to open e-boks.dk for "Check the rent letter" (Writer)', kind: 'decide', by: 'Damon', at: '2026-10-04T10:00:00.000Z',
  what: 'What needs you: a yes or a no.\nWhy: x.\nWhat to do: y.', url: 'https://www.e-boks.dk/privat', privatePage: { askId: 'a1', site: 'e-boks.dk' }
}

test('the card offers Allow for this job and Decline, the page under Details, and no Done or chat door', () => {
  const html = renderToString(<Row item={card} projectId="p" busy={false} onDone={() => {}} onPrivatePage={() => {}} />)
  expect(BUTTON.allow).toBe('Allow for this job')
  expect(BUTTON.decline).toBe('Decline')
  expect(html).toContain(`>${BUTTON.allow}<`)
  expect(html).toContain(`>${BUTTON.decline}<`)
  expect(html).toContain(`>${BUTTON.open('the page')}<`)
  expect(html).not.toContain(`>${BUTTON.done}<`)
  expect(html).not.toContain(BUTTON.open('the chat'))
  expect(html.match(/btn small primary/g) ?? []).toHaveLength(1)
})
