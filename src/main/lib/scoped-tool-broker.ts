// The scoped tool broker. Every tool call carries a project, caller and session; a call
// outside that scope is refused before the tool runs.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { schemaWords } from '../../shared/schema-words'
import { answerBudgetMs } from '../../shared/broker-call-limits'

export interface BrokerScope { projectId: string; callerId: string; sessionId: string }
export interface BrokerCall { sessionId: string; turnId: string; callId: string; tool: string; arguments: unknown }
export type BrokerContent = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
export interface BrokerResult { success: boolean; contentItems: BrokerContent[] }
export interface BrokerTool {
  name: string
  description: string
  schema: z.ZodType
  execute(input: unknown, context: Readonly<BrokerScope> & { signal: AbortSignal; callId: string; turnId: string }): Promise<unknown>
  resultAccepted?(input: unknown, output: unknown): void
  answerWithinMs?(input: unknown): number
}

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/)
const callSchema = z.object({ sessionId: identity, turnId: identity, callId: identity, tool: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), arguments: z.unknown() }).strict()
const denied = (text: string): BrokerResult => ({ success: false, contentItems: [{ type: 'inputText', text }] })

export class BrokerRefusal extends Error {}
export class BrokerPicture {
  constructor(readonly caption: string, readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', readonly data: Buffer) {}
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
}

export class ScopedToolBroker {
  private readonly scope: Readonly<BrokerScope>
  private readonly tools = new Map<string, BrokerTool>()
  private readonly calls = new Map<string, { fingerprint: string; result: Promise<BrokerResult> }>()
  private readonly abort = new AbortController()
  private turn: string | null = null
  private running = false
  private closed = false
  private totalCalls = 0
  private readonly limits: Readonly<{ calls: number; inputBytes: number; outputBytes: number }>
  private readonly reserved: ReadonlySet<string>
  private readonly reservedUsed = new Set<string>()
  private readonly onDenied?: (reason: string) => void
  constructor(scope: BrokerScope, tools: BrokerTool[], limits = { calls: 100, inputBytes: 256 * 1024, outputBytes: 1024 * 1024 }, onDenied?: (reason: string) => void, reserved: string[] = []) {
    this.onDenied = onDenied
    this.reserved = new Set(reserved)
    this.scope = Object.freeze(z.object({ projectId: identity, callerId: identity, sessionId: identity }).strict().parse(scope))
    if (!Object.values(limits).every(Number.isSafeInteger) || limits.calls < 1 || limits.calls > 1000 || limits.inputBytes < 1 || limits.inputBytes > 1024 * 1024 || limits.outputBytes < 1 || limits.outputBytes > 8 * 1024 * 1024) throw Error('Invalid broker limits.')
    this.limits = Object.freeze({ ...limits })
    for (const tool of tools) {
      callSchema.shape.tool.parse(tool.name)
      if (this.tools.has(tool.name)) throw Error('Duplicate broker tool.')
      this.tools.set(tool.name, Object.freeze({ ...tool }))
    }
  }
  definitions(): Array<{ type: 'function'; name: string; description: string; inputSchema: unknown }> {
    return Array.from(this.tools.values(), tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema) }))
  }
  beginTurn(turnId: string): void {
    identity.parse(turnId)
    if (this.closed || this.turn !== null || this.running) throw Error('The broker cannot begin this turn.')
    this.turn = turnId
  }
  endTurn(turnId: string): void {
    if (this.turn !== turnId || this.running) throw Error('The broker turn has not finished safely.')
    this.turn = null
  }
  stop(): void { this.closed = true; this.abort.abort(); this.turn = null }
  async whenIdle(): Promise<void> {
    await Promise.all([...this.calls.values()].map(call => call.result))
  }
  private refuse(text: string): BrokerResult {
    try { this.onDenied?.(text) } catch {}
    return denied(text)
  }
  answerWithinMs(tool: string, args: unknown): number {
    const found = this.tools.get(tool)
    if (!found?.answerWithinMs) return answerBudgetMs(undefined)
    try {
      const parsed = found.schema.safeParse(args)
      return answerBudgetMs(parsed.success ? found.answerWithinMs(parsed.data) : undefined)
    } catch { return answerBudgetMs(undefined) }
  }
  late(tool: string, ms: number): BrokerResult {
    return this.refuse(`${tool.slice(0, 80)} did not finish within ${Math.round(ms / 1000)} s, its time on this seat, so Damon answered without it. It may still be running, and other tools are refused until it ends. Do not call it again at once: carry on with what you have, and say plainly what it would have shown.`)
  }
  async dispatch(value: unknown): Promise<BrokerResult> {
    if (this.closed) return this.refuse('This broker session is closed.')
    let call: BrokerCall, input: unknown, fingerprint: string, key: string
    try {
      const bytes = JSON.stringify(value)
      if (!bytes || Buffer.byteLength(bytes) > this.limits.inputBytes) return this.refuse('Broker input exceeds its limit.')
      call = callSchema.parse(JSON.parse(bytes))
      if (call.sessionId !== this.scope.sessionId || call.turnId !== this.turn) return this.refuse('The tool call does not belong to the active session and turn.')
      const tool = this.tools.get(call.tool)
      if (!tool) return this.refuse('This capability is not available to this caller.')
      try { input = tool.schema.parse(call.arguments) }
      catch (e) { return this.refuse(`Invalid arguments for ${call.tool}: ${schemaWords(e).slice(0, 1500)}. No action was admitted.`) }
      fingerprint = createHash('sha256').update(canonical({ tool: call.tool, arguments: call.arguments })).digest('hex')
      key = JSON.stringify([call.turnId, call.callId])
    } catch { return this.refuse('Invalid broker request. No action was admitted.') }
    const previous = this.calls.get(key)
    if (previous) return previous.fingerprint === fingerprint ? previous.result : denied('A tool call identity was reused with different content.')
    if (this.running) return this.refuse('Another broker operation is still running. Retry after it finishes.')
    if (this.totalCalls >= this.limits.calls && !(this.reserved.has(call.tool) && !this.reservedUsed.has(call.tool))) {
      const left = [...this.reserved].filter(t => !this.reservedUsed.has(t) && this.tools.has(t))
      return this.refuse(`The broker session call budget is exhausted (${this.limits.calls} calls).${left.length ? ' ' + left.join(', ') + ' can still be called once: record what you have.' : ''}`)
    }
    if (this.reserved.has(call.tool)) this.reservedUsed.add(call.tool)
    this.running = true; this.totalCalls++
    const result = Promise.resolve().then(async (): Promise<BrokerResult> => {
      try {
        if (this.closed) return this.refuse('This broker session is closed.')
        const output = await this.tools.get(call.tool)!.execute(input, { ...this.scope, signal: this.abort.signal, callId: call.callId, turnId: call.turnId })
        if (this.closed) return this.refuse('The session stopped. Consult the operation journal before retrying.')
        if (output instanceof BrokerPicture) {
          const imageUrl = `data:${output.mimeType};base64,${output.data.toString('base64')}`
          if (Buffer.byteLength(imageUrl) + Buffer.byteLength(output.caption) > this.limits.outputBytes) return this.refuse('The picture is too large to hand over. Consult the operation journal before retrying.')
          this.tools.get(call.tool)!.resultAccepted?.(input, output)
          return { success: true, contentItems: [{ type: 'inputText', text: output.caption }, { type: 'inputImage', imageUrl }] }
        }
        const text = JSON.stringify(output)
        if (typeof text !== 'string' || Buffer.byteLength(text) > this.limits.outputBytes) return this.refuse('Tool output unavailable or too large. Consult the operation journal before retrying.')
        this.tools.get(call.tool)!.resultAccepted?.(input, output)
        return { success: true, contentItems: [{ type: 'inputText', text }] }
      } catch (e) {
        if (e instanceof BrokerRefusal) return this.refuse(e.message.slice(0, 8000))
        return this.refuse('The tool did not complete successfully. Consult its operation record before retrying.')
      } finally { this.running = false }
    })
    this.calls.set(key, { fingerprint, result })
    return result
  }
}
