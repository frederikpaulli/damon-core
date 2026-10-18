import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterStore } from '../src/main/lib/roster-store'
import { TaskEngine, type AgentRunOutcome, type ReviewOutcome } from '../src/main/lib/task-engine'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('approving a job with a pending re-review', () => {
  test('is refused until the reviewer has read it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-gate-'))
    const roster = new RosterStore(dir)
    const agent = roster.add('Scout', 'Builder', undefined)
    const runs: { resolve: (o: AgentRunOutcome) => void }[] = []
    const reviews: { resolve: (o: ReviewOutcome) => void }[] = []
    const engine = new TaskEngine(
      dir,
      roster,
      () => new Promise<AgentRunOutcome>((resolve) => runs.push({ resolve })),
      { onTaskUpdate: () => {}, onAgentReport: () => {} },
      { reviewDepth: () => 'full', review: () => new Promise<ReviewOutcome>((resolve) => reviews.push({ resolve })) }
    )
    engine.assign(agent.id, 'Letter', 'write it', 'it names the company')
    await flush()
    runs[0]!.resolve({ ok: true, resultText: 'Wrote it.' })
    await flush()
    expect(engine.list()[0]!.status).toBe('reviewing')
    engine.stopRunning()
    const job = engine.list()[0]!
    expect(job.status).toBe('review')
    expect(job.gatePending).toBe(true)

    const early = engine.approve(job.id)
    expect('error' in early).toBe(true)
    if ('error' in early) expect(early.error).toMatch(/reads it again|current review must finish/)
    expect(engine.list()[0]!.status).toBe('review')
  })
})
