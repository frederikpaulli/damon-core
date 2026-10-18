import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ScopedToolBroker } from '../src/main/lib/scoped-tool-broker'
import { CodexBrokerChannel } from '../src/main/lib/providers/codex-broker-channel'

async function fixture() {
  const sent: any[] = [], events: any[] = [], terminate = vi.fn()
  const execute = vi.fn(async () => ({ marker: 'allowed-project-only' }))
  const broker = new ScopedToolBroker({ projectId: 'personal', callerId: 'worker', sessionId: 'session' }, [{ name: 'check', description: 'Check', schema: z.object({}).strict(), execute }])
  const channel = new CodexBrokerChannel({ sessionId: 'session', scratchPath: 'C:\\fixture', broker, send: msg => sent.push(msg), terminate, onEvent: event => events.push(event) })
  const start = channel.start('gpt-5.4', 'Synthetic instructions')
  channel.receive({ id: sent.at(-1).id, result: { userAgent: 'damon_broker/0.153.4 (Windows)' } }); await Promise.resolve()
  channel.receive({ id: sent.at(-1).id, result: { thread: { id: 'thread' } } }); await start
  return { channel, sent, events, terminate, execute }
}
const tool = { id: 'server-1', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'check', arguments: {} } }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
describe('Codex broker-only protocol', () => {
  it('counts all model responses in a turn once and subtracts prior warm-turn usage', async () => {
    const f = await fixture()
    const usage = (turnId: string, total: number) => ({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId, tokenUsage: { total: { totalTokens: total, inputTokens: total / 2, outputTokens: total / 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }, last: { totalTokens: 20 } } } })
    for (const [turnId, totals] of [['turn', [20, 40, 40, 60]], ['second', [80, 100]]] as const) {
      const turn = f.channel.turn('Check')
      f.channel.receive({ id: f.sent.at(-1).id, result: { turn: { id: turnId } } }); await tick()
      for (const total of totals) f.channel.receive(usage(turnId, total))
      f.channel.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } })
      await turn
    }
    const results = f.events.filter(e => e.kind === 'result')
    expect(results.map(e => e.tokens)).toEqual([60, 40])
    expect(results[1].tokenUsage).toMatchObject({ input_tokens: 20, output_tokens: 20 })
    f.channel.stop()
  })
  it('sets empty environments for thread and every turn, routes only the scoped capability and maps completion', async () => {
    const f = await fixture()
    expect(f.sent.find(m => m.method === 'thread/start').params).toMatchObject({ environments: [], approvalPolicy: 'never', ephemeral: true, allowProviderModelFallback: false })
    const turn = f.channel.turn('Do the check')
    expect(f.sent.at(-1).params.environments).toEqual([])
    const turnRequestId = f.sent.at(-1).id
    f.channel.receive(tool)
    expect(f.execute).not.toHaveBeenCalled()
    f.channel.receive({ id: turnRequestId, result: { turn: { id: 'turn' } } }); await tick()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.sent.at(-1)).toMatchObject({ id: 'server-1', result: { success: true } })
    f.channel.receive({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', text: 'Done' } } })
    f.channel.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', error: null } } })
    await turn
    expect(f.events).toContainEqual({ kind: 'assistant_text', text: 'Done' })
    expect(f.events.filter(e => e.kind === 'result')).toHaveLength(1)
    const second = f.channel.turn('Again')
    expect(f.sent.at(-1).params.environments).toEqual([])
    f.channel.stop(); await expect(second).rejects.toThrow('stopped')
  })
  it('refuses foreign calls, native permission requests and duplicate changed arguments', async () => {
    const f = await fixture(), turn = f.channel.turn('Check')
    f.channel.receive({ id: f.sent.at(-1).id, result: { turn: { id: 'turn' } } }); await tick()
    f.channel.receive({ ...tool, params: { ...tool.params, threadId: 'other-project' } })
    expect(f.sent.at(-1).result.success).toBe(false)
    f.channel.receive({ id: 'native', method: 'item/commandExecution/requestApproval', params: { command: 'touch host' } })
    expect(f.sent.at(-1).error.code).toBe(-32601)
    f.channel.receive(tool); await tick()
    f.channel.receive({ ...tool, id: 'retry' }); await tick()
    expect(f.execute).toHaveBeenCalledTimes(1)
    f.channel.receive({ ...tool, id: 'changed', params: { ...tool.params, arguments: { change: true } } }); await tick()
    expect(f.sent.at(-1).result.success).toBe(false)
    f.channel.stop(); await expect(turn).rejects.toThrow()
  })
  it('closes on native host activity or foreign completion and emits one failure', async () => {
    for (const message of [
      { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution' } } },
      { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn', status: 'completed' } } }
    ]) {
      const f = await fixture(), turn = f.channel.turn('Check')
      f.channel.receive({ id: f.sent.at(-1).id, result: { turn: { id: 'turn' } } }); await tick()
      f.channel.receive(message); await expect(turn).rejects.toThrow()
      expect(f.terminate).toHaveBeenCalledTimes(1)
      expect(f.events.filter(e => e.kind === 'result')).toEqual([expect.objectContaining({ ok: false })])
    }
  })
  it('refuses an unvalidated native version before creating a thread', async () => {
    const sent: any[] = [], terminate = vi.fn()
    const channel = new CodexBrokerChannel({ sessionId: 'session', scratchPath: 'C:\\fixture', broker: new ScopedToolBroker({ sessionId: 'session', projectId: 'personal', callerId: 'worker' }, []), send: msg => sent.push(msg), terminate, onEvent: () => {} })
    const start = channel.start('gpt-5.4', 'Instructions')
    channel.receive({ id: sent[0].id, result: { userAgent: 'damon_broker/99.0.0 (Windows)' } })
    await expect(start).rejects.toThrow('revalidation')
    expect(sent).toHaveLength(1); expect(terminate).toHaveBeenCalledTimes(1)
  })
})
