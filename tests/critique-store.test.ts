import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CritiqueStore } from '../src/main/lib/critique-store'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'damon-moot-')); dirs.push(d); return d }

test("D1.10e: a Damon-decided challenge is recorded as Damon's and not carried into the next critique", () => {
  const s = new CritiqueStore(dir())
  const a = s.ensure('deliverable:X', { v: 1 }, ['t1'], ['a.md'])
  s.sendBackOwnerDecision(a.id, 'Keep the original decision?', 'damon')
  expect(s.list().find(x => x.id === a.id)!.ownerDecisions).toEqual([expect.objectContaining({ challenge: 'Keep the original decision?', by: 'damon' })])
  const b = s.ensure('deliverable:X', { v: 2 }, ['t1'], ['a.md'])
  expect((b.ownerDecisions ?? []).some(d => d.challenge === 'Keep the original decision?')).toBe(false)
})

test("D1.10e: the owner's own send-back is still carried", () => {
  const s = new CritiqueStore(dir())
  const a = s.ensure('deliverable:X', { v: 1 }, ['t1'], ['a.md'])
  s.sendBackOwnerDecision(a.id, 'Keep the original decision?')
  const b = s.ensure('deliverable:X', { v: 2 }, ['t1'], ['a.md'])
  expect((b.ownerDecisions ?? []).some(d => d.challenge === 'Keep the original decision?')).toBe(true)
})

test("C630: a failure another job owns is not a blocker, and is linked to that job", () => {
  const s = new CritiqueStore(dir())
  const a = s.ensure('deliverable:X', { v: 1 }, [], ['a.md'])
  const checks = [{ id: 'recovery', status: 'fail', observed: 'seen on job 5d3b21d3', evidence: ['a.md'] }]
  const done = s.record(a.id, 'critic', 'CHECK RESULTS: ' + JSON.stringify(checks) + '\nLOOKED: yes\nFINDINGS: none\nFOR THE OWNER: none', checks as never, ['recovery: fail: seen on job 5d3b21d3'])
  const elsewhere = (t: string, _ev: string[]): string | null => (t.includes('5d3b21d3') ? '5d3b21d3' : null)
  expect(s.blocker(done)).toMatch(/unresolved failures/)
  expect(s.blocker(done, false, elsewhere)).toBeNull()
  expect(s.linkedElsewhere(done, elsewhere)).toEqual([{ check: 'recovery: seen on job 5d3b21d3', taskId: '5d3b21d3' }])
})

test("C630: a critic note 'belongs elsewhere: job X' is found for the manager", () => {
  const s = new CritiqueStore(dir())
  const a = s.ensure('deliverable:Y', { v: 1 }, [], ['a.md'])
  const raw = 'CHECK RESULTS: []' + String.fromCharCode(10) + 'LOOKED: yes' + String.fromCharCode(10) + 'FINDINGS: none' + String.fromCharCode(10) + 'FOR THE OWNER: none'
  const done = s.record(a.id, 'critic', raw, [], [])
  expect(s.notesElsewhere(done)).toEqual([])
})

test("C630: notesElsewhere reads 'belongs elsewhere: job X' from the last report only", () => {
  const s = new CritiqueStore(dir())
  const item = { reports: [
    { parsed: { notes: ['belongs elsewhere: job 11111111 old'] } },
    { parsed: { notes: ['Belongs elsewhere: job 5D3B21D3 the retry records a second payment', 'unrelated optional note'] } }
  ] } as never
  expect(s.notesElsewhere(item)).toEqual([{ note: 'Belongs elsewhere: job 5D3B21D3 the retry records a second payment', job: '5d3b21d3' }])
  expect(s.notesElsewhere({ reports: [] } as never)).toEqual([])
})
