import { z } from 'zod'
import type { ManagerEvent } from '../../../shared/types'
import { ScopedToolBroker } from '../scoped-tool-broker'

export const CODEX_BROKER_VERSION = '0.153.4'
export const CODEX_BROKER_CONFIG = Object.freeze({
  'features.shell_tool': false, 'features.view_image': false,
  'features.code_mode': false, 'features.multi_agent': false,
  'features.multi_agent_v2': false, 'features.js_repl': false,
  'features.apps': false, 'features.hooks': false,
  'orchestrator.skills.enabled': false, 'orchestrator.mcp.enabled': false,
  'features.skip_host_skill_discovery': true, web_search: 'disabled'
})

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/)
const dynamicCall = z.object({ arguments: z.unknown(), callId: id, threadId: id, turnId: id, tool: z.string(), namespace: z.string().nullish() }).strict()
type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown }
interface Pending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Active { id: string | null; queued: Message[]; resolve(): void; reject(error: Error): void; tokens: number; tokenUsage?: Record<string, number>; baseline: Record<string, number> }
const usageKeys = { totalTokens: 'total_tokens', inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', cacheWriteInputTokens: 'cache_write_input_tokens', outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens' } as const

export class CodexBrokerChannel {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private threadId: string | null = null
  private active: Active | null = null
  private closed = false
  private started = false
  private threadUsage: Record<string, number> = {}
  constructor(private readonly options: {
    sessionId: string; scratchPath: string; broker: ScopedToolBroker
    approvedVersions?: readonly string[]
    send(message: unknown): void; terminate(): void; onEvent(event: ManagerEvent): void
  }) {}
  private approved(): string[] { return this.options.approvedVersions?.length ? [...this.options.approvedVersions] : [CODEX_BROKER_VERSION] }

  async start(model: string, instructions: string): Promise<void> {
    if (this.started || this.closed) throw Error('This provider channel cannot start again.')
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model) || Buffer.byteLength(instructions) > 1024 * 1024) throw Error('Invalid provider configuration.')
    this.started = true
    try {
      const initialized = await this.rpc('initialize', { clientInfo: { name: 'damon_broker', version: '1' }, capabilities: { experimentalApi: true } })
      if (typeof initialized?.userAgent !== 'string' || !this.approved().some(version => initialized.userAgent.startsWith(`damon_broker/${version} `))) throw Error('The native provider version needs boundary revalidation.')
      this.options.send({ method: 'initialized', params: {} })
      const started = await this.rpc('thread/start', {
        cwd: this.options.scratchPath, model, approvalPolicy: 'never', sandbox: 'read-only',
        ephemeral: true, environments: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
        dynamicTools: this.options.broker.definitions(), baseInstructions: instructions,
        allowProviderModelFallback: false
      })
      this.threadId = id.parse(started?.thread?.id)
      this.options.onEvent({ kind: 'session', sessionId: this.options.sessionId })
    } catch (error) { this.stop(); throw error }
  }

  async turn(text: string, effort?: 'low' | 'medium' | 'high'): Promise<void> {
    if (!this.threadId || this.active || this.closed || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) throw Error('The provider cannot admit this turn.')
    const completion = new Promise<void>((resolve, reject) => { this.active = { id: null, queued: [], resolve, reject, tokens: 0, baseline: { ...this.threadUsage } } })
    void completion.catch(() => {})
    try {
      const started = await this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }], environments: [], approvalPolicy: 'never', ...(effort ? { effort } : {}) })
      const active = this.active as Active | null
      if (!active || this.closed) throw Error('The provider stopped while starting its turn.')
      active.id = id.parse(started?.turn?.id)
      this.options.broker.beginTurn(active.id)
      const queued = active.queued; active.queued = []
      for (const message of queued) this.receive(message)
      await completion
    } catch (error) { this.stop(); throw error }
  }

  receive(value: unknown): void {
    if (this.closed) return
    try {
      const raw = JSON.stringify(value)
      if (!raw || Buffer.byteLength(raw) > 1024 * 1024) throw Error('Protocol frame exceeds its limit.')
      const msg = JSON.parse(raw) as Message
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw Error('Invalid provider message.')
      if (typeof msg.id === 'number' && !msg.method) {
        const pending = this.pending.get(msg.id)
        if (!pending) throw Error('Unrecognised provider response.')
        this.pending.delete(msg.id); clearTimeout(pending.timer)
        if (msg.error !== undefined) pending.reject(Error('The native provider refused the broker request.'))
        else if (msg.result !== undefined) pending.resolve(msg.result)
        else pending.reject(Error('The native provider returned an invalid response.'))
        return
      }
      if (typeof msg.method !== 'string') throw Error('Invalid provider protocol method.')
      if (msg.id !== undefined) {
        if (typeof msg.id !== 'string' && typeof msg.id !== 'number') throw Error('Invalid request identity.')
        if (msg.method !== 'item/tool/call') {
          this.options.send({ id: msg.id, error: { code: -32601, message: 'Native host actions and permission requests are unavailable.' } })
          return
        }
        if (this.active && this.active.id === null) { this.queue(msg); return }
        const call = dynamicCall.safeParse(msg.params)
        if (!call.success || call.data.namespace != null || call.data.threadId !== this.threadId || call.data.turnId !== this.active?.id) {
          this.options.send({ id: msg.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'The tool call is outside this channel scope.' }] } })
          return
        }
        void this.options.broker.dispatch({ sessionId: this.options.sessionId, turnId: call.data.turnId, callId: call.data.callId, tool: call.data.tool, arguments: call.data.arguments }).then(result => {
          if (!this.closed) { try { this.options.send({ id: msg.id, result }) } catch { this.stop() } }
        })
        return
      }
      if (!['item/completed', 'turn/completed', 'thread/tokenUsage/updated'].includes(msg.method)) return
      if (msg.params?.threadId !== this.threadId) throw Error('Provider event belongs to another thread.')
      if (this.active?.id === null) { this.queue(msg); return }
      const active = this.active
      if (!active || (msg.method !== 'turn/completed' && msg.params?.turnId !== active.id)) throw Error('Provider event belongs to another turn.')
      if (msg.method === 'item/completed') {
        const item = msg.params?.item
        if (item?.type === 'agentMessage' && typeof item.text === 'string') this.options.onEvent({ kind: 'assistant_text', text: item.text })
        else if (['commandExecution', 'fileChange'].includes(item?.type)) throw Error('Native host activity was reported on a broker-only channel.')
      } else if (msg.method === 'thread/tokenUsage/updated') {
        const usage = msg.params?.tokenUsage?.total, delta: Record<string, number> = {}
        for (const [nativeKey, key] of Object.entries(usageKeys)) {
          const count = usage?.[nativeKey]
          if (!Number.isSafeInteger(count) || count < (this.threadUsage[key] ?? 0)) throw Error('Provider usage could not be reconciled.')
          delta[key] = count - (active.baseline[key] ?? 0)
        }
        this.threadUsage = Object.fromEntries(Object.entries(usageKeys).map(([nativeKey, key]) => [key, usage[nativeKey]]))
        active.tokens = delta.total_tokens; active.tokenUsage = delta
      } else {
        const turn = msg.params?.turn
        if (turn?.id !== active.id) throw Error('Provider completion has a mismatched turn.')
        this.options.broker.endTurn(active.id!)
        this.active = null
        const ok = turn.status === 'completed' && !turn.error
        this.options.onEvent({ kind: 'result', ok, costUsd: 0, tokens: active.tokens, tokenUsage: active.tokenUsage, ...(ok ? {} : { error: 'The native provider turn did not complete successfully.' }) })
        active.resolve()
      }
    } catch { this.stop() }
  }

  stop(): void {
    if (this.closed) return
    this.closed = true; this.options.broker.stop()
    const error = Error('The broker provider channel stopped. No host fallback was used.')
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    const active = this.active; this.active = null
    if (active) {
      this.options.onEvent({ kind: 'result', ok: false, error: error.message, costUsd: 0, tokens: active.tokens, tokenUsage: active.tokenUsage })
      active.reject(error)
    }
    this.options.terminate()
  }
  private queue(msg: Message): void {
    const active = this.active!
    if (active.queued.length >= 32 || Buffer.byteLength(JSON.stringify([...active.queued, msg])) > 1024 * 1024) throw Error('Provider startup event budget exceeded.')
    active.queued.push(msg)
  }
  private rpc(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(Error('The provider channel is closed.'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop() }, 30000)
      this.pending.set(requestId, { resolve, reject, timer })
      try { this.options.send({ id: requestId, method, params }) } catch { this.stop() }
    })
  }
}
