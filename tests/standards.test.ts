import { describe, expect, test, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterStore } from '../src/main/lib/roster-store'
import { MAX_REVISIONS, TaskEngine, type Overrule } from '../src/main/lib/task-engine'
import type { AgentRunOutcome } from '../src/main/lib/task-engine'

const failing = {
  ok: false,
  findings: [{ kind: 'missing-file' as const, text: 'It says it wrote out/report.md and that file is not there.' }],
  note: 'One claim in this report does not match what happened.'
}

let dir = ''
let roster: RosterStore
let engine: TaskEngine
let overrules: Overrule[] = []
let outcome: AgentRunOutcome = { ok: true, resultText: 'done' }

const newTask = async (title = 'Write the report'): Promise<string> => {
  const agent = roster.add('Bram', 'writer', 'claude-sonnet-5')
  const t = engine.assign(agent.id, title, 'do it', 'the file exists')
  if ('error' in t) throw new Error(t.error)
  await new Promise((r) => setTimeout(r, 30))
  return t.id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'damon-standards-'))
  roster = new RosterStore(dir)
  overrules = []
  outcome = { ok: true, resultText: 'done' }
  engine = new TaskEngine(
    dir,
    roster,
    async () => outcome,
    { onTaskUpdate: () => {}, onAgentReport: () => {} },
    {
      verify: () => failing,
      onOverruled: (o) => overrules.push(o)
    }
  )
})

describe('approving past a failed check is seen', () => {
  test('an overrule reports the reason AND the finding it went past', async () => {
    const id = await newTask()
    engine.approve(id, 'The file is there, the checker looked in the wrong folder.')

    expect(overrules).toHaveLength(1)
    expect(overrules[0]!.why).toContain('wrong folder')
    expect(overrules[0]!.findings.join(' ')).toContain('out/report.md')
    expect(overrules[0]!.title).toBe('Write the report')
  })

  test('an ordinary approval with nothing to overrule says nothing', async () => {
    engine = new TaskEngine(
      dir,
      roster,
      async () => outcome,
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      { verify: () => null, onOverruled: (o) => overrules.push(o) }
    )
    const id = await newTask()
    engine.approve(id)

    expect(overrules).toEqual([])
  })

  test('a manager cannot skip the announcement by overruling twice', async () => {
    const id = await newTask()
    engine.approve(id, 'first reason')
    engine.approve(id, 'second reason')

    expect(overrules).toHaveLength(1)
  })

  test('a blank reason is still refused, so the announcement cannot be dodged', async () => {
    const id = await newTask()
    const r = engine.approve(id, '   ')

    expect('error' in r).toBe(true)
    expect(overrules).toEqual([])
  })
})

describe('the revision cap is deliberate', () => {
  test('the cap is a named constant, not a number that happened', () => {
    expect(MAX_REVISIONS).toBe(3)
  })

  test('nothing can pass a different one', () => {
    const opts = { maxRounds: 99 } as unknown as Record<string, unknown>
    const e = new TaskEngine(dir, roster, async () => outcome, { onTaskUpdate: () => {}, onAgentReport: () => {} }, opts)

    expect((e as unknown as { maxRounds: number }).maxRounds).toBe(MAX_REVISIONS)
  })
})
