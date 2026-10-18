import { describe, expect, test } from 'vitest'
import type { ManagerEvent } from '../src/shared/types'
import { ManagerSession, type SpawnedProcess, type Spawner } from '../src/main/lib/manager-session'

class FakeProc implements SpawnedProcess {
  private stdoutCb: ((d: Buffer) => void) | null = null
  private closeCb: ((code: number | null) => void) | null = null
  stdin = { write: (): void => {}, end: (): void => {} }
  stdout = {
    on: (_ev: 'data', cb: (d: Buffer) => void): void => {
      this.stdoutCb = cb
    }
  }
  stderr = { on: (_ev: 'data', _cb: (d: Buffer) => void): void => {} }
  on(_ev: 'close', cb: (code: number | null) => void): void {
    this.closeCb = cb
  }
  kill(): void {}
  finish(ok: boolean): void {
    this.stdoutCb?.(
      Buffer.from(
        JSON.stringify({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', result: 'x' }) + '\n'
      )
    )
    this.closeCb?.(0)
  }
}

function harness(ok: boolean[]): { session: ManagerSession; models: string[] } {
  const models: string[] = []
  let n = 0
  const events: ManagerEvent[] = []
  const spawner: Spawner = (_cmd, args) => {
    models.push(args[args.indexOf('--model') + 1]!)
    const proc = new FakeProc()
    const succeed = ok[n] ?? true
    n += 1
    setTimeout(() => proc.finish(succeed), 0)
    return proc
  }
  const session = new ManagerSession(
    {
      cliPath: 'claude',
      cwd: 'C:\\proj',
      projectName: 'Demo',
      model: 'claude-opus-5',
      fallbackModel: 'claude-haiku-4-5-20251001',
      skipPermissions: false
    },
    (e) => events.push(e),
    spawner
  )
  return { session, models }
}

describe('which brain runs which turn', () => {
  test('the owner typing gets the brain they chose', async () => {
    const h = harness([true])
    await h.session.send('build me a shop', 'owner')
    expect(h.models).toEqual(['claude-opus-5'])
  })

  test('Damon waking the manager itself runs a rung cheaper', async () => {
    const h = harness([true])
    await h.session.send('[Agent report] someone finished', 'routine')
    expect(h.models).toEqual(['claude-sonnet-5-5'])
  })

  test('the default is the owner, so a caller that says nothing never downgrades them', async () => {
    const h = harness([true])
    await h.session.send('hello')
    expect(h.models).toEqual(['claude-opus-5'])
  })

  test('a cheap turn does not stick: the next owner turn is expensive again', async () => {
    const h = harness([true, true])
    await h.session.send('[Agent report] someone finished', 'routine')
    await h.session.send('what is happening?', 'owner')
    expect(h.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5'])
  })
})

describe('the trap: a failed routine turn must not downgrade the owner', () => {
  test('the manager keeps the brain the owner chose after a routine turn falls back', async () => {
    const h = harness([false, true])
    await h.session.send('[Agent report] someone finished', 'routine')
    expect(h.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
    expect(h.session.getState().model).toBe('claude-opus-5')
  })

  test('an owner turn falling back still moves the manager, as it always did', async () => {
    const h = harness([false, true])
    await h.session.send('build me a shop', 'owner')
    expect(h.session.getState().model).toBe('claude-haiku-4-5-20251001')
  })
})
