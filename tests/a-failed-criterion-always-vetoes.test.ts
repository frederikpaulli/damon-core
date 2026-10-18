import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkCriteria, CRITERIA_BLOCK, criteriaOf, type CriterionResult } from '../src/shared/review-checklist'
import { vetoingProblems } from '../src/shared/intended-work'
import { criteriaConflictOf, refusedByCriteria } from '../src/shared/criteria-conflict'
import { processOnly } from '../src/shared/process-objection'
import { processFinding } from '../src/shared/file-role'
import { heldWhenBlocked } from '../src/shared/held-criteria'

const judged = criteriaOf('- The total is right.\n- The test is shown failing first.', [{ id: 'a', text: 'The total is right.' }])
const opened = [{ tool: 'Read', summary: 'r', detail: 'C:/x/a.md', ok: true }]
const block = (rows: unknown[]): string => `${CRITERIA_BLOCK} ${JSON.stringify(rows)}\nVERDICT: meets`
const j1pass = { id: 'j1', status: 'pass', observed: 'It was shown failing first.', evidence: ['a.md'] }
const fail = (id: string, observed: string, evidence: unknown = ['a.md']) => ({ id, status: 'fail', observed, evidence })

describe('a failed criterion vetoes a recorded "meets"', () => {
  test('the fixture numbers the owner standard s1 and the job criterion j1', () => {
    expect(judged.map((c) => c.id)).toEqual(['s1', 'j1'])
  })
  test('meets over [s1] fail is refused', () => {
    const checked = checkCriteria(block([fail('s1', 'The total is wrong'), j1pass]), judged, opened)
    expect(vetoingProblems(checked.problems, true, checked.results)).toEqual(['[s1] fail: The total is wrong'])
  })
  test('a fail with no evidence still vetoes', () => {
    const checked = checkCriteria(block([fail('s1', 'The total is wrong', []), j1pass]), judged, opened)
    expect(checked.results.find((r) => r.id === 's1')).toMatchObject({ status: 'fail', evidence: [] })
    expect(vetoingProblems(checked.problems, true, checked.results)).toContain('[s1] fail: The total is wrong')
  })
  test('a typed failure with no fail line still vetoes', () => {
    const results: CriterionResult[] = [{ id: 'j1', status: 'fail', observed: 'Never shown.', evidence: [] }]
    expect(vetoingProblems([], true, results)).toEqual(['[j1] fail: Never shown.'])
  })
  test('guard: a normal pass vetoes nothing', () => {
    const checked = checkCriteria(block([{ ...j1pass, id: 's1' }, j1pass]), judged, opened)
    expect(vetoingProblems(checked.problems, true, checked.results)).toEqual([])
  })
  test('guard: a pass whose evidence was not independently inspected is a note under a recorded verdict (C51)', () => {
    const checked = checkCriteria(block([{ ...j1pass, id: 's1', evidence: ['b.md'] }, j1pass]), judged, opened)
    expect(checked.problems.some((p) => /not independently inspected/.test(p))).toBe(true)
    expect(vetoingProblems(checked.problems, true, checked.results)).toEqual([])
  })
})

describe('the C553 and C557 hooks see the failed criteria', () => {
  const failed = (id: string, observed: string, evidence = ['a.md']): CriterionResult => ({ id, status: 'fail', observed, evidence })
  test('a process-only failed criterion becomes a follow-up point (C553)', () => {
    const record = refusedByCriteria({ verdict: 'meets', findings: [] }, [failed('j1', 'the test was never shown failing first')])
    expect(processOnly({ ...record, neverLeaves: () => true, draftFiles: ['src/a.ts'] })).toEqual({ points: ['[j1] the test was never shown failing first'] })
  })
  test('a conflict in a failed criterion goes to the manager (C557)', () => {
    const record = refusedByCriteria({ verdict: 'meets', findings: [] }, [failed('j2', '[criteria] j2 and j4 cannot both be met')])
    expect(criteriaConflictOf([record])).toHaveLength(1)
  })
  test('the finding carries no evidence text (it could read as substance)', () => {
    const record = refusedByCriteria({ verdict: 'meets', findings: [] }, [failed('j1', 'the test was never shown failing first', ['npx vitest run tests/failing-first.test.ts'])])
    expect(record.findings).toEqual([{ severity: 'blocking', statement: '[j1] the test was never shown failing first', evidence: '' }])
  })
  test('a refusal, and a pass with no failed criterion, are left as they are', () => {
    const refused = { verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'x', evidence: '' }] }
    expect(refusedByCriteria(refused, [failed('j1', 'y')])).toEqual(refused)
    const passed = { verdict: 'meets', findings: [] }
    expect(refusedByCriteria(passed, [{ id: 'j1', status: 'pass', observed: 'ok', evidence: ['a.md'] }])).toEqual(passed)
    expect(refusedByCriteria(passed, undefined)).toEqual(passed)
  })
  test('a [jN] tag no longer reads as a digit in a process point; [sN] stays refused', () => {
    expect(processFinding('[j1] the test was never shown failing first')).toBe(true)
    expect(processFinding('[gap] the test was never shown failing first')).toBe(true)
    expect(processFinding('[s1] the test was never shown failing first')).toBe(false)
    expect(processFinding('[j1] the total is wrong by 40 kr')).toBe(false)
  })
})

describe('C600: an unverifiable money, security or privacy criterion holds the job', () => {
  test('the narrow rule (the review\'s seven sentences and the plan\'s)', () => {
    for (const yes of ['The rent total matches the hand-worked figure.', 'No secret appears in the logs.', 'Personal data is not sent anywhere.', 'The CPR number is masked.', 'The access token is never logged.', 'The total is 4.250 kr.']) expect(heldWhenBlocked(yes), yes).toBe(true)
    for (const no of ['The README mentions the command.', 'The API returns 200.', 'Key points are listed first.', 'The usage panel shows tokens, never dollars.', 'The design tokens are used for spacing.', 'Prices on the pricing page match the brief.', 'The rent page looks right in dark mode.']) expect(heldWhenBlocked(no), no).toBe(false)
  })
  const rent = criteriaOf('- The rent total matches the hand-worked figure.\n- No secret appears in the logs.\n- The README mentions the command.', [])
  const blocked = (id: string, observed: string) => ({ id, status: 'blocked', observed, evidence: ['a.md'] })
  test('a held blocked criterion writes one C297-shaped line, stored as held, and vetoes "meets"', () => {
    const checked = checkCriteria(block([blocked('j1', 'the hand-worked figure is not in the project'), { ...j1pass, id: 'j2' }, { ...j1pass, id: 'j3' }]), rent, opened)
    expect(checked.problems).toHaveLength(1)
    expect(checked.problems[0]).toMatch(/^[^:\n]{1,80}: blocked: /)
    expect(checked.problems[0]).toContain('money, security or privacy')
    expect(checked.problems[0]).toContain('the hand-worked figure is not in the project')
    expect(checked.results.find((r) => r.id === 'j1')).toMatchObject({ status: 'blocked', held: true })
    expect(vetoingProblems(checked.problems, true, checked.results)).toEqual(checked.problems)
    const objections = vetoingProblems(checked.problems, true, checked.results)
    expect(objections.length > 0 && objections.every((o) => /^[^:\n]{1,80}: blocked: /.test(o.trim()))).toBe(true)
  })
  test('a secret criterion is held too; an ordinary blocked one is only counted', () => {
    const secret = checkCriteria(block([{ ...j1pass, id: 'j1' }, blocked('j2', 'the logs were not available'), { ...j1pass, id: 'j3' }]), rent, opened)
    expect(secret.problems).toHaveLength(1)
    expect(secret.problems[0]).toMatch(/^j2 \(No secret appears in the logs\.\): blocked: /)
    const readme = checkCriteria(block([{ ...j1pass, id: 'j1' }, { ...j1pass, id: 'j2' }, blocked('j3', 'the README was not shipped')]), rent, opened)
    expect(readme.problems).toEqual([])
    expect(readme.results.find((r) => r.id === 'j3')?.held).toBeUndefined()
  })
  const held: CriterionResult = { id: 'j1', status: 'blocked', observed: 'the hand-worked figure is not in the project', evidence: ['a.md'], held: true }
  test('F1: a held criterion is a blocking finding for C553, so a process point beside it is not a follow-up', () => {
    const record = refusedByCriteria({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: '[j2] the test was never shown failing first', evidence: '' }] }, [held])
    expect(record.findings.map((f) => f.statement)).toContain('[j1] could not be verified, and it is about money, security or privacy: the hand-worked figure is not in the project')
    expect(processOnly({ ...record, neverLeaves: () => true, draftFiles: ['src/a.ts'] })).toBeNull()
  })
  test('F1: a held criterion beside a criteria conflict does not go to the manager as a conflict (C557)', () => {
    const record = refusedByCriteria({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: '[criteria] j2 and j4 cannot both be met', evidence: '' }] }, [held])
    expect(criteriaConflictOf([record])).toBeNull()
    expect(refusedByCriteria({ verdict: 'meets', findings: [] }, [held]).verdict).toBe('does-not-meet')
  })
  test('the gate reads the rule directly, not through review.ts', () => {
    const checklist = readFileSync('src/shared/review-checklist.ts', 'utf8')
    expect(checklist).toContain("from './held-criteria'")
    expect(readFileSync('src/shared/review.ts', 'utf8')).not.toContain('heldWhenBlocked')
  })
})
