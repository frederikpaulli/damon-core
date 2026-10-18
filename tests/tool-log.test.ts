import { describe, expect, test, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandlingStore, ToolLog, safeName, type ToolUse } from '../src/main/lib/tool-log'

let dir: string

const use = (over: Partial<ToolUse> = {}): ToolUse => ({
  at: new Date().toISOString(),
  agentId: 'a1',
  agentName: 'Robin',
  taskId: 't1',
  taskTitle: 'Build the thing',
  provider: 'claude',
  model: 'claude-sonnet-5',
  tool: 'Write',
  summary: 'Editing src/index.ts',
  ...over
})

const files = (): string[] => {
  try {
    return readdirSync(join(dir, 'tool-use'))
  } catch {
    return []
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'damon-toollog-'))
})

describe('the tool log', () => {
  test('what an agent did comes back in the order it happened', () => {
    const log = new ToolLog(dir)
    log.record(use({ summary: 'Reading a.ts' }))
    log.record(use({ summary: 'Editing b.ts' }))
    log.record(use({ summary: 'Running: npm test' }))

    expect(log.forTask('t1').map((r) => r.summary)).toEqual(['Reading a.ts', 'Editing b.ts', 'Running: npm test'])
  })

  test('reading one job does not read any other job', () => {
    const log = new ToolLog(dir)
    for (let i = 0; i < 50; i++) log.record(use({ taskId: 'noisy-neighbour', summary: `noise ${i}` }))
    log.record(use({ taskId: 'the-one', summary: 'the only thing that matters' }))

    expect(log.forTask('the-one')).toHaveLength(1)
    expect(files().sort()).toEqual(['noisy-neighbour.jsonl', 'the-one.jsonl'])
  })

  test('a job id cannot climb out of the folder or mean something to Windows', () => {
    expect(safeName('../../etc/passwd')).not.toContain('/')
    expect(safeName('../../etc/passwd')).not.toContain('.')
    expect(safeName('CON:')).not.toContain(':')
    expect(safeName('')).toBe('unknown')

    const log = new ToolLog(dir)
    log.record(use({ taskId: '../escape' }))
    expect(files()).toHaveLength(1)
    expect(files()[0]).not.toContain('..')
  })

  test('the provider own name for the tool is kept as well as the plain one', () => {
    const log = new ToolLog(dir)
    log.record(use({ tool: 'command_execution', summary: 'Running: npm test' }))
    const row = log.forTask('t1')[0]!
    expect(row.tool).toBe('command_execution')
    expect(row.summary).toBe('Running: npm test')
  })

  test('a job where nothing was actually done is visible as exactly that', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'did-something' }))
    expect(log.countForTask('did-something')).toBe(1)
    expect(log.countForTask('claimed-but-did-nothing')).toBe(0)
  })

  test('a tool used outside any job is still recorded', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: undefined, taskTitle: undefined }))
    expect(log.recent()).toHaveLength(1)
  })

  test('the newest work comes back first when you ask across jobs', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'old', summary: 'old thing' }))
    log.record(use({ taskId: 'new', summary: 'new thing' }))
    expect(log.recent()[0]!.summary).toBe('new thing')
  })

  test('one person work can be asked for on its own', () => {
    const log = new ToolLog(dir)
    log.record(use({ agentId: 'a1', taskId: 't1' }))
    log.record(use({ agentId: 'a2', taskId: 't2' }))
    log.record(use({ agentId: 'a1', taskId: 't3' }))
    expect(log.forAgent('a1')).toHaveLength(2)
  })

  test('a broken line does not take the rest of the job with it', () => {
    const log = new ToolLog(dir)
    log.record(use({ summary: 'first' }))
    const file = join(dir, 'tool-use', 't1.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{not json\n')
    log.record(use({ summary: 'third' }))
    expect(log.forTask('t1').map((r) => r.summary)).toEqual(['first', 'third'])
  })

  test('reading a job that never happened is empty, not an error', () => {
    expect(new ToolLog(join(dir, 'nothing-here')).forTask('nope')).toEqual([])
    expect(new ToolLog(join(dir, 'nothing-here')).recent()).toEqual([])
  })
})

describe('retention', () => {
  const OLD = '2026-01-01T00:00:00.000Z'
  const NOW = '2026-07-31T00:00:00.000Z'
  const CUTOFF = '2026-07-01T00:00:00.000Z'

  test('a job with nothing worth keeping is deleted whole', async () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'stale', at: OLD }))
    log.record(use({ taskId: 'stale', at: OLD }))

    const result = await log.prune(CUTOFF)

    expect(result.filesDropped).toBe(1)
    expect(result.linesDropped).toBe(2)
    expect(files()).toHaveLength(0)
  })

  test('a flagged call is kept forever, however old, and its job survives', async () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'mixed', at: OLD, summary: 'ordinary', flagged: false }))
    log.record(use({ taskId: 'mixed', at: OLD, summary: 'spent money', flagged: true }))

    await log.prune(CUTOFF)

    expect(log.forTask('mixed').map((u) => u.summary)).toEqual(['spent money'])
  })

  test('recent work is untouched', async () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'fresh', at: NOW }))
    expect(await log.prune(CUTOFF)).toEqual({ filesDropped: 0, linesDropped: 0 })
    expect(log.forTask('fresh')).toHaveLength(1)
  })
})

describe('removing one subject', () => {
  test('every mention is found, across jobs', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 't1', summary: 'Emailing hannah@example.com about the invoice' }))
    log.record(use({ taskId: 't2', summary: 'Reading src/index.ts' }))
    log.record(use({ taskId: 't3', summary: 'Adding HANNAH@example.com to the list' }))

    expect(log.findMentioning('hannah@example.com')).toHaveLength(2)
  })

  test('removing a subject leaves everything else alone', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 't1', summary: 'Emailing hannah@example.com' }))
    log.record(use({ taskId: 't1', summary: 'Reading src/index.ts' }))
    log.record(use({ taskId: 't2', summary: 'Nothing to do with her' }))

    expect(log.purgeMentioning('hannah@example.com')).toBe(1)
    expect(log.forTask('t1').map((u) => u.summary)).toEqual(['Reading src/index.ts'])
    expect(log.forTask('t2')).toHaveLength(1)
  })

  test('a job that was only about that person is deleted whole', () => {
    const log = new ToolLog(dir)
    log.record(use({ taskId: 'hers', summary: 'Emailing hannah@example.com' }))
    log.purgeMentioning('hannah@example.com')
    expect(files()).toHaveLength(0)
  })

  test('an empty search removes nothing, rather than everything', () => {
    const log = new ToolLog(dir)
    log.record(use())
    expect(log.purgeMentioning('')).toBe(0)
    expect(log.forTask('t1')).toHaveLength(1)
  })
})

describe('how a project must be handled', () => {
  test('a project says nothing special until someone says so', () => {
    expect(new HandlingStore(dir).get()).toEqual({ touchesPersonalData: false, noTrainingProviders: false })
  })

  test('what the owner sets is what comes back, and it survives a restart', () => {
    new HandlingStore(dir).set({ touchesPersonalData: true, noTrainingProviders: true })
    expect(new HandlingStore(dir).get()).toEqual({ touchesPersonalData: true, noTrainingProviders: true })
  })
})
