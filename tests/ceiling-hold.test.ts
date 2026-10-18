import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine } from '../src/main/lib/task-engine'
import type { AgentInfo } from '../src/shared/types'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

describe('a ceiling on one provider', () => {
  test('holds that provider’s work and lets the other provider run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-ceiling-'))
    const roster = new RosterStore(dir)
    const started: string[] = []
    const capped = (agent: AgentInfo): boolean => agent.model.startsWith('claude')

    const engine = new TaskEngine(
      dir,
      roster,
      async (agent) => {
        started.push(agent.name)
        return { ok: true, resultText: 'done' }
      },
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      { overBudget: capped }
    )

    const onClaude = roster.add('Claude Worker', 'writes', 'claude-sonnet-5')
    const onGpt = roster.add('GPT Worker', 'writes', 'openai-gpt')
    engine.assign(onClaude.id, 'Held job', 'do it', 'done')
    engine.assign(onGpt.id, 'Free job', 'do it', 'done')
    await settle()

    expect(started).toEqual(['GPT Worker'])
    expect(engine.list().find((t) => t.title === 'Held job')!.status).toBe('queued')
  })

  test('the held work starts on its own once the ceiling lifts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-ceiling-'))
    const roster = new RosterStore(dir)
    const started: string[] = []
    let spent = true

    const engine = new TaskEngine(
      dir,
      roster,
      async (agent) => {
        started.push(agent.name)
        return { ok: true, resultText: 'done' }
      },
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      { overBudget: () => spent }
    )

    const agent = roster.add('Worker', 'writes', 'claude-sonnet-5')
    engine.assign(agent.id, 'Waiting job', 'do it', 'done')
    await settle()
    expect(started).toEqual([])

    spent = false
    engine.nudge()
    await settle()

    expect(started).toEqual(['Worker'])
  })

  test('the owner is told once, not once per job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-ceiling-'))
    const roster = new RosterStore(dir)
    const told: string[] = []

    const engine = new TaskEngine(
      dir,
      roster,
      async () => ({ ok: true, resultText: 'done' }),
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      { overBudget: () => true, onBudgetReached: (agent) => told.push(agent.name) }
    )

    const agent = roster.add('Worker', 'writes', 'claude-sonnet-5')
    engine.assign(agent.id, 'One', 'do it', 'done')
    engine.assign(agent.id, 'Two', 'do it', 'done')
    engine.assign(agent.id, 'Three', 'do it', 'done')
    await settle()

    expect(told).toEqual(['Worker'])
  })
})
