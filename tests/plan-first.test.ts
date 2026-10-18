import { describe, expect, test } from 'vitest'
import { changesFiles, planFinding, planIn, planInstruction, planNote, LATE_PLAN_NOTE, cannotMeetIn, parkSentence, parkStatusLine } from '../src/shared/plan-first'

describe('reading the plan off what the agent said', () => {
  test('the block from PLAN: to the end of the message', () => {
    const said = 'Looking at the folder first.\n\nPLAN:\n1. Make src/pages/about.html\n2. Link it from index.html\n3. Open both and check the link'
    expect(planIn(said)).toBe('1. Make src/pages/about.html\n2. Link it from index.html\n3. Open both and check the link')
  })
  test('words on the PLAN: line itself count, and a later labelled block ends it', () => {
    expect(planIn('PLAN: build the form, then the handler.\nCheck by submitting it.\n\nHANDOVER:\n- x: y')).toBe(
      'build the form, then the handler.\nCheck by submitting it.'
    )
  })
  test('no PLAN: line, no plan; an empty one is no plan either', () => {
    expect(planIn('I will start by making the page.')).toBeNull()
    expect(planIn('PLAN:\n')).toBeNull()
  })
  test('a very long plan is bounded', () => {
    expect(planIn('PLAN:\n' + 'step '.repeat(1000))!.length).toBeLessThanOrEqual(1800)
  })
})

describe('what counts as changing the project', () => {
  test('writing and editing do; reading, searching and running do not', () => {
    expect(changesFiles('Write')).toBe(true)
    expect(changesFiles('Edit')).toBe(true)
    expect(changesFiles('Read')).toBe(false)
    expect(changesFiles('Grep')).toBe(false)
    expect(changesFiles('Bash')).toBe(false)
  })
})

describe('the finding', () => {
  test('a first round that changed files with no plan is a finding', () => {
    expect(planFinding({ firstRound: true, plan: null, changedFiles: true })?.kind).toBe('no-plan')
  })
  test('D1.7: a plan written after the first change is a recorded note, not a finding', () => {
    expect(planFinding({ firstRound: true, plan: { text: 'x', beforeChanges: false }, changedFiles: true })).toBeNull()
    expect(planNote({ firstRound: true, plan: { text: 'x', beforeChanges: false }, changedFiles: true })).toBe(LATE_PLAN_NOTE)
    expect(planNote({ firstRound: true, plan: { text: 'x', beforeChanges: true }, changedFiles: true })).toBeNull()
    expect(planNote({ firstRound: false, plan: { text: 'x', beforeChanges: false }, changedFiles: true })).toBeNull()
    expect(planNote({ firstRound: true, plan: null, changedFiles: true })).toBeNull()
    expect(planNote({ firstRound: true, plan: { text: 'x', beforeChanges: false }, changedFiles: false })).toBeNull()
    expect(planFinding({ firstRound: true, plan: null, changedFiles: true })).toMatchObject({ kind: 'no-plan' })
  })
  test('a plan before the first change is fine', () => {
    expect(planFinding({ firstRound: true, plan: { text: 'x', beforeChanges: true }, changedFiles: true })).toBeNull()
  })
  test('a job that changed nothing needs no plan, and a revision round is not judged', () => {
    expect(planFinding({ firstRound: true, plan: null, changedFiles: false })).toBeNull()
    expect(planFinding({ firstRound: false, plan: null, changedFiles: true })).toBeNull()
  })
})

describe('the instruction', () => {
  test('names the write scope when there is one, and keeps the plan off teammates', () => {
    const text = planInstruction(['src/pages/**', 'docs/about.md'])
    expect(text).toContain('PLAN:')
    expect(text).toContain('src/pages/**, docs/about.md')
    expect(text).toContain('nothing a teammate is building')
  })
  test('points at the planning and verification skills by name', () => {
    const text = planInstruction()
    expect(text).toContain('superpowers:writing-plans')
    expect(text).toContain('superpowers:test-driven-development')
    expect(text).toContain('superpowers:verification-before-completion')
  })
  test('without a scope it still says to stay on the job', () => {
    expect(planInstruction()).toContain('off what your teammates are building')
  })
})

test('P4: the ids a plan cannot meet', () => {
  expect(cannotMeetIn('PLAN:\n1. x\nCANNOT MEET: j3 the app cannot be pointed at a throwaway database')).toEqual({ ids: ['j3'], why: 'j3 the app cannot be pointed at a throwaway database' })
  expect(cannotMeetIn('PLAN:\n1. x\nCANNOT MEET: none')).toEqual({ ids: [], why: '' })
  expect(cannotMeetIn('PLAN:\n1. x')).toEqual({ ids: [], why: '' })
})
test('P4: the manager note names the criteria, why, and what to amend', () => {
  const s = parkSentence(['j3', 's1'], 'j3 no throwaway database')
  expect(s).toContain('j3, s1')
  expect(s).toContain('no throwaway database')
  expect(s).toContain('amend_task')
  expect(s).toContain('Nothing was changed')
})
test('P4: the plan instruction asks for the CANNOT MEET line', () => {
  expect(planInstruction()).toContain('CANNOT MEET:')
})
test('P4 fix round 1: ids must lead the line, bullets and bold are allowed, prose parks nothing', () => {
  expect(cannotMeetIn('PLAN:\n1. x\nCANNOT MEET: nothing; j1 to j3 are fine').ids).toEqual([])
  expect(cannotMeetIn('- **CANNOT MEET:** j2 and s1, no way').ids).toEqual(['j2', 's1'])
  expect(cannotMeetIn('PLAN:\n' + 'step\n'.repeat(900) + 'CANNOT MEET: j1 no').ids).toEqual(['j1'])
})

test('I3: the manager park note keeps the file names, the ids and every sentence', () => {
  const a = parkSentence(['j3'], 'j3 needs a write to src/rent/pay.ts and tests/rent.rs, which are outside my writes. The test runner also needs DATABASE_URL set.')
  expect(a).toContain('src/rent/pay.ts and tests/rent.rs')
  expect(a).toContain('DATABASE_URL set. Nothing was changed')
  expect(a).not.toContain('..')
  const b = parkSentence(['j2', 's10'], 'j2 asks for 390 px screenshots but I have no look_at_screens tool; s10 needs the owner to approve.')
  expect(b).toContain('j2 asks for 390 px screenshots but I have no look_at_screens tool; s10 needs the owner to approve. Nothing')
  expect(b).not.toContain('Your standard')
})
test('I3: the owner status line is plain and names no file or id', () => {
  const o = parkStatusLine('j3 needs a write to src/rent/pay.ts, which is outside my writes.')
  expect(o).not.toMatch(/src\/|\bj3\b|amend_task/)
  expect(o).not.toContain('..')
})
