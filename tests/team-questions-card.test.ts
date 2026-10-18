import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEAM_QUESTIONS_TITLE, isTeamQuestions, teamQuestionsCard } from '../src/shared/your-turn'
import { YourTurnStore } from '../src/main/lib/your-turn-store'

describe('the questions card', () => {
  test('is a decision that lists every question', () => {
    const card = teamQuestionsCard(['Who is it for?', 'App store or website?', 'Personal or public?'])
    expect(card.kind).toBe('decide')
    expect(card.title).toBe(TEAM_QUESTIONS_TITLE)
    expect(card.what).toContain('- Who is it for?')
    expect(card.what).toContain('- Personal or public?')
    expect(card.what).toContain('Open the chat')
  })

  test('goes on the list once, and is recognised until it is done', () => {
    const store = new YourTurnStore(mkdtempSync(join(tmpdir(), 'damon-yt-')))
    const first = store.add({ ...teamQuestionsCard(['Who is it for?']), by: 'Damon' })
    const again = store.add({ ...teamQuestionsCard(['Who is it for?']), by: 'Damon' })
    expect(first.added).toBe(true)
    expect(again.added).toBe(false)
    expect(store.open().filter(isTeamQuestions)).toHaveLength(1)
    store.done(first.item.id)
    expect(store.open().filter(isTeamQuestions)).toHaveLength(0)
    expect(isTeamQuestions({ title: TEAM_QUESTIONS_TITLE, by: 'Scout' })).toBe(false)
  })
})
