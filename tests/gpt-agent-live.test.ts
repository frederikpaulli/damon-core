import { describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { makeAgentRun } from '../src/main/lib/agent-runner'

const enabled = process.env['DAMON_SMOKE'] === '1'

describe('a GPT agent, for real', () => {
  test.skipIf(!enabled)('does the work, reports back, and is counted', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-gpt-'))

    const activity: string[] = []
    const usage: { costUsd: number; tokens: number; reported: boolean }[] = []

    const run = makeAgentRun(
      {
        cliPath: 'codex',
        cwd: dir,
        projectName: 'Live',
        projectId: 'live',
        skipPermissions: true,
        memoryOf: () => ({ agentMd: '', memoryMd: '', rejections: [] }),
        onNotes: () => {},
        onUsage: (costUsd, tokens, meta) => usage.push({ costUsd, tokens, reported: meta.reported })
      },
      (_id, line) => {
        if (line.kind === 'activity') activity.push(line.text)
      }
    )

    const agent: AgentInfo = {
      id: 'a1',
      name: 'Builder',
      role: 'writes files',
      model: 'openai-gpt',
      kind: 'agent',
      createdAt: new Date().toISOString()
    }
    const task: TaskInfo = {
      id: 't1',
      agentId: 'a1',
      title: 'Write the file',
      instructions: 'Create a file called built.txt in the current directory containing the word BUILT.',
      acceptance: 'built.txt exists and contains BUILT',
      status: 'working',
      round: 1,
      feedback: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const outcome = await run(agent, task, null)

    expect(outcome.ok).toBe(true)
    expect(existsSync(join(dir, 'built.txt'))).toBe(true)
    expect(readFileSync(join(dir, 'built.txt'), 'utf8')).toContain('BUILT')

    expect(activity.length).toBeGreaterThan(0)

    expect(usage).toHaveLength(1)
    expect(usage[0]!.tokens).toBeGreaterThan(0)
    expect(usage[0]!.reported).toBe(true)
  })
})
