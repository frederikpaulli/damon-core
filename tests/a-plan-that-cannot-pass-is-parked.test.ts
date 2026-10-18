import { expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRun, type AgentRunOutcome } from '../src/main/lib/task-engine'
import { waitEdges } from '../src/shared/wait-graph'
import type { TaskInfo } from '../src/shared/types'

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function setup(standards: { id: string; text: string }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'damon-park-'))
  const roster = new RosterStore(dir); const agent = roster.add('Builder', 'builds', undefined)
  const runs: ((o: AgentRunOutcome) => void)[] = []
  const run: AgentRun = () => new Promise<AgentRunOutcome>(resolve => { runs.push(resolve) })
  const engine = new TaskEngine(dir, roster, run, { onTaskUpdate: () => {}, onAgentReport: () => {} }, { approvedStandards: () => standards } as never)
  return { engine, agent, runs }
}

test('parked, then amended, then queued again with no send-back spent', async () => {
  const { engine, agent, runs } = setup()
  const job = engine.assign(agent.id, 'Installer', 'i', '- Starts on an empty database in a throwaway location', undefined, undefined, ['installer/**']) as TaskInfo
  await flush(); runs[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  const t = engine.get(job.id)!
  expect(t).toMatchObject({ status: 'escalated', escalation: 'manager', parkedFor: 'p', parkedOnce: true, feedback: [] })
  expect(t.attempts).toBeUndefined()
  expect(t.round).toBe(1)
  const out = engine.amendCriteria(job.id, [{ id: 'j1', text: 'Starts on an empty database in its own data folder' }])
  if ('error' in out) throw new Error(out.error)
  expect(engine.get(job.id)!.acceptance).toBe('- Starts on an empty database in its own data folder')
  expect(engine.get(job.id)!.feedback).toEqual([])
  expect(engine.get(job.id)!.parkedFor).toBeUndefined()
  expect(engine.get(job.id)!.round).toBe(1)
  expect('error' in engine.amendCriteria(job.id, [{ id: 's1', text: 'x' }])).toBe(true)
})

test('a parked job is waiting for the amend, not refused (no objection edge)', async () => {
  const { engine, agent, runs } = setup()
  const job = engine.assign(agent.id, 'Installer', 'i', '- one', undefined, undefined, ['installer/**']) as TaskInfo
  await flush(); runs[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  const other = { ...engine.get(job.id)!, id: 'o', status: 'queued', escalation: undefined, parkedFor: undefined, needs: [job.id], writes: ['installer/**'] } as TaskInfo
  expect(waitEdges([engine.get(job.id)!, other], { now: Date.now() }).filter(e => e.kind === 'objection')).toEqual([])
})

test('validation happens before anything changes, a drop removes the criterion, owner lines stay', async () => {
  const { engine, agent, runs } = setup([{ id: 'x', text: 'Standard rule' }])
  const job = engine.assign(agent.id, 'Installer', 'i', '- Standard rule\n- First\n- Second', undefined, undefined, ['installer/**']) as TaskInfo
  await flush(); runs[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  const before = engine.get(job.id)!.acceptance
  expect(engine.checkCriteria(job.id, [{ id: 'j9' }])).toMatchObject({ error: expect.stringContaining('j9') })
  expect('error' in engine.amendCriteria(job.id, [{ id: 'j1', text: 'ok' }, { id: 'j9' }])).toBe(true)
  expect(engine.get(job.id)!.acceptance).toBe(before)
  expect(engine.get(job.id)!.status).toBe('escalated')
  const out = engine.amendCriteria(job.id, [{ id: 'j1' }])
  if ('error' in out) throw new Error(out.error)
  expect(engine.get(job.id)!.acceptance).toBe('- Standard rule\n- Second')
})

test('resume_why alone re-queues a parked job with criteria unchanged; a job that is not parked or queued is refused', async () => {
  const { engine, agent, runs } = setup()
  const job = engine.assign(agent.id, 'Installer', 'i', '- one', undefined, undefined, ['installer/**']) as TaskInfo

  await flush(); runs[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  expect('error' in engine.amendCriteria(job.id, [])).toBe(true)
  const out = engine.amendCriteria(job.id, [], 'Point it at DAMON_DATA_DIR.')
  if ('error' in out) throw new Error(out.error)
  expect(engine.get(job.id)!.acceptance).toBe('- one')
  expect(engine.get(job.id)!.criteriaAmended).toEqual(['Point it at DAMON_DATA_DIR.'])
})

test('the amended job runs again as round 1 and its worker is told the new criteria; a running job is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-park-'))
  const roster = new RosterStore(dir); const agent = roster.add('Builder', 'builds', undefined)
  const seen: { round: number; feedback: string | null }[] = []
  const resolvers: ((o: AgentRunOutcome) => void)[] = []
  const run: AgentRun = (_a, t, feedback) => new Promise<AgentRunOutcome>(resolve => { seen.push({ round: t.round, feedback }); resolvers.push(resolve) })
  const engine = new TaskEngine(dir, roster, run, { onTaskUpdate: () => {}, onAgentReport: () => {} }, { approvedStandards: () => [] } as never)
  const job = engine.assign(agent.id, 'Installer', 'i', '- one\n- two', undefined, undefined, ['installer/**']) as TaskInfo
  await flush()
  expect('error' in engine.amendCriteria(job.id, [{ id: 'j1' }])).toBe(true)
  resolvers[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  const out = engine.amendCriteria(job.id, [{ id: 'j2', text: 'two, reworded' }], 'Use the data folder variable.')
  if ('error' in out) throw new Error(out.error)
  await flush()
  expect(seen).toHaveLength(2)
  expect(seen[1]!.round).toBe(1)
  expect(seen[1]!.feedback).toContain('[j2] two, reworded')
  expect(seen[1]!.feedback).toContain('Use the data folder variable.')
  expect(engine.get(job.id)!.feedback).toEqual([])
})

test('fix round 1: the manager answer survives a restart, the plan is kept, parkedFor clears on a send-back, a copy draft is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-park-'))
  const roster = new RosterStore(dir); const agent = roster.add('Builder', 'builds', undefined)
  const seen: (string | null)[] = []
  const resolvers: ((o: AgentRunOutcome) => void)[] = []
  const run: AgentRun = (_a, _t, feedback) => new Promise<AgentRunOutcome>(resolve => { seen.push(feedback); resolvers.push(resolve) })
  const mk = (): TaskEngine => new TaskEngine(dir, roster, run, { onTaskUpdate: () => {}, onAgentReport: () => {} }, { approvedStandards: () => [], parkedDraft: () => ['installer/a.txt'], maxParallel: 0 } as never)
  const first = new TaskEngine(dir, roster, run, { onTaskUpdate: () => {}, onAgentReport: () => {} }, { approvedStandards: () => [], parkedDraft: () => ['installer/a.txt'] } as never)
  const job = first.assign(agent.id, 'Installer', 'i', '- one', undefined, undefined, ['installer/**']) as TaskInfo
  await flush(); resolvers[0]!({ ok: false, parked: true, resultText: 'p', plan: { text: 'the plan', beforeChanges: true }, changedFiles: false } as AgentRunOutcome); await flush()
  const parked = first.get(job.id)!
  expect(parked.plan).toBe('the plan')
  expect(parked.parkedFor).toContain('installer/a.txt')
  const second = mk()
  expect(second.get(job.id)!.parkedFor).toBeDefined()
  const out = second.amendCriteria(job.id, [], 'Use the data folder variable.')
  if ('error' in out) throw new Error(out.error)
  expect(second.get(job.id)!.parkAnswer).toContain('Use the data folder variable.')
  const third = new TaskEngine(dir, roster, run, { onTaskUpdate: () => {}, onAgentReport: () => {} }, { approvedStandards: () => [] } as never)
  ;(third as unknown as { pump(): void }).pump(); await flush()
  expect(seen[1]).toContain('Use the data folder variable.')
  expect(third.get(job.id)!.parkAnswer).toBeUndefined()
})

test('fix round 1: a send-back or a drop clears the park marker', async () => {
  const { engine, agent, runs } = setup()
  const job = engine.assign(agent.id, 'Installer', 'i', '- one', undefined, undefined, ['installer/**']) as TaskInfo
  await flush(); runs[0]!({ ok: false, parked: true, resultText: 'p', changedFiles: false } as AgentRunOutcome); await flush()
  const out = engine.requestRevision(job.id, 'Do it this way.')
  if ('error' in out) throw new Error(out.error)
  expect(engine.get(job.id)!.parkedFor).toBeUndefined()
})
