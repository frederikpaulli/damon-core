import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRunOutcome, type ReviewOutcome } from '../src/main/lib/task-engine'

const RECENT = new Date(Date.now() - 60_000).toISOString()

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const passed = (): ReviewOutcome => ({
  satisfied: true,
  objections: [],
  standing: 'review',
  why: 'A stronger brain read it.',
  reviewerModel: 'claude-opus-5',
  ran: true
})

const killed = (): ReviewOutcome => ({
  satisfied: false,
  objections: ['The reviewer could not be run: it was stopped'],
  standing: 'second-opinion',
  why: 'The reviewer did not run.',
  reviewerModel: 'claude-opus-5',
  ran: false
})

interface Harness {
  dir: string
  engine: TaskEngine
  agent: AgentInfo
  runs: { task: TaskInfo; resolve: (o: AgentRunOutcome) => void }[]
  reports: TaskInfo[]
  reviews: { resolve: (o: ReviewOutcome) => void }[]
}

function setup(dir = mkdtempSync(join(tmpdir(), 'damon-cut-')), held = (): boolean => false): Harness {
  const roster = new RosterStore(dir)
  const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
  const runs: Harness['runs'] = []
  const reports: TaskInfo[] = []
  const reviews: Harness['reviews'] = []
  const engine = new TaskEngine(
    dir,
    roster,
    (_a, t) => new Promise<AgentRunOutcome>((resolve) => runs.push({ task: t, resolve })),
    { onTaskUpdate: () => {}, onAgentReport: (_a, t) => reports.push(t) },
    {
      reviewDepth: () => 'full',
      review: () => new Promise<ReviewOutcome>((resolve) => reviews.push({ resolve })),
      held
    }
  )
  return { dir, engine, agent, runs, reports, reviews }
}

describe('a review the owner stopped', () => {
  test('the work is kept, waiting for a fresh review, and the killed reviewer’s answer is ignored', async () => {
    const h = setup()
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    h.runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()
    expect(h.engine.list()[0]!.status).toBe('reviewing')

    h.engine.stopRunning()
    const job = h.engine.list()[0]!
    expect(job.status).toBe('review')
    expect(job.gatePending).toBe(true)

    h.reviews[0]!.resolve(killed())
    await flush()
    expect(h.engine.list()[0]!.review).toBeUndefined()
    expect(h.engine.list()[0]!.status).toBe('review')
    expect(h.reports).toHaveLength(0)
  })

  test('when work starts again the review runs again, and only then does the boss hear', async () => {
    const h = setup()
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    h.runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()
    h.engine.stopRunning()
    h.reviews[0]!.resolve(killed())
    await flush()

    h.engine.nudge()
    await flush()
    expect(h.runs).toHaveLength(1)
    expect(h.reviews).toHaveLength(2)
    expect(h.engine.list()[0]!.status).toBe('reviewing')

    h.reviews[1]!.resolve(passed())
    await flush()
    expect(h.engine.list()[0]!.status).toBe('approved')
    expect(h.engine.list()[0]!.review?.satisfied).toBe(true)
    expect(h.reports).toHaveLength(0)
  })

  test('a held project does not read it again until the hold is lifted', async () => {
    let held = true
    const h = setup(undefined, () => held)
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    held = false
    h.engine.nudge()
    await flush()
    h.runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()
    held = true
    h.engine.stopRunning()
    h.reviews[0]!.resolve(killed())
    await flush()

    h.engine.nudge()
    await flush()
    expect(h.reviews).toHaveLength(1)

    held = false
    h.engine.nudge()
    await flush()
    expect(h.reviews).toHaveLength(2)
  })

  test('a stop aimed at one person does not touch the reviewer', async () => {
    const h = setup()
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    h.runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()

    h.engine.stopRunning(h.agent.id)
    expect(h.engine.list()[0]!.status).toBe('reviewing')
    h.reviews[0]!.resolve(passed())
    await flush()
    expect(h.engine.list()[0]!.status).toBe('approved')
    expect(h.reports).toHaveLength(0)
  })
})

describe('a review Damon closing killed', () => {
  test('is read again on the next start rather than handed over unread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-cut-'))
    const roster = new RosterStore(dir)
    const agent = roster.add('Scout', 'Builder', undefined)
    const task: TaskInfo = {
      id: 't1',
      agentId: agent.id,
      title: 'Checkout',
      instructions: 'build it',
      acceptance: 'prices are validated',
      status: 'reviewing',
      round: 1,
      feedback: [],
      result: 'Built it.',
      createdAt: RECENT,
      updatedAt: RECENT
    }
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([task]))

    const h = setup(dir)
    const job = h.engine.list()[0]!
    expect(job.status).toBe('review')
    expect(job.gatePending).toBe(true)
    expect(job.review).toBeUndefined()

    h.engine.nudge()
    await flush()
    expect(h.runs).toHaveLength(0)
    expect(h.reviews).toHaveLength(1)
    h.reviews[0]!.resolve(passed())
    await flush()
    expect(h.reports).toHaveLength(0)
    expect(h.engine.list()[0]!.status).toBe('approved')
    expect(h.engine.list()[0]!.review?.satisfied).toBe(true)
  })
})

describe('the conversation an agent is having', () => {
  test('is written to the job while it runs, and only while it runs', async () => {
    const h = setup()
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    const id = h.engine.list()[0]!.id

    h.engine.rememberSession(id, 'sess-1')
    expect(h.engine.list()[0]!.sessionId).toBe('sess-1')
    const again = new TaskEngine(h.dir, new RosterStore(h.dir), () => new Promise(() => {}), {
      onTaskUpdate: () => {},
      onAgentReport: () => {}
    })
    expect(again.list()[0]!.sessionId).toBe('sess-1')

    h.runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()
    h.engine.rememberSession(id, 'sess-late')
    expect(h.engine.list()[0]!.sessionId).toBe('sess-1')
  })

  test('a job Damon closing cut off resumes that conversation instead of starting from the brief', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-cut-'))
    const roster = new RosterStore(dir)
    const agent = roster.add('Scout', 'Builder', undefined)
    const task: TaskInfo = {
      id: 't1',
      agentId: agent.id,
      title: 'Checkout',
      instructions: 'build it',
      acceptance: 'prices are validated',
      status: 'working',
      round: 1,
      feedback: [],
      sessionId: 'sess-1',
      createdAt: RECENT,
      updatedAt: RECENT
    }
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([task]))

    const h = setup(dir)
    h.engine.nudge()
    await flush()
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.task.sessionId).toBe('sess-1')
  })
})
