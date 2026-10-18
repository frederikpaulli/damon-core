import { describe, expect, test } from 'vitest'
import type { AgentInfo, TaskInfo } from '../src/shared/types'
import { makeAgentRun } from '../src/main/lib/agent-runner'
import type { SpawnedProcess, Spawner } from '../src/main/lib/manager-session'
import { agentTaskPrompt } from '../src/main/lib/agent-prompt'

class FakeProc implements SpawnedProcess {
  written = ''
  private stdoutCb: ((d: Buffer) => void) | null = null
  private closeCb: ((code: number | null) => void) | null = null
  stdin = { write: (d: string): void => void (this.written += d), end: (): void => {} }
  stdout = { on: (_ev: 'data', cb: (d: Buffer) => void): void => void (this.stdoutCb = cb) }
  stderr = { on: (): void => {} }
  on(_ev: 'close', cb: (code: number | null) => void): void {
    this.closeCb = cb
  }
  kill(): void {}
  emitLine(obj: unknown): void {
    this.stdoutCb?.(Buffer.from(JSON.stringify(obj) + '\n'))
  }
  close(code: number | null): void {
    this.closeCb?.(code)
  }
}

const agent: AgentInfo = { id: 'a1', name: 'Scout', role: 'Builder', model: 'claude-sonnet-5', createdAt: 'x' }
const task: TaskInfo = {
  id: 't1',
  agentId: 'a1',
  title: 'Build the about page',
  instructions: 'Make it',
  acceptance: 'It exists',
  status: 'working',
  round: 1,
  feedback: [],
  writes: ['src/pages/**'],
  createdAt: 'x',
  updatedAt: 'x'
}

async function runWith(lines: unknown[]): Promise<{ plan: unknown; changedFiles: unknown }> {
  const procs: FakeProc[] = []
  const spawner: Spawner = () => {
    const p = new FakeProc()
    procs.push(p)
    return p
  }
  const run = makeAgentRun(
    {
      cliPath: 'claude',
      cwd: 'C:\\p',
      projectName: 'Demo',
      projectId: 'p1',
      skipPermissions: false,
      memoryOf: () => ({ agentMd: 'x', memoryMd: '', rejections: [] }),
      onNotes: () => {}
    },
    () => {},
    spawner
  )
  const done = run(agent, task, null)
  await Promise.resolve()
  procs[0]!.emitLine({ type: 'system', subtype: 'init', session_id: 's1' })
  for (const l of lines) procs[0]!.emitLine(l)
  procs[0]!.emitLine({ type: 'result', subtype: 'success' })
  procs[0]!.close(0)
  const outcome = await done
  return { plan: outcome.plan, changedFiles: outcome.changedFiles }
}

const text = (t: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
const write = (path: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: path, name: 'Write', input: { file_path: path } }] } })
const read = (path: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r' + path, name: 'Read', input: { file_path: path } }] } })

describe('the plan, read off the run', () => {
  test('a plan said before the first change is kept, and marked as first', async () => {
    const r = await runWith([read('index.html'), text('PLAN:\n1. Make src/pages/about.html\n2. Link it'), write('src/pages/about.html'), text('Done.')])
    expect(r.plan).toEqual({ text: '1. Make src/pages/about.html\n2. Link it', beforeChanges: true })
    expect(r.changedFiles).toBe(true)
  })
  test('a plan said after a file was changed is marked as late', async () => {
    const r = await runWith([write('src/pages/about.html'), text('PLAN:\nnow I plan'), text('Done.')])
    expect(r.plan).toEqual({ text: 'now I plan', beforeChanges: false })
  })
  test('no plan and no change', async () => {
    const r = await runWith([read('index.html'), text('The answer is 4.')])
    expect(r.plan).toBeNull()
    expect(r.changedFiles).toBe(false)
  })
  test('a new job is told to plan first and where it may write', () => {
    const prompt = agentTaskPrompt(task, null)
    expect(prompt).toContain('PLAN:')
    expect(prompt).toContain('src/pages/**')
    expect(prompt.indexOf('PLAN:')).toBeGreaterThan(prompt.indexOf('Acceptance criteria'))
  })
  test('a revision round is not asked to plan again', () => {
    expect(agentTaskPrompt(task, 'Fix the link')).not.toContain('PLAN:')
  })
})

describe('a refused plan', () => {
  test('stops the run before the first change, with the reason as the report', async () => {
    const procs: FakeProc[] = []
    const spawner: Spawner = () => {
      const p = new FakeProc()
      procs.push(p)
      return p
    }
    const run = makeAgentRun(
      {
        cliPath: 'claude',
        cwd: 'C:\p',
        projectName: 'Demo',
        projectId: 'p1',
        skipPermissions: false,
        memoryOf: () => ({ agentMd: 'x', memoryMd: '', rejections: [] }),
        onNotes: () => {},
        planCheck: (_t, plan) => (plan.includes('server/app.ts') ? 'The plan names server/app.ts, outside where this job may write.' : null)
      },
      () => {},
      spawner
    )
    const done = run(agent, task, null)
    await Promise.resolve()
    procs[0]!.emitLine({ type: 'system', subtype: 'init', session_id: 's1' })
    procs[0]!.emitLine(text('PLAN:\n1. Rewrite server/app.ts\n2. Then the page'))
    const outcome = await done
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('server/app.ts')
    expect(outcome.changedFiles).toBe(false)
  })
})

describe('P4: a plan that names a criterion it cannot meet', () => {
  test('parks the job before the first change', async () => {
    const procs: FakeProc[] = []
    const run = makeAgentRun({ cliPath: 'claude', cwd: 'C:\p', projectName: 'Demo', projectId: 'p1', skipPermissions: false, memoryOf: () => ({ agentMd: 'x', memoryMd: '', rejections: [] }), onNotes: () => {}, planPark: (_t: TaskInfo, plan: string) => (plan.includes('CANNOT MEET: j1') ? 'parked: j1' : null) } as never, () => {}, () => { const p = new FakeProc(); procs.push(p); return p })
    const done = run(agent, task, null)
    await Promise.resolve()
    procs[0]!.emitLine({ type: 'system', subtype: 'init', session_id: 's1' })
    procs[0]!.emitLine(text('PLAN:\n1. Build it\nCANNOT MEET: j1 no throwaway database'))
    expect(await done).toMatchObject({ ok: false, parked: true, resultText: 'parked: j1', changedFiles: false })
  })
  test('the manager gets the raw note and the status feed the plain line', async () => {
    const procs: FakeProc[] = []
    const lines: string[] = []
    const run = makeAgentRun({ cliPath: 'claude', cwd: 'C:\p', projectName: 'Demo', projectId: 'p1', skipPermissions: false, memoryOf: () => ({ agentMd: 'x', memoryMd: '', rejections: [] }), onNotes: () => {}, planPark: () => ({ note: 'j1 needs src/a.ts', owner: 'plain words' }) } as never, (_id: string, l: { kind: string; text: string }) => { if (l.kind === 'status') lines.push(l.text) }, () => { const p = new FakeProc(); procs.push(p); return p })
    const done = run(agent, task, null)
    await Promise.resolve()
    procs[0]!.emitLine({ type: 'system', subtype: 'init', session_id: 's1' })
    procs[0]!.emitLine(text('PLAN:\n1. Build it\nCANNOT MEET: j1 no'))
    expect(await done).toMatchObject({ parked: true, resultText: 'j1 needs src/a.ts' })
    expect(lines).toContain('Parked before it changed anything: plain words')
    expect(lines.join('\n')).not.toContain('src/a.ts')
  })
  const parkRun = (t: TaskInfo, seen: string[], lines: (p: FakeProc) => void): Promise<unknown> => {
    const procs: FakeProc[] = []
    const run = makeAgentRun({ cliPath: 'claude', cwd: 'C:\p', projectName: 'Demo', projectId: 'p1', skipPermissions: false, memoryOf: () => ({ agentMd: 'x', memoryMd: '', rejections: [] }), onNotes: () => {}, planPark: (_t: TaskInfo, text: string) => { seen.push(text); return 'parked' } } as never, () => {}, () => { const p = new FakeProc(); procs.push(p); return p })
    const done = run(agent, t, null)
    return Promise.resolve().then(() => {
      procs[0]!.emitLine({ type: 'system', subtype: 'init', session_id: 's1' })
      lines(procs[0]!)
      procs[0]!.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1' })
      procs[0]!.close(0)
      return done
    })
  }
  test('a later round does not park', async () => {
    const seen: string[] = []
    const out = await parkRun({ ...task, round: 2, sessionId: 's0' }, seen, p => p.emitLine(text('PLAN:\n1. x\nCANNOT MEET: j1 no')))
    expect(seen).toEqual([]); expect(out).not.toMatchObject({ parked: true })
  })
  test('a job already parked once does not park again', async () => {
    const seen: string[] = []
    const out = await parkRun({ ...task, parkedOnce: true }, seen, p => p.emitLine(text('PLAN:\n1. x\nCANNOT MEET: j1 no')))
    expect(seen).toEqual([]); expect(out).not.toMatchObject({ parked: true })
  })
  test('a plan written after an edit does not park', async () => {
    const seen: string[] = []
    const out = await parkRun(task, seen, p => {
      p.emitLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: 'C:\p\src\pages\a.html', content: 'x' } }] } })
      p.emitLine(text('PLAN:\n1. x\nCANNOT MEET: j1 no'))
    })
    expect(seen).toEqual([]); expect(out).not.toMatchObject({ parked: true })
  })
  test('the reader gets the whole message, so a long plan keeps its last line', async () => {
    const seen: string[] = []
    const long = 'PLAN:\n' + '1. a long step that goes on and on\n'.repeat(120) + 'CANNOT MEET: j1 no'
    const out = await parkRun(task, seen, p => p.emitLine(text(long)))
    expect(seen[0]).toContain('CANNOT MEET: j1 no'); expect(out).toMatchObject({ parked: true })
  })
})
