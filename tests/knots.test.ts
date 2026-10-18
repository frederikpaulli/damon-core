import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskInfo } from '../src/shared/types'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRunOutcome } from '../src/main/lib/task-engine'
import { findKnot } from '../src/shared/knots'

const edges = (o: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(o))

describe('a job may not wait on itself, directly or round a ring', () => {
  test('waiting on itself', () => {
    expect(findKnot(edges({}), 'a', ['a'])).toEqual(['a', 'a'])
  })

  test('a ring of two', () => {
    const knot = findKnot(edges({ b: ['a'] }), 'a', ['b'])
    expect(knot).not.toBeNull()
    expect(knot).toContain('a')
    expect(knot).toContain('b')
  })

  test('a ring of three', () => {
    const knot = findKnot(edges({ b: ['a'], c: ['b'] }), 'a', ['c'])
    expect(knot).not.toBeNull()
    expect(knot!.length).toBeGreaterThanOrEqual(3)
  })

  test('a long chain that does not close is fine', () => {
    expect(findKnot(edges({ b: ['a'], c: ['b'], d: ['c'] }), 'e', ['d'])).toBeNull()
  })

  test('two jobs waiting on the same thing is not a knot', () => {
    expect(findKnot(edges({ b: ['a'], c: ['a'] }), 'd', ['b', 'c'])).toBeNull()
  })

  test('nothing to wait for is never a knot', () => {
    expect(findKnot(edges({ b: ['a'] }), 'z', [])).toBeNull()
  })

  test('a diamond does not hang the search', () => {
    expect(findKnot(edges({ b: ['a'], c: ['a'], d: ['b', 'c'] }), 'e', ['d'])).toBeNull()
  })
})

function setup(): { engine: TaskEngine; agentId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'damon-knots-'))
  const roster = new RosterStore(dir)
  const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
  const engine = new TaskEngine(
    dir,
    roster,
    () => new Promise<AgentRunOutcome>(() => {}),
    { onTaskUpdate: () => {}, onAgentReport: () => {} },
    { maxParallel: 4 }
  )
  return { engine, agentId: agent.id }
}

const idOf = (r: ReturnType<TaskEngine['assign']>): string => {
  if ('error' in r) throw new Error(r.error)
  return (r as TaskInfo).id
}

describe('the engine refuses a knot before anything is saved', () => {
  test('an unknown id is refused by name', () => {
    const h = setup()
    const out = h.engine.assign(h.agentId, 'B', 'x', 'y', undefined, undefined, undefined, ['no-such-job'])
    expect('error' in out).toBe(true)
    expect((out as { error: string }).error).toContain('no-such-job')
    expect(h.engine.list()).toHaveLength(0)
  })

  test('a ring is refused, and the refusal names the jobs in it', () => {
    const h = setup()
    const a = idOf(h.engine.assign(h.agentId, 'Build the schema', 'x', 'y'))
    const b = idOf(h.engine.assign(h.agentId, 'Use the schema', 'x', 'y', undefined, undefined, undefined, [a]))

    const out = h.engine.addNeeds(a, [b])
    expect('error' in out).toBe(true)
    const said = (out as { error: string }).error
    expect(said).toContain('Build the schema')
    expect(said).toContain('Use the schema')
    expect(h.engine.get(a)!.needs ?? []).toEqual([])
  })

  test('a dependency that closes no ring is accepted', () => {
    const h = setup()
    const a = idOf(h.engine.assign(h.agentId, 'A', 'x', 'y'))
    const b = idOf(h.engine.assign(h.agentId, 'B', 'x', 'y'))
    expect('error' in h.engine.addNeeds(b, [a])).toBe(false)
    expect(h.engine.get(b)!.needs).toEqual([a])
  })
})
