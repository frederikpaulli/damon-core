import { describe, expect, test } from 'vitest'
import type { ManagerEvent } from '../src/shared/types'
import { ManagerSession, MAX_WARM_TURNS, type SpawnedProcess, type Spawner } from '../src/main/lib/manager-session'

class FakeProc implements SpawnedProcess {
  written: string[] = []
  ended = false
  killed = false
  private stdoutCb: ((d: Buffer) => void) | null = null
  private closeCb: ((code: number | null) => void) | null = null
  stdin = {
    write: (d: string): void => {
      this.written.push(d)
    },
    end: (): void => {
      this.ended = true
    }
  }
  stdout = {
    on: (_ev: 'data', cb: (d: Buffer) => void): void => {
      this.stdoutCb = cb
    }
  }
  stderr = { on: (_ev: 'data', _cb: (d: Buffer) => void): void => {} }
  on(_ev: 'close', cb: (code: number | null) => void): void {
    this.closeCb = cb
  }
  kill(): void {
    this.killed = true
  }
  emitLine(obj: unknown): void {
    this.stdoutCb?.(Buffer.from(JSON.stringify(obj) + '\n'))
  }
  close(code: number | null): void {
    this.closeCb?.(code)
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function harness(warmMs = 60_000): { session: ManagerSession; procs: FakeProc[]; args: string[][]; events: ManagerEvent[] } {
  const procs: FakeProc[] = []
  const args: string[][] = []
  const events: ManagerEvent[] = []
  const spawner: Spawner = (_cmd, a) => {
    const p = new FakeProc()
    procs.push(p)
    args.push(a)
    return p
  }
  const session = new ManagerSession(
    {
      cliPath: 'claude',
      cwd: 'C:\\proj',
      projectName: 'Demo',
      model: 'claude-fable-5',
      fallbackModel: 'claude-opus-4-8',
      skipPermissions: true,
      warmMs
    },
    (e) => events.push(e),
    spawner
  )
  return { session, procs, args, events }
}

const answer = (proc: FakeProc, text: string, cost: number, tokens: number, steps: number, sessionId = 's-1'): void => {
  proc.emitLine({ type: 'system', subtype: 'init', session_id: sessionId })
  proc.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  proc.emitLine({ type: 'result', subtype: 'success', result: text, total_cost_usd: cost, num_turns: steps, usage: { input_tokens: tokens } })
}

describe('a warm manager process', () => {
  test('serves the next owner turn without a new process, and each turn is charged its own share', async () => {
    const h = harness()
    const first = h.session.send('Hello')
    await tick()
    expect(h.procs).toHaveLength(1)
    answer(h.procs[0]!, 'Hi.', 0.5, 1000, 3)
    const o1 = await first
    expect(o1.ok).toBe(true)
    expect(o1.costUsd).toBe(0.5)
    expect(h.procs[0]!.ended).toBe(false)

    const second = h.session.send('And again')
    await tick()
    expect(h.procs).toHaveLength(1)
    expect(h.procs[0]!.written).toHaveLength(2)
    expect(h.procs[0]!.written[1]).toContain('And again')
    answer(h.procs[0]!, 'Sure.', 0.8, 1600, 5)
    const o2 = await second
    expect(o2.ok).toBe(true)
    expect(o2.costUsd).toBeCloseTo(0.3, 6)
    expect(o2.tokens).toBe(1600)
    expect(h.procs[0]!.ended).toBe(false)
  })

  test('a routine turn runs on its own brain in a fresh process, and lets the warm one go', async () => {
    const h = harness()
    const first = h.session.send('Hello')
    await tick()
    answer(h.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await first
    const routine = h.session.send('An agent reported', 'routine')
    await tick()
    expect(h.procs).toHaveLength(2)
    expect(h.procs[0]!.ended).toBe(true)
    answer(h.procs[1]!, 'Read it.', 0.1, 100, 2)
    await routine
    expect(h.procs[1]!.ended).toBe(true)
  })

  test('the owner adding to a turn between turns is refused, so it goes to the queue instead', async () => {
    const h = harness()
    const first = h.session.send('Hello')
    await tick()
    expect(h.session.deliver('more')).toBe(true)
    answer(h.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await first
    expect(h.session.deliver('later')).toBe(false)
  })

  test('the clock running out, the process dying, or a changed access flag each end it', async () => {
    const expired = harness(1)
    const a = expired.session.send('Hello')
    await tick()
    answer(expired.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await a
    await new Promise((r) => setTimeout(r, 15))
    const b = expired.session.send('Again')
    await tick()
    expect(expired.procs).toHaveLength(2)
    answer(expired.procs[1]!, 'Hi.', 0.5, 1000, 3)
    await b

    const died = harness()
    const c = died.session.send('Hello')
    await tick()
    answer(died.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await c
    died.procs[0]!.close(0)
    const d = died.session.send('Again')
    await tick()
    expect(died.procs).toHaveLength(2)
    answer(died.procs[1]!, 'Hi.', 0.5, 1000, 3)
    await d

    const flag = harness()
    const e = flag.session.send('Hello')
    await tick()
    answer(flag.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await e
    flag.session.setSkipPermissions(false)
    expect(flag.procs[0]!.ended).toBe(true)
    const f = flag.session.send('Again')
    await tick()
    expect(flag.procs).toHaveLength(2)
    expect(flag.args[1]!.includes('--dangerously-skip-permissions')).toBe(false)
    answer(flag.procs[1]!, 'Hi.', 0.5, 1000, 3)
    await f
  })

  test('the owner stopping kills the idle process too, and without warmMs nothing is kept', async () => {
    const h = harness()
    const a = h.session.send('Hello')
    await tick()
    answer(h.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await a
    h.session.cancel()
    expect(h.procs[0]!.killed).toBe(true)

    const cold = harness(0)
    const b = cold.session.send('Hello')
    await tick()
    answer(cold.procs[0]!, 'Hi.', 0.5, 1000, 3)
    await b
    expect(cold.procs[0]!.ended).toBe(true)
  })

  test('a process is let go after its share of turns', async () => {
    const h = harness()
    for (let i = 0; i < MAX_WARM_TURNS; i++) {
      const p = h.session.send(`turn ${i}`)
      await tick()
      answer(h.procs[0]!, 'ok', 0.1 * (i + 1), 100 * (i + 1), i + 1)
      await p
    }
    expect(h.procs).toHaveLength(1)
    const next = h.session.send('one more')
    await tick()
    expect(h.procs).toHaveLength(2)
    expect(h.procs[0]!.ended).toBe(true)
    answer(h.procs[1]!, 'ok', 0.1, 100, 1)
    await next
  })
})
