import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskInfo } from '../src/shared/types'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRunOutcome } from '../src/main/lib/task-engine'
import { resolveKeys } from '../src/shared/knots'

describe('keys in a swarm become ids', () => {
  test('a job waits for another job in the same call', () => {
    const out = resolveKeys([{ key: 'schema' }, { key: 'api', waits_for: ['schema'] }], ['t1', 't2'])
    expect(out).toEqual([[], ['t1']])
  })

  test('a job may also wait for a job that already exists', () => {
    expect(resolveKeys([{ key: 'api', waits_for: ['t-existing'] }], ['t9'])).toEqual([['t-existing']])
  })

  test('an unknown key is left alone so the engine can refuse it by name', () => {
    expect(resolveKeys([{ key: 'api', waits_for: ['typo'] }], ['t1'])).toEqual([['typo']])
  })

  test('no keys at all is the ordinary case', () => {
    expect(resolveKeys([{}, {}], ['t1', 't2'])).toEqual([[], []])
  })
})

interface Harness {
  engine: TaskEngine
  agentId: string
  started: string[]
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'damon-swarm-'))
  const roster = new RosterStore(dir)
  const agent = roster.list()[0] ?? roster.add('Scout', 'Builder', undefined)
  const started: string[] = []
  const engine = new TaskEngine(
    dir,
    roster,
    (_a, t) =>
      new Promise<AgentRunOutcome>(() => {
        started.push(t.title)
      }),
    { onTaskUpdate: () => {}, onAgentReport: () => {} },
    { maxParallel: 4 }
  )
  return { engine, agentId: agent.id, started }
}

const job = (h: Harness, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: h.agentId,
  title,
  instructions: 'x',
  acceptance: 'y',
  ...extra
})

describe('a whole milestone in one call', () => {
  test('only the job that waits for nothing starts', () => {
    const h = setup()
    const out = h.engine.assignMany([
      job(h, 'Build the schema', { key: 'schema' }),
      job(h, 'Wire the API', { key: 'api', waits_for: ['schema'] }),
      job(h, 'Build the screens', { waits_for: ['api'] })
    ] as never)
    expect('error' in out).toBe(false)
    expect((out as TaskInfo[]).length).toBe(3)
    expect(h.started).toEqual(['Build the schema'])
  })

  test('the keys survive nowhere', () => {
    const h = setup()
    const out = h.engine.assignMany([
      job(h, 'A', { key: 'a' }),
      job(h, 'B', { key: 'b', waits_for: ['a'] })
    ] as never) as TaskInfo[]
    const b = out.find((t) => t.title === 'B')!
    expect(b.needs).toEqual([out.find((t) => t.title === 'A')!.id])
    expect(JSON.stringify(out)).not.toContain('"key"')
  })

  test('a ring inside one swarm is refused and NOTHING is created', () => {
    const h = setup()
    const out = h.engine.assignMany([
      job(h, 'A', { key: 'a', waits_for: ['b'] }),
      job(h, 'B', { key: 'b', waits_for: ['a'] })
    ] as never)
    expect('error' in out).toBe(true)
    expect((out as { error: string }).error).toContain('A')
    expect((out as { error: string }).error).toContain('B')
    expect(h.engine.list()).toHaveLength(0)
    expect(h.started).toEqual([])
  })

  test('an unknown key is refused and NOTHING is created', () => {
    const h = setup()
    const out = h.engine.assignMany([job(h, 'A', { key: 'a' }), job(h, 'B', { waits_for: ['typo'] })] as never)
    expect('error' in out).toBe(true)
    expect((out as { error: string }).error).toContain('typo')
    expect(h.engine.list()).toHaveLength(0)
  })

  test('a swarm with no waiting at all behaves like ordinary assignment', () => {
    const h = setup()
    h.engine.assignMany([job(h, 'A'), job(h, 'B')] as never)
    expect(h.started.sort()).toEqual(['A', 'B'])
  })
})
