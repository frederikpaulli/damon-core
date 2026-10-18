import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BrokerPicture, ScopedToolBroker } from '../src/main/lib/scoped-tool-broker'

const scope = { projectId: 'personal', callerId: 'worker:alice', sessionId: 'session-1' }
const request = { sessionId: scope.sessionId, turnId: 'turn-1', callId: 'call-1', tool: 'check', arguments: { input: 'hello' } }
const schema = z.object({ input: z.string() }).strict()
describe('scoped capability broker', () => {
  it('binds scope outside model arguments, denies native/foreign routes, validates before executing', async () => {
    const execute = vi.fn(async (_input, context) => ({ project: context.projectId }))
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute }])
    broker.beginTurn('turn-1')
    for (const change of [{ sessionId: 'other' }, { turnId: 'other' }, { tool: 'apply_patch' }, { arguments: { input: 'hello', projectId: 'client' } }]) expect((await broker.dispatch({ ...request, ...change })).success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(await broker.dispatch(request)).toEqual({ success: true, contentItems: [{ type: 'inputText', text: '{"project":"personal"}' }] })
    expect(execute.mock.calls[0][1]).toMatchObject(scope)
  })
  it('deduplicates concurrent/ordered retries and refuses changed content', async () => {
    let release!: () => void
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return 'done' })
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute }])
    broker.beginTurn('turn-1')
    const first = broker.dispatch(request), retry = broker.dispatch(request)
    await Promise.resolve()
    expect((await broker.dispatch({ ...request, arguments: { input: 'changed' } })).success).toBe(false)
    expect((await broker.dispatch({ ...request, callId: 'new-call' })).success).toBe(false)
    expect(() => broker.endTurn('turn-1')).toThrow()
    release()
    expect(await retry).toEqual(await first)
    expect(await broker.dispatch(request)).toEqual(await first)
    expect(execute).toHaveBeenCalledTimes(1)
    broker.endTurn('turn-1'); broker.beginTurn('turn-2')
    expect((await broker.dispatch(request)).success).toBe(false)
  })
  it('aborts in-flight actions and closes admission without claiming cancellation succeeded', async () => {
    const execute = vi.fn(async (_input, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve('late result'))))
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute }])
    broker.beginTurn('turn-1')
    const pending = broker.dispatch(request); await Promise.resolve(); broker.stop()
    expect((await pending).success).toBe(false)
    expect((await broker.dispatch(request)).success).toBe(false)
    expect(() => broker.beginTurn('turn-2')).toThrow()
  })
  it('bounds calls/input/output and does not expose raw exceptions', async () => {
    const execute = vi.fn(async () => { throw Error('PRIVATE_HOST_SECRET') })
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute }], { calls: 1, inputBytes: 300, outputBytes: 10 })
    broker.beginTurn('turn-1')
    expect((await broker.dispatch({ ...request, arguments: { input: 'x'.repeat(400) } })).success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.stringify(await broker.dispatch(request))).not.toContain('PRIVATE_HOST_SECRET')
    expect((await broker.dispatch({ ...request, callId: 'call-2' })).success).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    const oversized = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute: async () => 'x'.repeat(20) }], { calls: 1, inputBytes: 300, outputBytes: 10 })
    oversized.beginTurn('turn-1')
    expect((await oversized.dispatch(request)).success).toBe(false)
  })
  it('hands over a picture as a picture, and refuses one over the output limit', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const accepted = vi.fn()
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute: async () => new BrokerPicture('His portrait, 1 x 1 px.', 'image/png', png), resultAccepted: accepted }], { calls: 10, inputBytes: 1024, outputBytes: 1024 })
    broker.beginTurn('turn-1')
    expect(await broker.dispatch(request)).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'His portrait, 1 x 1 px.' }, { type: 'inputImage', imageUrl: `data:image/png;base64,${png.toString('base64')}` }] })
    expect(accepted).toHaveBeenCalledTimes(1)
    const big = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute: async () => new BrokerPicture('x', 'image/jpeg', Buffer.alloc(2048)) }], { calls: 10, inputBytes: 1024, outputBytes: 1024 })
    big.beginTurn('turn-1')
    const refused = await big.dispatch(request)
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused)).toContain('The picture is too large to hand over.')
  })
})

import { BrokerRefusal } from '../src/main/lib/scoped-tool-broker'
describe('refusals the tool marks as safe', () => {
  it('pass through in their own words, while a plain error stays masked', async () => {
    const tools = [
      { name: 'refuse', description: 'Refuse', schema: z.object({}).strict(), execute: async () => { throw new BrokerRefusal('Nothing was assigned: that person already has this job.') } },
      { name: 'crash', description: 'Crash', schema: z.object({}).strict(), execute: async () => { throw Error('ENOENT: C:\\secret\\token.json') } }
    ]
    const broker = new ScopedToolBroker(scope, tools)
    broker.beginTurn('turn-1')
    const refused = await broker.dispatch({ sessionId: scope.sessionId, turnId: 'turn-1', callId: 'r1', tool: 'refuse', arguments: {} })
    expect(refused.success).toBe(false)
    expect(refused.contentItems[0]!.text).toMatch(/already has this job/)
    const crashed = await broker.dispatch({ sessionId: scope.sessionId, turnId: 'turn-1', callId: 'c1', tool: 'crash', arguments: {} })
    expect(crashed.success).toBe(false)
    expect(crashed.contentItems[0]!.text).not.toMatch(/token\.json/)
    expect(crashed.contentItems[0]!.text).toMatch(/operation record/)
  })
  it('reports every refusal it decides before a tool runs, and the reason', async () => {
    const execute = vi.fn(async () => 'ok')
    const refused: string[] = []
    const broker = new ScopedToolBroker(scope, [{ name: 'check', description: 'Check', schema, execute }], { calls: 1, inputBytes: 256 * 1024, outputBytes: 1024 * 1024 }, reason => refused.push(reason))
    broker.beginTurn('turn-1')
    expect((await broker.dispatch({ ...request, tool: 'apply_patch' })).success).toBe(false)
    expect(refused.at(-1)).toMatch(/not available/)
    expect((await broker.dispatch({ ...request, arguments: { nope: 1 } })).success).toBe(false)
    expect(refused.at(-1)).toMatch(/Invalid (broker request|arguments for check)/)
    expect((await broker.dispatch(request)).success).toBe(true)
    expect((await broker.dispatch({ ...request, callId: 'call-2' })).success).toBe(false)
    expect(refused.at(-1)).toMatch(/budget is exhausted/)
    broker.stop()
    expect((await broker.dispatch({ ...request, callId: 'call-3' })).success).toBe(false)
    expect(refused.at(-1)).toMatch(/session is closed/)
    expect(refused).toHaveLength(4)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
