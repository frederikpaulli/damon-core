import { describe, expect, test } from 'vitest'
import { reviewerBrief } from '../src/shared/review'
import type { Sighting } from '../src/shared/sighting'

const base = {
  taskTitle: 'Build the group home screen',
  criteria: 'The group list shows every group the person belongs to.',
  artifacts: [{ file: 'apps/mobile/app/home.tsx', how: 'written' as const }],
  round: 1,
  previousObjections: []
}

const seen: Sighting = {
  kind: 'seen',
  how: 'in a browser at 1280 and 390 wide',
  shots: [
    { file: 'damon-shots/home-wide.png', what: 'the group home screen at desktop width', by: 'damon' },
    { file: 'damon-shots/home-phone.png', what: 'the same screen at phone width', by: 'damon' }
  ]
}

describe('a reviewer that has pictures', () => {
  test('is told where they are and told to open them', () => {
    const brief = reviewerBrief({ ...base, sighting: seen })
    expect(brief).toContain('damon-shots/home-phone.png')
    expect(brief).toMatch(/look at (them|these)/i)
  })

  test('is given criteria a person would actually use', () => {
    const brief = reviewerBrief({ ...base, sighting: seen })
    expect(brief).toMatch(/phone width/i)
    expect(brief).toMatch(/read/i)
    expect(brief).toMatch(/clipped|overlap/i)
  })

  test('is told a blank picture is a finding rather than a pass', () => {
    const brief = reviewerBrief({ ...base, sighting: seen })
    expect(brief).toMatch(/blank|empty/i)
  })

  test('is told which pictures came from the owner rather than from Damon', () => {
    const fromOwner: Sighting = {
      kind: 'seen',
      how: 'from the owner, on his own iPhone',
      shots: [{ file: 'attachments/iphone-home.png', what: 'the group home screen on an iPhone', by: 'owner' }]
    }
    const brief = reviewerBrief({ ...base, sighting: fromOwner })
    expect(brief).toMatch(/owner/i)
  })
})

describe('a reviewer that has NO pictures', () => {
  test('is told plainly that nobody looked', () => {
    const brief = reviewerBrief({
      ...base,
      sighting: { kind: 'out-of-reach', why: 'There is no way to render an iPhone screen on Windows.' }
    })
    expect(brief).toMatch(/nobody looked|has not been looked at|no.*picture/i)
  })

  test('is told to say so in its verdict rather than quietly grading the code', () => {
    const brief = reviewerBrief({
      ...base,
      sighting: { kind: 'out-of-reach', why: 'There is no way to render an iPhone screen on Windows.' }
    })
    expect(brief).toMatch(/say so|state that|make clear/i)
  })

  test('carries the reason, so the verdict can repeat it', () => {
    const brief = reviewerBrief({
      ...base,
      sighting: { kind: 'out-of-reach', why: 'There is no way to render an iPhone screen on Windows.' }
    })
    expect(brief).toContain('no way to render an iPhone screen on Windows')
  })
})

describe('a job with nothing to look at', () => {
  test('does not gain a paragraph about screenshots', () => {
    const brief = reviewerBrief({ ...base, sighting: { kind: 'nothing-to-see' } })
    expect(brief).not.toMatch(/screenshot|picture|NOBODY LOOKED/i)
    expect(brief).toContain('Assume this work is wrong')
  })

  test('but a MISSING sighting is treated as nobody having looked', () => {
    const brief = reviewerBrief(base)
    expect(brief).toContain('NOBODY LOOKED AT THIS')
  })

  test('so the two are no longer the same brief', () => {
    const withNothing = reviewerBrief({ ...base, sighting: { kind: 'nothing-to-see' } })
    expect(reviewerBrief(base)).not.toBe(withNothing)
  })
})
