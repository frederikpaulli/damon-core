import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRunOutcome } from '../src/main/lib/task-engine'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

interface Harness {
  engine: TaskEngine
  agent: AgentInfo
  runs: { title: string; resolve: (o: AgentRunOutcome) => void }[]
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'damon-waits-'))
  const roster = new RosterStore(dir)
  const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
  const runs: Harness['runs'] = []
  const engine = new TaskEngine(
    dir,
    roster,
    (_a, t) => new Promise<AgentRunOutcome>((resolve) => runs.push({ title: t.title, resolve })),
    { onTaskUpdate: () => {}, onAgentReport: () => {} },
    { maxParallel: 4 }
  )
  return { engine, agent, runs }
}

const idOf = (r: ReturnType<TaskEngine['assign']>): string => {
  if ('error' in r) throw new Error(r.error)
  return (r as TaskInfo).id
}

describe('a job waits for the job it depends on', () => {
  test('part nine does not start before part one is signed off', async () => {
    const h = setup()
    const one = idOf(h.engine.assign(h.agent.id, 'Part one', 'build the schema', 'schema exists'))
    h.engine.assign(h.agent.id, 'Part nine', 'use the schema', 'it reads the schema', undefined, undefined, undefined, [
      one
    ])
    await flush()

    expect(h.runs.map((r) => r.title)).toEqual(['Part one'])
  })

  test('and it says WHY it has not started, in words the owner can read', async () => {
    const h = setup()
    const one = idOf(h.engine.assign(h.agent.id, 'Build the database schema', 'x', 'y'))
    h.engine.assign(h.agent.id, 'Part nine', 'x', 'y', undefined, undefined, undefined, [one])
    await flush()

    const waiting = h.engine.list().find((t) => t.title === 'Part nine')!
    expect(waiting.waitingFor).toContain('Build the database schema')
  })

  test('it starts the moment the thing it waited for is approved', async () => {
    const h = setup()
    const one = idOf(h.engine.assign(h.agent.id, 'Part one', 'x', 'y'))
    h.engine.assign(h.agent.id, 'Part nine', 'x', 'y', undefined, undefined, undefined, [one])
    await flush()

    h.runs[0]!.resolve({ ok: true, resultText: 'done' })
    await flush()
    h.engine.approve(one)
    await flush()

    expect(h.runs.map((r) => r.title)).toEqual(['Part one', 'Part nine'])
  })

  test('a finished-but-not-approved dependency is not enough', async () => {
    const h = setup()
    const one = idOf(h.engine.assign(h.agent.id, 'Part one', 'x', 'y'))
    h.engine.assign(h.agent.id, 'Part nine', 'x', 'y', undefined, undefined, undefined, [one])
    await flush()
    h.runs[0]!.resolve({ ok: true, resultText: 'done' })
    await flush()

    expect(h.runs.map((r) => r.title)).toEqual(['Part one'])
  })

  test('a job with no needs behaves exactly as it always did', async () => {
    const h = setup()
    h.engine.assign(h.agent.id, 'A', 'x', 'y')
    h.engine.assign(h.agent.id, 'B', 'x', 'y')
    await flush()
    expect(h.runs).toHaveLength(2)
  })

  test('a missing prerequisite remains blocked until explicitly replaced', () => {
    const h = setup()
    const nine = h.engine.assign(h.agent.id, 'Part nine', 'x', 'y', undefined, undefined, undefined, [])
    if ('error' in nine) throw new Error(nine.error)
    ;(nine as TaskInfo).needs = ['a-job-that-was-deleted']
    expect(h.engine.blockedBy(nine as TaskInfo)?.id).toBe('a-job-that-was-deleted')
  })
})
