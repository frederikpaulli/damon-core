import { describe, expect, test } from 'vitest'
import { blocksApproval, sawNothing, sightingNote, type Sighting } from '../src/shared/sighting'

const seen: Sighting = {
  kind: 'seen',
  how: 'in a browser at 1280 and 390 wide',
  shots: [{ file: 'damon-shots/home.png', what: 'the group home screen at phone width', by: 'damon' }]
}
const nothing: Sighting = { kind: 'nothing-to-see' }
const outOfReach: Sighting = { kind: 'out-of-reach', why: 'There is no way to render an iPhone screen on Windows.' }
const failed: Sighting = { kind: 'failed', why: 'The app was started but never answered on its address.' }

describe('what stops a job passing', () => {
  test('a job that could not be started when it should have been does', () => {
    expect(blocksApproval(failed)).toBe(true)
  })

  test('a known limit does not', () => {
    expect(blocksApproval(outOfReach)).toBe(false)
  })

  test('work with nothing to look at does not', () => {
    expect(blocksApproval(nothing)).toBe(false)
  })

  test('a job that was seen does not', () => {
    expect(blocksApproval(seen)).toBe(false)
  })
})

describe('what travels with the verdict', () => {
  test('a job that was seen says how it was looked at', () => {
    expect(sightingNote(seen)).toMatch(/browser/)
  })

  test('a known limit says so plainly, and is not an apology', () => {
    const said = sightingNote(outOfReach)
    expect(said).toMatch(/no way to render an iPhone/i)
    expect(said).not.toMatch(/sorry|unfortunately|apolog/i)
  })

  test('a failure says what went wrong', () => {
    expect(sightingNote(failed)).toMatch(/never answered/)
  })

  test('work with nothing to look at says nothing at all', () => {
    expect(sightingNote(nothing)).toBe('')
  })
})

describe('whether anybody actually looked', () => {
  test('only the seen case counts as looked at', () => {
    expect(sawNothing(seen)).toBe(false)
    expect(sawNothing(outOfReach)).toBe(true)
    expect(sawNothing(failed)).toBe(true)
    expect(sawNothing(nothing)).toBe(true)
  })

  test('seen with an empty list of pictures is not seen', () => {
    expect(sawNothing({ kind: 'seen', how: 'in a browser', shots: [] })).toBe(true)
  })
})
