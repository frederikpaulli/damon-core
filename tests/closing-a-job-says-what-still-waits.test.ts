import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterDropSentence } from '../src/shared/scope'

const tasks = [
  { id: 'old', title: 'Piece 1, step A, second retry' },
  { id: 'split1', title: 'Money golden portfolio, split 1 of 6', needs: ['old'] },
  { id: 'stepB', title: 'Piece 1, step B', needs: ['a29', 'old'] },
  { id: 'p2', title: 'Piece 2', needs: ['stepB'] }
]

test('the jobs still waiting are named, with how to release them', () => {
  const s = afterDropSentence(tasks, 'old')
  expect(s).toContain('"Money golden portfolio, split 1 of 6" (id split1)')
  expect(s).toContain('"Piece 1, step B" (id stepB)')
  expect(s).not.toContain('Piece 2')
  expect(s).toContain('amend')
  expect(afterDropSentence(tasks, 'p2')).toBe('Nothing was waiting for it.')
})

test('an approved job is not named as still waiting', () => {
  const s = afterDropSentence([...tasks, { id: 'check', title: 'Independent check of Piece 1', needs: ['old'], status: 'approved' }], 'old')
  expect(s).not.toContain('Independent check of Piece 1')
  expect(s).toContain('"Piece 1, step B" (id stepB)')
})
