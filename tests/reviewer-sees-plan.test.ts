import { describe, expect, test } from 'vitest'
import { reviewerBrief } from '../src/shared/review'

describe('the reviewer and the plan', () => {
  const base = { taskTitle: 'Build the about page', criteria: 'It exists', artifacts: [], round: 1, previousObjections: [] }
  test('the plan is in the brief, as context and not as a standard', () => {
    const brief = reviewerBrief({ ...base, agentPlan: '1. Make about.html\n2. Link it' })
    expect(brief).toContain('The plan the agent set out with')
    expect(brief).toContain('1. Make about.html')
    expect(brief).toContain('not a standard of its own')
  })
  test('no plan, no such section', () => {
    expect(reviewerBrief(base)).not.toContain('The plan the agent set out with')
  })
})
