// Runs the manager as a CLI session (spawned process), streams its output, and restricts
// the tools and shell commands it may use.
import { createHash } from 'node:crypto'
import { splitSnapshot, type SnapshotBase, type SnapshotCause } from './snapshot-base'
import { requireReviewedText } from './protected-context'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { constants, cpus, setPriority } from 'node:os'
import { buildThreadLimits } from './machine-load'
import type { ManagerEvent } from '../../shared/types'
import { MANAGER_PROMPT_VERSION, managerSystemPrompt } from './manager-prompt'
import { isLimitError, isLimitNotice, NdjsonParser, parseResetsAt, toManagerEvents } from './stream-parser'
import { MAX_MANAGER_TURNS } from '../../shared/turns'
import { routineBrain, providerForModel } from '../../shared/models'
import { contextSizeOf, HEAVY_CONTEXT } from '../../shared/manager-memory'
import { processes } from './process-registry'
import { assertHostExecutionAllowed } from './execution-boundary'
import type { NativeBrokerTurn } from './providers/native-broker-run'
import {
  giveUpReason,
  patienceFor,
  noticeDueAt,
  shouldGiveUp,
  SILENCE_CHECK_MS,
  SILENCE_LIMIT_MS,
  sleptThrough,
  waitingNotice
} from '../../shared/turn-patience'

export interface SpawnedProcess {
  stdin: { write(d: string): void; end(): void }
  stdout: { on(ev: 'data', cb: (d: Buffer) => void): void }
  stderr: { on(ev: 'data', cb: (d: Buffer) => void): void }
  on(ev: 'close', cb: (code: number | null) => void): void
  onError?(cb: (err: Error) => void): void
  onExit?(cb: (code: number | null) => void): void
  kill(): void
}

export interface SpawnOwner {
  projectId?: string
  agentId?: string
}

export type Spawner = (
  command: string,
  args: string[],
  opts: { cwd: string; owner?: SpawnOwner }
) => SpawnedProcess

function buildLimits(): Record<string, string> {
  return buildThreadLimits(cpus().length)
}

export const nodeSpawner: Spawner = (command, args, opts) => {
  assertHostExecutionAllowed('Legacy agent or development-server execution')
  assertShellSafe(command, args)
  const child = spawn(command, args, {
    cwd: opts.cwd,
    shell: true,
    windowsHide: true,
    env: { ...process.env, ...buildLimits() }
  })
  const pid = child.pid
  if (typeof pid === 'number') {
    try {
      setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
    }
    try {
      processes.add({
        pid,
        match: [command, ...args].join(' '),
        projectId: opts.owner?.projectId,
        agentId: opts.owner?.agentId,
        startedAt: new Date().toISOString()
      })
    } catch (error) { processes.killTreeSoon(pid); throw error }
    child.on('close', () => processes.forget(pid))
  }
  child.stdin.on('error', () => {
  })
  const wrapped = child as unknown as SpawnedProcess
  return {
    stdin: wrapped.stdin,
    stdout: wrapped.stdout,
    stderr: wrapped.stderr,
    on: (ev, cb) => wrapped.on(ev, cb),
    onError: (cb) => {
      child.on('error', (err) => {
        if (typeof pid === 'number') processes.forget(pid)
        cb(err)
      })
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code))
    },
    kill: () => {
      if (typeof pid === 'number') processes.killTreeSoon(pid)
      else wrapped.kill()
    }
  }
}

export function quoteCli(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

export function assertShellSafe(command: string, args: string[]): void {
  for (const arg of [command, ...args]) {
    if (!/\s/.test(arg)) continue
    if (arg.startsWith('"') && arg.endsWith('"') && arg.length > 1) continue
    throw new Error(
      `Refusing to start: the argument ${JSON.stringify(arg)} contains a space and is not quoted, ` +
        `so the shell would tear it in half and the tool would be given something Damon never meant. ` +
        `Wrap it in quoteCli() where the command is built.`
    )
  }
}

const SAFE_TOOL = /^(?:[A-Za-z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_-]+)$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function safeTools(tools: string[]): string[] {
  return tools.filter((t) => SAFE_TOOL.test(t))
}

export const DAMON_BASE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Skill'
]

export function buildManagerArgs(o: {
  model: string
  sessionId?: string
  skipPermissions: boolean
  mcpConfigPath?: string
  mcpToolPrefixes?: string[]
  strictMcpConfig?: boolean
  baseTools?: string[]
  maxTurns?: number
  noTools?: boolean
  streamInput?: boolean
}): string[] {
  if (!SAFE_ID.test(o.model)) throw new Error(`Refusing to start: unsafe model id ${JSON.stringify(o.model)}.`)
  if (o.sessionId !== undefined && !SAFE_ID.test(o.sessionId)) {
    throw new Error(`Refusing to start: unsafe session id ${JSON.stringify(o.sessionId)}.`)
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', o.model]
  if (o.skipPermissions) args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', 'acceptEdits')
  if (o.streamInput) args.push('--input-format', 'stream-json')
  if (o.sessionId) args.push('--resume', o.sessionId)
  if (typeof o.maxTurns === 'number' && Number.isInteger(o.maxTurns) && o.maxTurns > 0) {
    args.push('--max-turns', String(o.maxTurns))
  }
  if (o.strictMcpConfig) args.push('--strict-mcp-config')
  if (o.noTools) {
    args.push('--allowedTools', '""')
    return args
  }
  const requested = safeTools(o.baseTools ?? [])
  const tools = [...new Set([...DAMON_BASE_TOOLS, ...requested])]
  if (o.mcpConfigPath) {
    args.push('--mcp-config', quoteCli(o.mcpConfigPath))
    const prefixes = safeTools(o.mcpToolPrefixes ?? [])
    for (const p of prefixes.length > 0 ? prefixes : ['mcp__damon']) if (!tools.includes(p)) tools.push(p)
  }
  args.push('--allowedTools', tools.join(','))
  return args
}

export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
}

export interface ManagerSessionConfig {
  protectedTurn?: {
    context(): string
    start(input: { prompt: string; systemAppend?: string; model: string; onEvent(event: ManagerEvent): void }): NativeBrokerTurn
    baseStore?: { load(model: string): SnapshotBase | undefined; save(base: SnapshotBase, model: string): void; touch?(model: string, at: number, usedAt: number): void }
  }
  cliPath: string
  cwd: string
  projectName: string
  owner?: SpawnOwner
  model: string
  fallbackModel: string
  skipPermissions: boolean
  mcpConfigPath?: string
  mcpToolPrefixes?: string[]
  strictMcpConfig?: boolean
  userProfile?: string
  hasFolder?: boolean
  teamMode?: boolean
  providers?: string[]
  ownerBrains?: { agent: string; lead: string }
  seatTools?: (model: string) => ReadonlySet<string>
  systemPrompt?: string
  seedState?: () => string
  initialState?: { sessionId?: string; legacySessionId?: string; model?: string; promptVersion?: number }
  timeoutMs?: number
  commandSilenceMs?: number
  warmMs?: number
}

export const MAX_WARM_TURNS = 12

export const MAX_BASIS_RETRIES = 3
export function basisMovedBeforeRun(error: string | undefined): boolean {
  return /Protected work could not (?:start|be admitted): Project requirements, owner input or task basis changed/.test(error ?? '')
}

interface WarmProcess {
  proc: SpawnedProcess
  model: string
  sessionId?: string
  skipPermissions: boolean
  expires: number
  turns: number
  turn: (prompt: string, resolve: (o: AttemptOutcome) => void) => void
  end: () => void
}

export interface AttemptOutcome {
  cleanupVerified?: boolean
  ok: boolean
  cancelled?: boolean
  error?: string
  costUsd?: number
  tokens?: number
  tokenUsage?: Record<string, number>
  steps?: number
  firstStep?: Record<string, number>
  estimated?: boolean
  promptBytes?: { systemAppend: number; prompt: number }
  stableSha256?: string
  rebuildCause?: SnapshotCause
  limited?: boolean
  resetsAt?: number
  outOfSteps?: boolean
  timedOut?: boolean
}

export class ManagerSession {
  private protectedActive?: NativeBrokerTurn
  private snapshotBases = new Map<string, SnapshotBase>()
  busy = false
  private sessionId?: string
  private sessionProvider?: string
  private model: string
  private proc?: SpawnedProcess
  private writable?: SpawnedProcess
  private delivered: string[] = []
  private cancelled = false
  private promptVersion: number
  private turnModel: string
  private turnKind: 'owner' | 'routine' = 'owner'
  private tooHeavy = false
  private warm?: WarmProcess

  constructor(
    private cfg: ManagerSessionConfig,
    private onEvent: (e: ManagerEvent) => void,
    private spawner: Spawner = nodeSpawner
  ) {
    this.sessionId = cfg.initialState?.legacySessionId ?? cfg.initialState?.sessionId
    this.sessionProvider = providerForModel(cfg.initialState?.model ?? cfg.model)
    this.model = cfg.initialState?.model ?? cfg.model
    this.turnModel = this.model
    this.promptVersion = cfg.initialState?.promptVersion ?? 0
  }

  getState(): {
    sessionId?: string
    legacySessionId?: string
    executionMode?: 'broker'
    model: string
    promptVersion: number
    turnModel: string
    turnKind: 'owner' | 'routine'
  } {
    return {
      sessionId: this.cfg.protectedTurn ? undefined : this.sessionProvider === providerForModel(this.model) ? this.sessionId : undefined,
      ...(this.cfg.protectedTurn ? { executionMode: 'broker' as const, legacySessionId: this.sessionId } : {}),
      model: this.model,
      promptVersion: this.promptVersion,
      turnModel: this.turnModel,
      turnKind: this.turnKind
    }
  }

  setModel(model: string): void {
    if (providerForModel(model) !== providerForModel(this.model)) { this.tooHeavy = true; this.endWarm() }
    this.model = model
  }

  endWarm(): void {
    const w = this.warm
    if (!w) return
    this.warm = undefined
    w.end()
  }

  setSkipPermissions(skip: boolean): void {
    if (this.cfg.skipPermissions === skip) return
    this.cfg.skipPermissions = skip
    this.endWarm()
  }

  private canReuse(w: WarmProcess): boolean {
    return (
      this.turnKind === 'owner' &&
      !this.cancelled &&
      w.model === this.turnModel &&
      w.skipPermissions === this.cfg.skipPermissions &&
      w.sessionId !== undefined &&
      w.sessionId === this.sessionId &&
      w.expires > Date.now() &&
      w.turns < MAX_WARM_TURNS
    )
  }

  cancel(): void {
    this.cancelled = true
    this.protectedActive?.cancel()
    this.writable = undefined
    this.proc?.kill()
  }

  deliver(text: string): boolean {
    if (this.cfg.protectedTurn) return false
    const proc = this.writable
    if (!proc) return false
    try {
      proc.stdin.write(userMessageLine(text))
    } catch {
      return false
    }
    this.delivered.push(text)
    return true
  }

  stop(): boolean {
    const changedSomething = this.busy && !this.cancelled
    this.cancel()
    return changedSomething
  }

  async send(text: string, kind: 'owner' | 'routine' = 'owner'): Promise<AttemptOutcome> {
    if (this.cfg.protectedTurn) return this.sendProtected(text, kind)
    if (this.busy) throw new Error('Manager is busy, wait for the current reply to finish.')
    this.busy = true
    if (this.sessionProvider !== providerForModel(this.model)) { this.sessionId = undefined; this.tooHeavy = true; this.sessionProvider = providerForModel(this.model) }
    this.cancelled = false
    this.turnModel = kind === 'routine' ? routineBrain(this.model) : this.model
    this.turnKind = kind
    try {
      const bumped =
        !this.cfg.systemPrompt && this.sessionId !== undefined && this.promptVersion < MANAGER_PROMPT_VERSION
      const seed = (this.tooHeavy || bumped) && this.cfg.seedState ? this.cfg.seedState() : ''
      if (seed) {
        this.sessionId = undefined
        this.tooHeavy = false
        this.onEvent({
          kind: 'tool_activity',
          tool: 'system',
          summary: 'Clearing out the older part of this conversation, and carrying the project state across.'
        })
      }

      const custom = this.cfg.systemPrompt
      const needsPrompt = custom
        ? this.sessionId === undefined
        : this.sessionId === undefined || this.promptVersion < MANAGER_PROMPT_VERSION
      const sys =
        custom ??
        managerSystemPrompt(
          this.cfg.projectName,
          this.cfg.userProfile,
          this.cfg.hasFolder ?? true,
          this.cfg.teamMode ?? false,
          this.cfg.providers ?? ['claude'],
          this.cfg.ownerBrains
        )
      const withPrompt = seed ? `${sys}\n\n---\n\n${seed}\n\n---\n\n${text}` : `${sys}\n\n---\n\n${text}`
      const prompt = needsPrompt ? withPrompt : text
      let briefed = needsPrompt

      const resumed = this.sessionId !== undefined
      let outcome = await this.runOnce(prompt)
      if (providerForModel(this.turnModel) === 'claude' && !outcome.ok && !outcome.limited && !outcome.outOfSteps && !outcome.timedOut && !this.cancelled && resumed) {
        this.onEvent({
          kind: 'tool_activity',
          tool: 'system',
          summary: 'That conversation could not be picked up again, so I am starting a fresh one.'
        })
        this.sessionId = undefined
        briefed = true
        outcome = await this.runOnce(withPrompt)
      }
      if (
        !outcome.ok &&
        !outcome.limited &&
        !outcome.outOfSteps &&
        !outcome.timedOut &&
        !this.cancelled &&
        providerForModel(this.turnModel) === 'claude' &&
        providerForModel(this.cfg.fallbackModel) === 'claude' &&
        this.turnModel !== this.cfg.fallbackModel
      ) {
        this.onEvent({
          kind: 'tool_activity',
          tool: 'system',
          summary: `The ${this.turnModel} model was not available. Switching to ${this.cfg.fallbackModel}.`
        })
        this.turnModel = this.cfg.fallbackModel
        if (kind === 'owner') this.model = this.cfg.fallbackModel
        outcome = await this.runOnce(briefed ? withPrompt : prompt)
      }
      if (outcome.ok && briefed && !custom) this.promptVersion = MANAGER_PROMPT_VERSION
      this.onEvent(
        outcome.ok || outcome.cancelled
          ? { kind: 'result', ok: true, costUsd: outcome.costUsd, tokens: outcome.tokens, tokenUsage: outcome.tokenUsage, steps: outcome.steps, firstStep: outcome.firstStep, estimated: outcome.estimated }
          : {
              kind: 'result',
              ok: false,
              error: outcome.error ?? 'Something went wrong.',
              costUsd: outcome.costUsd,
              tokens: outcome.tokens,
              tokenUsage: outcome.tokenUsage,
              steps: outcome.steps,
              firstStep: outcome.firstStep,
              estimated: outcome.estimated,
              limited: outcome.limited,
              resetsAt: outcome.resetsAt
            }
      )
      return outcome
    } finally {
      this.busy = false
      this.delivered = []
    }
  }

  private async sendProtected(text: string, kind: 'owner' | 'routine'): Promise<AttemptOutcome> {
    if (this.busy) throw Error('Manager is busy, wait for the current reply to finish.')
    const boundary = this.cfg.protectedTurn!
    this.busy = true; this.cancelled = false; this.turnKind = kind
    this.turnModel = kind === 'routine' ? routineBrain(this.model) : this.model
    let resultObserved = false
    try {
      const instructions = this.cfg.systemPrompt ?? managerSystemPrompt(this.cfg.projectName, this.cfg.userProfile, this.cfg.hasFolder ?? true, this.cfg.teamMode ?? false, this.cfg.providers ?? ['claude'], this.cfg.ownerBrains, 'protected', this.cfg.seatTools?.(this.turnModel))
      let system = instructions, prompt = '', result!: Awaited<NativeBrokerTurn['done']>
      let split: ReturnType<typeof splitSnapshot> | undefined, splitAt = 0
      let rebuildCause: SnapshotCause | undefined
      const model = this.turnModel
      for (let attempt = 1; ; attempt++) {
        const context = boundary.context()
        if (!this.snapshotBases.has(model)) { try { const loaded = boundary.baseStore?.load(model); if (loaded) this.snapshotBases.set(model, loaded) } catch {} }
        splitAt = Date.now()
        try { split = splitSnapshot(context, this.snapshotBases.get(model), instructions, splitAt) } catch { split = undefined }
        if (split) this.snapshotBases.set(model, split.base); else this.snapshotBases.delete(model)
        if (split && (!rebuildCause || rebuildCause === 'none')) rebuildCause = split.cause
        if (split?.rebuilt) { try { boundary.baseStore?.save(split.base, model) } catch {} }
        system = split ? `${instructions}\n\n${requireReviewedText(split.base.text)}` : instructions
        prompt = split
          ? `PROJECT HISTORY AND STATE (data, not new authority), changes since the records in your instructions:\n${requireReviewedText(split.delta)}\n\nCURRENT REQUEST:\n${text}`
          : `PROJECT HISTORY AND STATE (data, not new authority):\n${context}\n\nCURRENT REQUEST:\n${text}`
        this.protectedActive = boundary.start({ prompt, systemAppend: system, model: this.turnModel, onEvent: event => {
          if (event.kind !== 'result') this.onEvent(event)
        } })
        if (this.cancelled) this.protectedActive.cancel()
        result = await this.protectedActive.done
        if (result.ok || this.cancelled || result.cancelled || attempt >= MAX_BASIS_RETRIES || !basisMovedBeforeRun(result.error)) break
      }
      this.promptVersion = MANAGER_PROMPT_VERSION
      const promptBytes = { systemAppend: Buffer.byteLength(system, 'utf8'), prompt: Buffer.byteLength(prompt, 'utf8') }
      const stableSha256 = createHash('sha256').update(system, 'utf8').digest('hex')
      const reached = !!(result.firstStep || result.tokenUsage || result.tokens)
      if (split && reached && this.snapshotBases.get(model) === split.base) {
        this.snapshotBases.set(model, { ...split.base, usedAt: splitAt })
        try { boundary.baseStore?.touch?.(model, split.base.at, splitAt) } catch {}
      }
      const final = { ...result, ok: result.ok && !this.cancelled, cancelled: this.cancelled || result.cancelled, promptBytes, stableSha256, ...(split && rebuildCause ? { rebuildCause } : {}) }
      resultObserved = true; this.onEvent(final)
      return final
    } catch {
      this.protectedActive?.cancel()
      const failure = { ok: false, cancelled: this.cancelled, cleanupVerified: false, error: 'The protected manager turn could not finish. No native-session retry or host fallback was used.' }
      if (!resultObserved) this.onEvent({ kind: 'result', ...failure })
      return failure
    } finally { this.protectedActive = undefined; this.busy = false }
  }

  private withDelivered(prompt: string): string {
    if (this.delivered.length === 0) return prompt
    return [prompt, ...this.delivered].join('\n\n')
  }

  private async runProviderOnce(prompt: string): Promise<AttemptOutcome> {
    this.endWarm()
    const { adapterFor } = await import('./providers')
    if (this.cancelled) return { ok: false, cancelled: true }
    const adapter = adapterFor(this.turnModel)
    if (!adapter.canLead) return { ok: false, error: 'This provider cannot lead work in Damon.' }
    const dir = mkdtempSync(join(tmpdir(), 'damon-manager-'))
    const reportFile = join(dir, 'report.txt')
    try {
      const servers = this.cfg.mcpConfigPath ? JSON.parse(readFileSync(this.cfg.mcpConfigPath, 'utf8')).mcpServers : undefined
      const spec = adapter.launch({ cliPath: this.cfg.cliPath, model: this.turnModel, cwd: this.cfg.cwd, sessionId: this.sessionId, skipPermissions: this.cfg.skipPermissions, strictMcpConfig: this.cfg.strictMcpConfig, mcpServers: servers }, reportFile)
      return await new Promise<AttemptOutcome>((resolve) => {
        const proc = this.spawner(spec.command, spec.args, { cwd: this.cfg.cwd, owner: this.cfg.owner })
        this.proc = proc
        this.writable = undefined
        const reader = adapter.reader(), decoder = new StringDecoder('utf8')
        let stderrTail = '', settled = false, steps = 0
        const started = Date.now()
        let lastActivity = started
        const finish = (outcome: AttemptOutcome): void => {
          if (settled) return
          settled = true; clearInterval(timer)
          if (this.proc === proc) this.proc = undefined
          resolve(this.cancelled ? { ...outcome, ok: false, cancelled: true } : outcome)
        }
        let firstStep: Record<string, number> | undefined
        const consume = (events: ManagerEvent[]): void => {
          for (const event of events) {
            if (settled) return
            if (event.kind === 'session') { this.sessionId = event.sessionId; this.onEvent(event) }
            else if (event.kind === 'step_usage') { firstStep ??= event.usage }
            else if (event.kind === 'result') {
              if (contextSizeOf(event.tokens ?? 0, steps) >= HEAVY_CONTEXT) this.tooHeavy = true
              finish({ ok: event.ok, error: event.error, tokens: event.tokens, tokenUsage: event.tokenUsage, steps, costUsd: event.costUsd, limited: event.limited, resetsAt: event.resetsAt, firstStep, estimated: event.estimated })
            } else {
              if (event.kind === 'tool_activity' && ++steps > MAX_MANAGER_TURNS) {
                proc.kill(); finish({ ok: false, outOfSteps: true, error: 'The manager reached its step budget. Unfinished checks remain outstanding; continue when ready.' }); return
              }
              this.onEvent(event)
            }
          }
        }
        const timer = setInterval(() => {
          if (Date.now() - lastActivity > (this.cfg.timeoutMs ?? 600_000)) {
            proc.kill(); finish({ ok: false, timedOut: true, error: 'The manager stopped responding. Its unfinished work remains queued.' })
          }
        }, 1000)
        proc.stdout.on('data', data => { lastActivity = Date.now(); consume(reader.stdout(decoder.write(data))) })
        proc.stderr.on('data', data => { stderrTail = (stderrTail + data.toString('utf8')).slice(-4000) })
        proc.onError?.(err => finish({ ok: false, error: 'Could not start GPT: ' + err.message }))
        proc.on('close', code => {
          if (settled) return
          consume(reader.stdout(decoder.end()))
          let report = ''; try { report = readFileSync(reportFile, 'utf8') } catch {}
          consume(reader.close({ code, stderrTail, report }))
          if (!settled) finish({ ok: false, error: 'The provider did not report a completed turn.' })
        })
        proc.stdin.write(this.withDelivered(prompt)); proc.stdin.end()
      })
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }

  private runOnce(prompt: string): Promise<AttemptOutcome> {
    if (providerForModel(this.turnModel) !== 'claude') return this.runProviderOnce(prompt)
    const warm = this.warm
    if (warm && this.canReuse(warm)) {
      return new Promise((resolve) => warm.turn(prompt, resolve))
    }
    this.endWarm()
    return new Promise((resolve) => {
      const args = buildManagerArgs({
        model: this.turnModel,
        sessionId: this.sessionId,
        skipPermissions: this.cfg.skipPermissions,
        mcpConfigPath: this.cfg.mcpConfigPath,
        mcpToolPrefixes: this.cfg.mcpToolPrefixes,
        strictMcpConfig: this.cfg.strictMcpConfig,
        maxTurns: MAX_MANAGER_TURNS,
        streamInput: true
      })
      const proc = this.spawner(quoteCli(this.cfg.cliPath), args, { cwd: this.cfg.cwd, owner: this.cfg.owner })
      this.proc = proc
      this.writable = proc

      const parser = new NdjsonParser()
      let resolveTurn: (o: AttemptOutcome) => void = resolve
      let settled = false
      let sawResult: AttemptOutcome | null = null
      let stderrTail = ''
      let lastResetsAt: number | undefined
      let lastLimitStatus: string | undefined
      let firstStep: Record<string, number> | undefined
      let lastText = ''
      let inputClosed = false

      const endInput = (): void => {
        if (inputClosed) return
        inputClosed = true
        try {
          proc.stdin.end()
        } catch {
        }
      }

      const settle = (outcome: AttemptOutcome): void => {
        if (settled) return
        settled = true
        if (timeout) clearInterval(timeout)
        timeout = undefined
        if (this.writable === proc) this.writable = undefined
        resolveTurn(outcome)
      }

      const verdict = (noResult: () => AttemptOutcome): AttemptOutcome => {
        const parsed = parseResetsAt(lastText)
        const resetsAt = lastResetsAt ?? (parsed ? Math.floor(parsed / 1000) : undefined)
        if (this.cancelled) return { ok: false, cancelled: true }
        if (sawResult && !(sawResult as AttemptOutcome).ok) {
          const r = sawResult as AttemptOutcome
          const limited = isLimitError(r.error) || isLimitNotice(lastText) || lastLimitStatus === 'rejected'
          return limited ? { ...r, limited: true, resetsAt } : r
        }
        if (isLimitNotice(lastText) || lastLimitStatus === 'rejected') {
          const r = (sawResult as AttemptOutcome | null) ?? { ok: false }
          return { ...r, ok: false, error: lastText || 'Usage limit reached.', limited: true, resetsAt }
        }
        if (sawResult) return sawResult
        return noResult()
      }

      const silenceLimit = this.cfg.timeoutMs ?? SILENCE_LIMIT_MS
      const outstanding = new Map<string, string>()
      let started = Date.now()
      let lastOutputAt = started
      let lastActivity: string | undefined
      let noticesSent = 0
      let lastTickAt = started
      const tickMs = Math.max(10, Math.min(SILENCE_CHECK_MS, silenceLimit))
      let timeout: ReturnType<typeof setInterval> | undefined
      const armTimer = (): void => {
        timeout = setInterval(() => {
        if (settled) return
        const now = Date.now()
        const asleep = sleptThrough(now - lastTickAt, tickMs)
        lastTickAt = now
        if (asleep > 0) lastOutputAt += asleep
        const quietFor = Date.now() - lastOutputAt
        const waitingOn = outstanding.size > 0 ? [...outstanding.values()][0] : undefined
        const allowed = patienceFor(waitingOn !== undefined, silenceLimit, this.cfg.commandSilenceMs)
        if (quietFor >= noticeDueAt(noticesSent) && quietFor < allowed) {
          noticesSent += 1
          this.onEvent({
            kind: 'tool_activity',
            tool: 'system',
            summary: waitingNotice(waitingOn ?? lastActivity, quietFor, allowed)
          })
        }
        if (!shouldGiveUp({ sinceLastOutputMs: quietFor, elapsedMs: Date.now() - started, limitMs: allowed })) {
          return
        }
        proc.kill()
        settle({ ok: false, timedOut: true, error: giveUpReason(waitingOn ?? lastActivity, quietFor) })
        }, tickMs)
      }

      const beginTurn = (p: string, r: (o: AttemptOutcome) => void): void => {
        resolveTurn = r
        settled = false
        sawResult = null
        lastText = ''
        lastActivity = undefined
        noticesSent = 0
        started = Date.now()
        lastOutputAt = started
        lastTickAt = started
        outstanding.clear()
        this.proc = proc
        this.writable = proc
        armTimer()
        proc.stdin.write(userMessageLine(this.withDelivered(p)))
      }

      let costSeen = 0
      const perTurn = (cost: number, tokens: number, steps: number): { cost: number; tokens: number; steps: number } => {
        const out = { cost: cost >= costSeen ? cost - costSeen : cost, tokens, steps }
        costSeen = Math.max(costSeen, cost)
        return out
      }

      const keepWarm = (ok: boolean): boolean =>
        (this.cfg.warmMs ?? 0) > 0 && this.turnKind === 'owner' && ok && !this.cancelled && !this.tooHeavy && this.sessionId !== undefined

      const holdWarm = (): void => {
        const warmMs = this.cfg.warmMs ?? 0
        const w: WarmProcess =
          this.warm?.proc === proc
            ? this.warm
            : {
                proc,
                model: this.turnModel,
                sessionId: this.sessionId,
                skipPermissions: this.cfg.skipPermissions,
                expires: 0,
                turns: 0,
                turn: beginTurn,
                end: endInput
              }
        w.turns += 1
        w.sessionId = this.sessionId
        w.expires = Date.now() + warmMs
        this.warm = w
        const t = setTimeout(() => {
          if (this.warm === w && settled) this.endWarm()
        }, warmMs)
        t.unref?.()
      }

      proc.stdout.on('data', (data) => {
        lastOutputAt = Date.now()
        noticesSent = 0
        for (const obj of parser.push(data.toString('utf8'))) {
          for (const event of toManagerEvents(obj)) {
            if (event.kind === 'session') {
              this.sessionId = event.sessionId
            } else if (event.kind === 'step_usage') {
              firstStep ??= event.usage
            } else if (event.kind === 'rate_limit') {
              lastResetsAt = event.resetsAt ?? lastResetsAt
              lastLimitStatus = event.status ?? lastLimitStatus
              this.onEvent(event)
            } else if (event.kind === 'result') {
              const used = perTurn(event.costUsd ?? 0, event.tokens ?? 0, event.steps ?? 0)
              sawResult = {
                ok: event.ok,
                error: event.outOfSteps
                  ? 'That took a lot of steps, so Damon stopped it to protect your allowance. Nothing is lost. Say "carry on" to pick it up from where it stopped, or give it a smaller piece to do next.'
                  : event.error,
                costUsd: used.cost,
                tokens: used.tokens,
                tokenUsage: event.tokenUsage,
                steps: used.steps,
                firstStep,
                outOfSteps: event.outOfSteps
              }
              if (contextSizeOf(used.tokens, used.steps) >= HEAVY_CONTEXT) this.tooHeavy = true
              const outcome = verdict(() => sawResult as AttemptOutcome)
              if (keepWarm(outcome.ok)) holdWarm()
              else endInput()
              settle(outcome)
            } else {
              if (event.kind === 'assistant_text') lastText = event.text
              if (event.kind === 'tool_activity') {
                lastActivity = event.summary
                if (event.id) outstanding.set(event.id, event.summary)
              }
              if (event.kind === 'tool_done') outstanding.delete(event.id)
              this.onEvent(event)
            }
          }
        }
      })

      proc.stderr.on('data', (data) => {
        stderrTail = (stderrTail + data.toString('utf8')).slice(-2000)
      })

      proc.onError?.((err) => {
        if (this.warm?.proc === proc) this.warm = undefined
        if (settled) return
        settle({ ok: false, error: `Damon could not start the Claude Code app: ${err.message}` })
      })

      proc.on('close', (code) => {
        if (this.warm?.proc === proc) this.warm = undefined
        if (settled) return
        settle(
          verdict(() => {
            if (code === 0) return { ok: true }
            const err = stderrTail.trim() || `The Claude Code app exited unexpectedly (code ${String(code)}).`
            return isLimitError(err)
              ? { ok: false, error: err, limited: true, resetsAt: lastResetsAt }
              : { ok: false, error: err }
          })
        )
      })

      beginTurn(prompt, resolve)
    })
  }
}
