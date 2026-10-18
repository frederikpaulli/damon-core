import { expect, test } from 'vitest'
import { findWaitCycles, OBJECTION_STANDS_MS } from '../src/shared/wait-graph'
import type { TaskInfo } from '../src/shared/types'

const NOW = Date.parse('2026-10-09T23:00:00Z')
const job = (o: Partial<TaskInfo>): TaskInfo => ({ id: 'x', agentId: 'a', title: 't', instructions: 'i', acceptance: 'a', status: 'queued', round: 1, feedback: [], createdAt: 'x', updatedAt: 'x', ...o })

test('a ring: an invoice fix (revising) waits on the coverage gate for the date fix\'s deliverable; the date fix needs the invoice fix', () => {
  const inv = job({ id: 'r', status: 'revising', deliverableIds: ['INVOICE_REPEAT', 'invoice_repeat'], writes: ['app/src/domain/invoicing.rs', 'app/tests/invoice_repeat.rs'] })
  const date = job({ id: 'd', status: 'queued', needs: ['r'], deliverableIds: ['LOCAL_TODAY', 'local_today'], writes: ['app/tests/local_today.rs', 'app/src/domain/invoicing.rs'] })
  const waits = (t: TaskInfo) => (t.id === 'r' ? ['local_today'] : [])
  const c = findWaitCycles([inv, date], { now: NOW, coverageWaits: waits })
  expect(c).toHaveLength(1)
  expect(c[0]!.map(e => `${e.from}>${e.to}:${e.kind}`).sort()).toEqual(['d>r:needs', 'r>d:coverage'])
  expect(findWaitCycles([inv, date], { now: NOW })).toEqual([])
})

test('an objection edge only for a refusal that stands: escalated, capped, or older than 30 minutes (review S4)', () => {
  const refusedAt = (ms: number) => ({ satisfied: false, ran: true, objection: 'date bug', at: new Date(NOW - ms).toISOString() }) as never
  const dep = job({ id: 'd', needs: ['r'], writes: ['src/a.rs'] })
  expect(findWaitCycles([job({ id: 'r', status: 'review', review: refusedAt(60_000), writes: ['src/a.rs'] }), dep], { now: NOW })).toEqual([])
  expect(findWaitCycles([job({ id: 'r', status: 'review', review: refusedAt(OBJECTION_STANDS_MS + 60_000), writes: ['src/a.rs'] }), dep], { now: NOW })).toHaveLength(1)
  expect(findWaitCycles([job({ id: 'r', status: 'review', review: refusedAt(60_000), writes: ['src/a.rs'] }), dep], { now: NOW, capped: t => t.id === 'r' })).toHaveLength(1)
  expect(findWaitCycles([job({ id: 'r', status: 'escalated', writes: ['src/a.rs'] }), dep], { now: NOW })).toHaveLength(1)
})

test('no objection ring when the waiting job writes other files, or is already the fix', () => {
  const inv = job({ id: 'r', status: 'escalated', writes: ['src/a.rs'] })
  expect(findWaitCycles([inv, job({ id: 'd', needs: ['r'], writes: ['src/b.rs'] })], { now: NOW })).toEqual([])
  expect(findWaitCycles([inv, job({ id: 'd', needs: ['r'], fixes: 'r', writes: ['src/a.rs'] })], { now: NOW })).toEqual([])
})

test('a job parked for one manager amend (parkedFor) is not a standing refusal (preflight P-26, R13)', () => {
  const parked = job({ id: 'r', status: 'escalated', escalation: 'manager', writes: ['src/a.rs'], parkedFor: 'criteria' } as never)
  expect(findWaitCycles([parked, job({ id: 'd', needs: ['r'], writes: ['src/a.rs'] })], { now: NOW })).toEqual([])
})

test('two fixes held by each other\'s faults', () => {
  const fault = (id: string, w: string) => job({ id, status: 'approved', writes: [w], knownFault: { objection: 'o', keptAt: '2026-10-09T00:00:00Z' } })
  const f1 = job({ id: 'f1', fixes: 'k1', writes: ['src/x/a.rs', 'src/y/a.rs'] }), f2 = job({ id: 'f2', fixes: 'k2', writes: ['src/y/b.rs', 'src/x/b.rs'] })
  expect(findWaitCycles([fault('k1', 'src/x/**'), fault('k2', 'src/y/**'), f1, f2], { now: NOW })).toHaveLength(1)
})

test('a ring is reported once, whichever member it is found from', () => {
  const inv = job({ id: 'r', status: 'revising', writes: ['src/a.rs'] })
  const date = job({ id: 'd', needs: ['r'], deliverableIds: ['dt'], writes: ['src/a.rs'] })
  expect(findWaitCycles([date, inv], { now: NOW, coverageWaits: t => (t.id === 'r' ? ['dt'] : []) })).toHaveLength(1)
})

const refused = (o: object) => ({ satisfied: false, ran: true, objection: 'o', at: new Date(NOW - 2 * OBJECTION_STANDS_MS).toISOString(), ...o }) as never
const needer = job({ id: 'd', needs: ['r'], writes: ['src/a.rs'] })
test('a refusal the manager disputed, never ran, is gate-pending or was overruled makes no objection edge', () => {
  for (const extra of [{ review: refused({ disputed: 'no' }) }, { review: refused({ ran: false }) }, { review: refused({ overruledWhy: 'x' }) }, { gatePending: true }])
    expect(findWaitCycles([job({ id: 'r', status: 'review', writes: ['src/a.rs'], review: refused({}), ...extra } as never), needer], { now: NOW })).toEqual([])
  expect(findWaitCycles([job({ id: 'r', status: 'review', writes: ['src/a.rs'], review: refused({}) }), needer], { now: NOW })).toHaveLength(1)
})
test('only queued or revising jobs wait: approved, working, reviewing dependents give no ring', () => {
  for (const status of ['approved', 'working', 'reviewing', 'review', 'failed', 'dropped'] as const)
    expect(findWaitCycles([job({ id: 'r', status: 'escalated', writes: ['src/a.rs'] }), { ...needer, status }], { now: NOW })).toEqual([])
  expect(findWaitCycles([job({ id: 'r', status: 'working', needs: ['d'] }), job({ id: 'd', status: 'queued', needs: ['r'] })], { now: NOW })).toEqual([])
})
test('a needs self-loop is no ring; jobs that only share files are no ring', () => {
  expect(findWaitCycles([job({ id: 'r', needs: ['r'] })], { now: NOW })).toEqual([])
  expect(findWaitCycles([job({ id: 'a', writes: ['src/a.rs'] }), job({ id: 'b', writes: ['src/a.rs'] })], { now: NOW })).toEqual([])
})
test('a three-job ring is reported exactly once', () => {
  const ring = [job({ id: 'a', needs: ['b'] }), job({ id: 'b', needs: ['c'] }), job({ id: 'c', needs: ['a'] })]
  expect(findWaitCycles(ring, { now: NOW })).toHaveLength(1)
  expect(findWaitCycles([...ring].reverse(), { now: NOW })).toHaveLength(1)
})
