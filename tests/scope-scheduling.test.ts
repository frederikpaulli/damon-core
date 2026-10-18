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
  agents: AgentInfo[]
  started: TaskInfo[]
  finish: (title: string) => Promise<void>
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'damon-scope-'))
  const roster = new RosterStore(dir)
  const agents = [
    roster.list()[0] ?? roster.add('One', 'Builder', undefined),
    roster.add('Two', 'Builder', undefined),
    roster.add('Three', 'Builder', undefined)
  ]
  const started: TaskInfo[] = []
  const pending = new Map<string, (o: AgentRunOutcome) => void>()

  const engine = new TaskEngine(
    dir,
    roster,
    (_a, t) =>
      new Promise<AgentRunOutcome>((resolve) => {
        started.push(t)
        pending.set(t.title, resolve)
      }),
    { onTaskUpdate: () => {}, onAgentReport: () => {} },
    { maxParallel: 5 }
  )

  return {
    engine,
    agents,
    started,
    finish: async (title: string) => {
      pending.get(title)?.({ ok: true, resultText: 'done' })
      pending.delete(title)
      await flush()
    }
  }
}

describe('two jobs in the same place', () => {
  test('the second one WAITS rather than running on top of the first', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Checkout', 'build', 'ok', undefined, undefined, ['src/api/**'])
    h.engine.assign(h.agents[1]!.id, 'Orders', 'build', 'ok', undefined, undefined, ['src/api/orders.ts'])
    await flush()

    expect(h.started.map((t) => t.title)).toEqual(['Checkout'])
  })

  test('and starts the moment the ground is clear', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Checkout', 'build', 'ok', undefined, undefined, ['src/api/**'])
    h.engine.assign(h.agents[1]!.id, 'Orders', 'build', 'ok', undefined, undefined, ['src/api/orders.ts'])
    await flush()
    await h.finish('Checkout')

    expect(h.started.map((t) => t.title)).toEqual(['Checkout', 'Orders'])
  })

  test('work in a different place runs straight away', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Checkout', 'build', 'ok', undefined, undefined, ['src/api/**'])
    h.engine.assign(h.agents[1]!.id, 'Buttons', 'build', 'ok', undefined, undefined, ['src/ui/**'])
    await flush()

    expect(h.started.map((t) => t.title).sort()).toEqual(['Buttons', 'Checkout'])
  })

  test('a folder named like another is not the same folder', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'A', 'build', 'ok', undefined, undefined, ['src/a/**'])
    h.engine.assign(h.agents[1]!.id, 'AB', 'build', 'ok', undefined, undefined, ['src/ab/**'])
    await flush()

    expect(h.started).toHaveLength(2)
  })
})

describe('the shared spine', () => {
  test('a job changing the database shape runs on its own', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Buttons', 'build', 'ok', undefined, undefined, ['src/ui/**'])
    await flush()
    h.engine.assign(h.agents[1]!.id, 'Migration', 'build', 'ok', undefined, undefined, ['prisma/migrations/**'])
    await flush()

    expect(h.started.map((t) => t.title)).toEqual(['Buttons'])
  })

  test('but unrelated work is free to start alongside it', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Migration', 'build', 'ok', undefined, undefined, ['prisma/migrations/**'])
    await flush()
    h.engine.assign(h.agents[1]!.id, 'Buttons', 'build', 'ok', undefined, undefined, ['src/ui/**'])
    await flush()

    expect(h.started.map((t) => t.title)).toEqual(['Migration', 'Buttons'])
  })

  test('a second schema change still waits, which is the rule that matters', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Migration', 'build', 'ok', undefined, undefined, ['prisma/migrations/**'])
    await flush()
    h.engine.assign(h.agents[1]!.id, 'Second Migration', 'build', 'ok', undefined, undefined, ['prisma/migrations/**'])
    await flush()

    expect(h.started.map((t) => t.title)).toEqual(['Migration'])
    await h.finish('Migration')
    expect(h.started.map((t) => t.title)).toEqual(['Migration', 'Second Migration'])
  })
})

describe('work that predates all of this', () => {
  test('a job with no declared area is not held up', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Old One', 'build', 'ok')
    h.engine.assign(h.agents[1]!.id, 'Old Two', 'build', 'ok')
    await flush()

    expect(h.started).toHaveLength(2)
  })

  test('and it does not hold anything else up either', async () => {
    const h = setup()
    h.engine.assign(h.agents[0]!.id, 'Old', 'build', 'ok')
    await flush()
    h.engine.assign(h.agents[1]!.id, 'New', 'build', 'ok', undefined, undefined, ['src/api/**'])
    await flush()

    expect(h.started).toHaveLength(2)
  })
})

describe('the declared area is kept with the job', () => {
  test('so it survives a restart and can be checked at handback', () => {
    const h = setup()
    const t = h.engine.assign(h.agents[0]!.id, 'Checkout', 'build', 'ok', undefined, undefined, [
      'src/api/**'
    ]) as TaskInfo
    expect(h.engine.get(t.id)?.writes).toEqual(['src/api/**'])
  })
})
