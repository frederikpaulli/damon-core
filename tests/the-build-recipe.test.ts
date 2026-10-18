import { expect, it } from 'vitest'
import { buildPieces, managerSystemPrompt, MANAGER_PROMPT_VERSION } from '../src/main/lib/manager-prompt'

const tools = new Set(['assign_work', 'request_revision', 'approve_task', 'skills', 'write_brain', 'hand_to_owner'])

it('the recipe names a feature job, its checkpoints, the piece, and screens first', () => {
  const text = buildPieces(tools, 1)
  expect(text).toMatch(/## A build piece/)
  expect(text).toMatch(/size "feature"/)
  expect(text).toMatch(/checkpoints/)
  expect(text).toMatch(/stage "screen"/)
  expect(text).toMatch(/stage "wire"/)
  expect(text).toMatch(/one feature job at a time/)
  expect(text).toMatch(/never ask a reviewer to skip a check/i)
  expect(text).toMatch(/CONTRACT FIRST/)
})

it('AMENDED: never stop the project for one card; a piece of about 20 files, read by two reviewers side by side', () => {
  const text = buildPieces(tools, 1)
  expect(text).toMatch(/Never stop the project for one card: keep building independent work while a card waits\./)
  expect(text).toMatch(/about 20 changed files/)
  expect(text).toMatch(/two reviewers side by side/)
})

it('it is in the protected prompt, version 53 (54 since C573), and not on a seat without assign_work', () => {
  expect(MANAGER_PROMPT_VERSION).toBe(57)
  expect(managerSystemPrompt('P', '', true, true, ['claude'], undefined, 'protected', tools)).toMatch(/## A build piece/)
  expect(buildPieces(new Set(['skills']), 1)).toBe('')
})
