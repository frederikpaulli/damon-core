import { describe, expect, test } from 'vitest'
import { reviewerBrief } from '../src/shared/review'

const base = {
  taskTitle: 'Build the home screen',
  criteria: 'the main action is obvious at phone width',
  artifacts: [{ file: 'src/Home.tsx', how: 'written' }],
  round: 1,
  previousObjections: []
}

describe('when nobody looked', () => {
  test('no sighting at all still warns the reviewer', () => {
    const brief = reviewerBrief(base)
    expect(brief).toContain('NOBODY LOOKED AT THIS')
  })

  test('and tells it to say so in its verdict rather than write as if it had seen', () => {
    expect(reviewerBrief(base).toLowerCase()).toContain('do not write a verdict that reads as though you had seen it')
  })

  test('a look that was tried and failed warns the same way', () => {
    const brief = reviewerBrief({ ...base, sighting: { kind: 'failed', why: 'the dev server never came up' } })
    expect(brief).toContain('NOBODY LOOKED AT THIS')
    expect(brief).toContain('dev server never came up')
  })
})

describe('when there was nothing to look at', () => {
  test('a job with no visible surface is not nagged about pictures', () => {
    const brief = reviewerBrief({ ...base, sighting: { kind: 'nothing-to-see' } })
    expect(brief).not.toContain('NOBODY LOOKED AT THIS')
  })
})

describe('when somebody did look', () => {
  test('the pictures are named and the reviewer is told to look at them', () => {
    const brief = reviewerBrief({
      ...base,
      sighting: {
        kind: 'seen',
        how: 'by running the project’s own "dev" script and photographing it',
        shots: [{ file: 'damon-shots/1-390w.png', what: 'the home screen at phone width', by: 'damon' }]
      }
    })
    expect(brief).toContain('damon-shots/1-390w.png')
    expect(brief).not.toContain('NOBODY LOOKED AT THIS')
  })
})
