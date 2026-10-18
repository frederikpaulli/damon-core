import { expect, test } from 'vitest'
import { MAX_AGENT_TURNS, MIN_ASSIGNED_TURNS, assignedTurns } from '../src/shared/turns'

test('a budget under the floor is raised to it', () => {
  expect(assignedTurns(undefined, 6)).toBe(MIN_ASSIGNED_TURNS)
})
test('a budget above the floor is kept', () => {
  expect(assignedTurns(undefined, 30)).toBe(30)
})
test('the agent’s own ceiling still wins', () => {
  expect(assignedTurns(8, 30)).toBe(8)
  expect(assignedTurns(undefined, 500)).toBe(MAX_AGENT_TURNS)
})
