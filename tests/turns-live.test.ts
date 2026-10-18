import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { makeAgentRun } from '../src/main/lib/agent-runner'

const enabled = process.env['DAMON_SMOKE'] === '1'

const agent: AgentInfo = {
  id: 'a1',
  name: 'Counter',
  role: 'reads files one at a time',
  model: 'claude-haiku-4-5-20251001',
  kind: 'agent',
  maxTurns: 2,
  createdAt: new Date().toISOString()
}

const task: TaskInfo = {
  id: 't1',
  agentId: 'a1',
  title: 'Read every file',
  instructions:
    'Read one.txt, then two.txt, then three.txt, then four.txt, then five.txt, one at a time using a separate Read call for each. Then say what every one of them contains.',
  acceptance: 'every file has been read and its contents reported',
  status: 'working',
  round: 1,
  feedback: [],
  writes: ['**/*.txt'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

describe('a job that runs out of steps', () => {
  test.skipIf(!enabled)('is stopped, and still hands over what it did', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-turns-live-'))
    for (const n of ['one', 'two', 'three', 'four', 'five']) {
      writeFileSync(join(dir, `${n}.txt`), `the word is ${n}`, 'utf8')
    }

    let spent = 0
    const run = makeAgentRun(
      {
        cliPath: 'claude',
        cwd: dir,
        projectName: 'Step cap',
        projectId: 'p1',
        skipPermissions: true,
        memoryOf: () => ({ agentMd: 'You read files.', memoryMd: '', rejections: [] }),
        onNotes: () => {},
        onUsage: (_c, tokens) => {
          spent += tokens
        }
      },
      () => {}
    )

    const outcome = await run(agent, task, null)

    expect(outcome.resultText.length).toBeGreaterThan(40)

    expect(outcome.resultText).toMatch(/ran out of steps/i)

    expect(outcome.resultText).toMatch(/one/i)
    expect(outcome.resultText).toMatch(/three|four|five|unfinished|did not|not (yet )?read/i)

    expect(outcome.sessionId).toBeTruthy()

    expect(spent).toBeGreaterThan(0)

    console.log('\n--- what the owner would see ---\n' + outcome.resultText.slice(0, 900) + '\n')
    console.log('tokens counted for the whole thing:', spent.toLocaleString())
  })
})
