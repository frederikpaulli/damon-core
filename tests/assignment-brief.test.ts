import { expect, it } from 'vitest'
import { assignmentBrief, type AssignmentProfile } from '../src/shared/assignment'

it('the brief tolerates an assignment with no specialities', () => {
  const stored = { responsibility: 'produce', reason: 'why', stopWhen: 'when', maxTurns: 5 } as unknown as AssignmentProfile
  expect(() => assignmentBrief(stored)).not.toThrow()
  expect(assignmentBrief(stored)).toMatch(/General project work/)
})

it('the brief names the specialities when there are some', () => {
  expect(assignmentBrief({ responsibility: 'produce', specialities: ['Rust', 'SQLite'], reason: 'why', stopWhen: 'when', maxTurns: 5 })).toMatch(/Rust, SQLite/)
})
