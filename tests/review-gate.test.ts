import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { RosterStore } from '../src/main/lib/roster-store'
import {
  MAX_REVISIONS,
  TaskEngine,
  type AgentRunOutcome,
  type Overrule,
  type ReviewOutcome
} from '../src/main/lib/task-engine'
import type { Arrival, ReviewDepth } from '../src/shared/review'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const passed = (): ReviewOutcome => ({
  satisfied: true,
  objections: [],
  standing: 'review',
  why: 'The reviewer thinks with a stronger brain than the worker.',
  reviewerModel: 'claude-opus-4-8',
  ran: true
})

const refused = (objection: string): ReviewOutcome => ({
  satisfied: false,
  objections: [objection],
  standing: 'review',
  why: 'The reviewer thinks with a stronger brain than the worker.',
  reviewerModel: 'claude-opus-4-8',
  ran: true
})

interface Harness {
  engine: TaskEngine
  agent: AgentInfo
  runs: { task: TaskInfo; feedback: string | null; resolve: (o: AgentRunOutcome) => void }[]
  reports: TaskInfo[]
  reviews: { task: TaskInfo; round: number; previous: string[] }[]
  arrivals: { task: TaskInfo; arrival: Arrival }[]
  overrules: Overrule[]
}

function setup(opts: {
  depth?: ReviewDepth
  reviewer?: (round: number) => ReviewOutcome
  noGate?: boolean
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'damon-gate-'))
  const roster = new RosterStore(dir)
  const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
  const runs: Harness['runs'] = []
  const reports: TaskInfo[] = []
  const reviews: Harness['reviews'] = []
  const arrivals: Harness['arrivals'] = []
  const overrules: Overrule[] = []

  const engine = new TaskEngine(
    dir,
    roster,
    (_a, t, feedback) => new Promise<AgentRunOutcome>((resolve) => runs.push({ task: t, feedback, resolve })),
    { onTaskUpdate: () => {}, onAgentReport: (_a, t) => reports.push(t) },
    {
      reviewDepth: () => opts.depth ?? 'full',
      review: opts.noGate
        ? undefined
        : (_a, task, round, previous) => {
            reviews.push({ task, round, previous })
            return Promise.resolve((opts.reviewer ?? passed)(round))
          },
      onArrival: (task, arrival) => arrivals.push({ task, arrival }),
      onOverruled: (o) => overrules.push(o)
    }
  )
  return { engine, agent, runs, reports, reviews, arrivals, overrules }
}

const finish = async (h: Harness, text = 'Built it.'): Promise<void> => {
  h.runs[h.runs.length - 1]!.resolve({ ok: true, resultText: text })
  await flush()
}

describe('nothing reaches a boss until the reviewer is satisfied', () => {
  test('the reviewer objects, and NOBODY is told the job finished', async () => {
    const h = setup({ reviewer: () => refused('api/checkout.ts accepts a negative price.') })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)

    expect(h.reports).toHaveLength(0)
    expect(h.arrivals).toHaveLength(0)
    expect(h.runs).toHaveLength(2)
    expect(h.engine.list()[0]!.status).toBe('working')
  })

  test('the worker revises against the reviewer’s ACTUAL words', async () => {
    const objection = 'api/checkout.ts accepts a negative price.'
    const h = setup({ reviewer: (round) => (round === 1 ? refused(objection) : passed()) })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)
    await flush()

    expect(h.runs).toHaveLength(2)
    expect(h.runs[1]!.feedback).toContain(objection)
  })

  test('the reviewer re-checks, and is told what it said last time', async () => {
    const h = setup({ reviewer: (round) => (round === 1 ? refused('Negative prices go through.') : passed()) })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)
    await flush()
    await finish(h, 'Fixed it.')

    expect(h.reviews).toHaveLength(2)
    expect(h.reviews[1]!.previous.join(' ')).toContain('Negative prices go through.')
    expect(h.reports).toHaveLength(0)
    expect(h.engine.list()[0]!.status).toBe('approved')
    expect(h.arrivals[0]!.arrival.kind).toBe('passed')
  })

  test('satisfied work is signed off in code, marked as having passed', async () => {
    const h = setup({})
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)

    expect(h.reports).toHaveLength(0)
    expect(h.engine.list()[0]!.status).toBe('approved')
    expect(h.engine.list()[0]!.review?.satisfied).toBe(true)
    expect(h.arrivals[0]!.arrival.kind).toBe('passed')
  })
})

describe('the rounds run out', () => {
  test('it arrives anyway, carrying the objection, and looks different', async () => {
    const h = setup({ reviewer: () => refused('Still accepts a negative price.') })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    for (let i = 0; i <= MAX_REVISIONS; i++) {
      if (h.runs.length === 0) break
      await finish(h)
      await flush()
    }

    const task = h.engine.list()[0]!
    expect(task.status).toBe('review')
    expect(task.review?.satisfied).toBe(false)
    expect(h.reports).toHaveLength(1)

    const arrival = h.arrivals[h.arrivals.length - 1]!.arrival
    expect(arrival.kind).toBe('unresolved')
    expect(arrival.kind === 'unresolved' && arrival.objection).toContain('negative price')
    expect(arrival.line.toLowerCase()).toContain('in front of you anyway')
  })

  test('the worker is not sent round more times than the owner’s cap allows', async () => {
    const h = setup({ reviewer: () => refused('Still wrong.') })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    for (let i = 0; i < 10; i++) {
      if (h.runs.length === 0) break
      const pending = h.runs.length
      await finish(h)
      await flush()
      if (h.runs.length === pending) break
    }
    expect(h.runs.length).toBeLessThanOrEqual(MAX_REVISIONS + 1)
  })
})

describe('a reviewer that did not look is never treated as one that approved', () => {
  test('a reviewer that crashed arrives marked, not passed', async () => {
    const h = setup({
      reviewer: () => ({
        satisfied: false,
        objections: ['The reviewer could not be run.'],
        standing: 'second-opinion',
        why: 'The reviewer did not run.',
        reviewerModel: '',
        ran: false
      })
    })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)

    expect(h.reports).toHaveLength(1)
    expect(h.engine.list()[0]!.review?.satisfied).toBe(false)
    expect(h.arrivals[0]!.arrival.kind).toBe('unresolved')
  })

  test('a thrown reviewer does not wedge the job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-gate-'))
    const roster = new RosterStore(dir)
    const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
    const runs: { resolve: (o: AgentRunOutcome) => void }[] = []
    const reports: TaskInfo[] = []
    const engine = new TaskEngine(
      dir,
      roster,
      () => new Promise<AgentRunOutcome>((resolve) => runs.push({ resolve })),
      { onTaskUpdate: () => {}, onAgentReport: (_a, t) => reports.push(t) },
      { reviewDepth: () => 'full', review: () => Promise.reject(new Error('quota gone')) }
    )
    engine.assign(agent.id, 'Checkout', 'build it', 'ok')
    await flush()
    runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()

    expect(reports).toHaveLength(1)
    expect(engine.list()[0]!.status).toBe('review')
    expect(engine.list()[0]!.review?.satisfied).toBe(false)
    expect(engine.list()[0]!.review?.objection).toContain('quota gone')
  })
})

describe('depth', () => {
  test('depth none skips the gate entirely', async () => {
    const h = setup({ depth: 'none' })
    h.engine.assign(h.agent.id, 'Estimate', 'write it', 'a figure exists')
    await flush()
    await finish(h)

    expect(h.reviews).toHaveLength(0)
    expect(h.reports).toHaveLength(1)
    expect(h.engine.list()[0]!.review).toBeUndefined()
  })

  test('single reads once and does NOT send the work back', async () => {
    const h = setup({ depth: 'single', reviewer: () => refused('The back button is missing.') })
    h.engine.assign(h.agent.id, 'Pages', 'build it', 'every page has a way out')
    await flush()
    await finish(h)

    expect(h.reviews).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    expect(h.reports).toHaveLength(1)
    expect(h.arrivals[0]!.arrival.kind).toBe('unresolved')
  })

  test('with no reviewer wired at all, everything behaves as it did before', async () => {
    const h = setup({ noGate: true })
    h.engine.assign(h.agent.id, 'Anything', 'do it', 'done')
    await flush()
    await finish(h)

    expect(h.reports).toHaveLength(1)
    expect(h.engine.list()[0]!.review).toBeUndefined()
  })
})

describe('approval, where both gates bite', () => {
  test('a boss cannot sign off work the reviewer refused without saying why', async () => {
    const h = setup({ reviewer: () => refused('Negative prices go through.') })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    for (let i = 0; i < 6 && h.runs.length > 0; i++) {
      const pending = h.runs.length
      await finish(h)
      await flush()
      if (h.runs.length === pending) break
    }

    const task = h.engine.list()[0]!
    const refusedApproval = h.engine.approve(task.id) as { error: string }
    expect(refusedApproval.error).toContain('not satisfied')
    expect(refusedApproval.error).toContain('Negative prices go through.')
    expect(h.engine.list()[0]!.status).toBe('review')
  })

  test('going past the reviewer reaches the owner, with the objection beside the excuse, and the job waits for them', async () => {
    const h = setup({ reviewer: () => refused('Negative prices go through.') })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    for (let i = 0; i < 6 && h.runs.length > 0; i++) {
      const pending = h.runs.length
      await finish(h)
      await flush()
      if (h.runs.length === pending) break
    }

    const task = h.engine.list()[0]!
    const out = h.engine.approve(task.id, 'The price field is an unsigned integer in the database.')

    expect('error' in out && out.error).toContain('the owner decides')
    expect(h.engine.list()[0]!.status).toBe('review')
    expect(h.engine.list()[0]!.review?.disputed).toContain('unsigned integer')
    expect(h.overrules).toHaveLength(1)
    expect(h.overrules[0]!.gate).toBe('reviewer')
    expect(h.overrules[0]!.findings[0]).toContain('Negative prices go through.')
    expect(h.overrules[0]!.why).toContain('unsigned integer')
  })

  test('when it was only a second opinion, the refusal says so', async () => {
    const h = setup({
      reviewer: () => ({
        satisfied: false,
        objections: ['This looks wrong.'],
        standing: 'second-opinion',
        why: 'The worker is already on the strongest brain there is.',
        reviewerModel: 'claude-fable-5',
        ran: true
      })
    })
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    for (let i = 0; i < 6 && h.runs.length > 0; i++) {
      const pending = h.runs.length
      await finish(h)
      await flush()
      if (h.runs.length === pending) break
    }

    const task = h.engine.list()[0]!
    const out = h.engine.approve(task.id) as { error: string }
    expect(out.error).toContain('second opinion rather than a review')
    expect(out.error).toContain('strongest brain there is')
  })

  test('passed work approves with no ceremony at all', async () => {
    const h = setup({})
    h.engine.assign(h.agent.id, 'Checkout', 'build it', 'prices are validated')
    await flush()
    await finish(h)

    const task = h.engine.list()[0]!
    expect(task.status).toBe('approved')
    expect(h.overrules).toHaveLength(0)
  })
})

describe('the two gates do not trip over each other', () => {
  test('work whose report already failed the #29 check is not reviewed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-gate-'))
    const roster = new RosterStore(dir)
    const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
    const runs: { resolve: (o: AgentRunOutcome) => void }[] = []
    const reviews: number[] = []
    const engine = new TaskEngine(
      dir,
      roster,
      () => new Promise<AgentRunOutcome>((resolve) => runs.push({ resolve })),
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      {
        verify: () => ({
          ok: false,
          note: '',
          findings: [{ kind: 'nothing-happened', text: 'Nothing happened in this job at all.' }]
        }),
        reviewDepth: () => 'full',
        review: () => {
          reviews.push(1)
          return Promise.resolve(passed())
        }
      }
    )
    engine.assign(agent.id, 'Checkout', 'build it', 'ok')
    await flush()
    runs[0]!.resolve({ ok: true, resultText: 'Built it.' })
    await flush()

    expect(reviews).toHaveLength(0)
    expect(engine.list()[0]!.status).toBe('review')
  })
})
