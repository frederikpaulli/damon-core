// Runs one worker or reviewer turn through a provider adapter and parses its report:
// hand-overs to the owner, memory notes and the final answer.
import { changesFiles, planIn, type PlanRecord } from '../../shared/plan-first'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentFeedLine, AgentInfo, ManagerEvent, TaskInfo } from '../../shared/types'
import { configWasRead } from '../../shared/connector-tools'
import type { AgentRun, AgentRunOutcome } from './task-engine'
import type { AgentMemory } from './memory-store'
import { buildManagerArgs, nodeSpawner, quoteCli, type Spawner } from './manager-session'
import { agentSystemPrompt, agentTaskPrompt } from './agent-prompt'
import { MAX_AGENT_TURNS, assignedTurns, SAME_STEP_LIMIT, lastCallFor, outOfStepsNote } from '../../shared/turns'
import { SILENCE_CHECK_MS, patienceFor, sleptThrough } from '../../shared/turn-patience'
import { adapterFor } from './providers'
import { NdjsonParser, toManagerEvents } from './stream-parser'
import type { ToolUse } from './tool-log'
import { providerForModel } from '../../shared/models'
import { hasCritiqueSurface, hasDocumentSurface, hasVisibleSurface } from '../../shared/review'
import { nativeTurnTransport } from './providers/native-turn-transport'
import type { NativeBrokerTurn } from './providers/native-broker-run'
import { selfCheckIn } from '../../shared/self-check'

export interface AgentRunnerConfig {
  protectedTurn?: (input: { agent: AgentInfo; task: TaskInfo; prompt: string; onEvent(event: ManagerEvent): void }) => NativeBrokerTurn
  cliPath: string
  cwd: string
  projectName: string
  projectId: string
  skipPermissions: boolean
  strictMcpConfig?: boolean
  mcpConfigPath?: string
  expectedMcpServers?: string[]
  mcpServers?: Record<string, unknown>
  onMcpMismatch?: (report: { missing: string[]; failed: string[]; read: boolean }) => void
  mcpToolPrefixes?: string[]
  timeoutMs?: number
  silenceMs?: number
  commandSilenceMs?: number
  briefFor?: (agent: AgentInfo, task: TaskInfo, feedback: string | null) => string | null
  usersOf?: (task: TaskInfo) => string[]
  changedOf?: (task: TaskInfo) => string[]
  checksFor?: (task: TaskInfo) => string
  doneMeansFor?: (task: TaskInfo) => string
  selfCheckFor?: (task: TaskInfo) => string
  reviewSeat?: boolean
  memoryOf: (agent: AgentInfo, query: string) => AgentMemory
  onNotes: (agentId: string, notes: string[]) => void
  onHandover?: (agentId: string, handover: HandedOver[], answered: boolean) => void
  onUsage?: (costUsd: number, tokens: number, meta: { model: string; reported: boolean; steps?: number; tokenUsage?: Record<string, number>; estimated?: boolean }) => void
  onToolUse?: (use: ToolUse) => void
  onToolResult?: (result: { id: string; ok: boolean; outcome?: string; proof?: string[]; background?: boolean }) => void
  onSession?: (taskId: string, sessionId: string) => void
  planCheck?: (task: TaskInfo, plan: string) => string | null
  planPark?: (task: TaskInfo, plan: string) => string | { note: string; owner: string } | null
  ownerProfile?: () => string
  protectedContextFor?: AgentRunnerConfig['contextFor']
  contextFor?: (
    agent: AgentInfo,
    query: string,
    task: TaskInfo
  ) => { brainSlice?: string; siblings?: string; plan?: string; notes?: string; tools?: ReadonlySet<string> }
}

export interface HandedOver {
  file: string
  what: string
}

function insideProject(file: string): boolean {
  if (file.length === 0 || file.length > 400) return false
  if (/^[a-zA-Z]:/.test(file) || file.startsWith('/') || file.startsWith('\\')) return false
  return !file.split(/[\\/]/).includes('..')
}

export function parseHandover(report: string): { text: string; handover: HandedOver[]; answered: boolean } {
  const match = /^[ \t]*HANDOVER:[ \t]*(.*)$/im.exec(report)
  if (!match) return { text: report.trim(), handover: [], answered: false }
  const text = report.slice(0, match.index).trim()
  const tail = (match[1] + '\n' + report.slice(match.index + match[0].length)).trim()
  if (/^none\b/i.test(tail)) return { text, handover: [], answered: true }

  const handover: HandedOver[] = []
  for (const raw of tail.split('\n')) {
    const line = raw.trim().replace(/^[-•*]\s*/, '')
    if (/^(MEMORY NOTES|HANDOVER):/i.test(line)) break
    if (line.length === 0) continue
    let at = line.indexOf(':')
    if (at === 1 && /^[a-zA-Z]$/.test(line[0]!)) at = line.indexOf(':', 2)
    if (at === -1) {
      const dash = line.search(/\s+(?:—|–|-)\s+/)
      if (dash > 0) {
        const sep = /\s+(?:—|–|-)\s+/.exec(line)!
        const file0 = line.slice(0, dash).trim()
        const what0 = line.slice(dash + sep[0].length).trim()
        if (insideProject(file0) && !/\s/.test(file0)) handover.push({ file: file0, what: what0 })
        continue
      }
    }
    let file = (at === -1 ? line : line.slice(0, at)).trim()
    let what = at === -1 ? '' : line.slice(at + 1).trim()
    if (/\s(to|through)\s/i.test(file) || /^(deliverable|deliverables|working file|working files|internal|working)$/i.test(file) || /^\.[a-z0-9]+$/i.test(file)) {
      if (!(/^(deliverable|deliverables|working file|working files|internal|working)$/i.test(file) && what.includes(':'))) continue
    }
    const lane = /^(deliverable|deliverables|working file|working files|internal|working)$/i.exec(file)
    if (lane && what.includes(':')) {
      const next = what.indexOf(':')
      file = what.slice(0, next).trim()
      what = `${lane[1]!.toLowerCase()}: ${what.slice(next + 1).trim()}`
    }
    if (/["“”(]/.test(file) || (!/[\\/]/.test(file) && !/\.[A-Za-z0-9]{1,6}$/.test(file))) continue
    if (insideProject(file)) handover.push({ file, what })
  }
  return { text, handover, answered: true }
}

export function parseMemoryNotes(report: string): { text: string; notes: string[] } {
  const match = /^[ \t]*MEMORY NOTES:[ \t]*(.*)$/im.exec(report)
  if (!match) return { text: report.trim(), notes: [] }
  const text = report.slice(0, match.index).trim()
  const tail = (match[1] + '\n' + report.slice(match.index + match[0].length)).trim()
  if (/^none\b/i.test(tail)) return { text, notes: [] }
  const notes = tail
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
    .filter((l) => l.length > 3)
    .slice(0, 3)
  return { text, notes }
}

const DEFAULT_AGENT_SILENCE_MS = 10 * 60 * 1000

const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000

function howLong(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    const h = Math.round(ms / (60 * 60 * 1000))
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  if (ms >= 60 * 1000) {
    const m = Math.round(ms / 60_000)
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`
  }
  const s = Math.max(1, Math.round(ms / 1000))
  return `${s} ${s === 1 ? 'second' : 'seconds'}`
}

function lastCall(
  cfg: AgentRunnerConfig,
  agentId: string,
  model: string,
  sessionId: string,
  spawner: Spawner,
  onUsage: (costUsd: number, tokens: number) => void,
  reason: { why: 'steps' | 'clock'; detail?: string } = { why: 'steps' }
): Promise<string> {
  return new Promise((resolve) => {
    const args = buildManagerArgs({
      model,
      sessionId,
      skipPermissions: cfg.skipPermissions,
      strictMcpConfig: cfg.strictMcpConfig,
      maxTurns: 1,
      noTools: true
    })
    const proc = spawner(quoteCli(cfg.cliPath), args, {
      cwd: cfg.cwd,
      owner: { projectId: cfg.projectId, agentId }
    })
    const parser = new NdjsonParser()
    const decoder = new StringDecoder('utf8')
    let text = ''
    let partial = ''
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve((text || partial).trim())
    }
    const timer = setTimeout(() => {
      proc.kill()
      done()
    }, 90_000)

    proc.stdout.on('data', (data) => {
      for (const obj of parser.push(decoder.write(data))) {
        for (const event of toManagerEvents(obj)) {
          if (event.kind === 'assistant_delta') partial += event.text
          if (event.kind === 'assistant_text') text = event.text
          if (event.kind === 'result') onUsage(event.costUsd ?? 0, event.tokens ?? 0)
        }
      }
    })
    proc.onError?.(() => done())
    proc.on('close', done)
    proc.stdin.write(lastCallFor(reason.why, reason.detail))
    proc.stdin.end()
  })
}

export function makeAgentRun(
  cfg: AgentRunnerConfig,
  onFeed: (agentId: string, line: AgentFeedLine) => void,
  spawner: Spawner = nodeSpawner
): AgentRun {
  const run = (agent: AgentInfo, task: TaskInfo, feedback: string | null): Promise<AgentRunOutcome> => {
    if(task.assignment&&!cfg.reviewSeat)agent={...agent,maxTurns:assignedTurns(agent.maxTurns,task.assignment.maxTurns)}
    return new Promise((resolve) => {
        const feed = (kind: AgentFeedLine['kind'], text: string): void => {
          onFeed(agent.id, { at: new Date().toISOString(), kind, text })
        }
        let memoryIssue = ''
        const remember = (notes: string[]): boolean => {
          try { cfg.onNotes(agent.id, notes); return true }
          catch {
            memoryIssue = 'Worker reminders could not be saved. Review project memory recovery before relying on future recall. The work report follows.\n\n'
            feed('status', memoryIssue.trim()); return false
          }
        }

      const override = cfg.briefFor?.(agent, task, feedback) ?? null
      const firstRound = !task.sessionId || Boolean(cfg.protectedTurn)
      const body = override ?? agentTaskPrompt(task, feedback, { usedBy: cfg.usersOf?.(task), protectedRoute: Boolean(cfg.protectedTurn), checks: cfg.checksFor?.(task) || undefined, changed: cfg.changedOf?.(task), doneMeans: cfg.doneMeansFor?.(task) || undefined, selfCheck: cfg.selfCheckFor?.(task) || undefined })
      const query = `${task.title} ${task.instructions} ${feedback ?? ''}`
      const prompt =
        override !== null
          ? override
          : firstRound
            ? `${agentSystemPrompt(agent, cfg.projectName, cfg.memoryOf(agent, query), cfg.ownerProfile?.() ?? '', {
                ...(cfg.protectedTurn ? cfg.protectedContextFor : cfg.contextFor)?.(agent, query, task),
                visibleSurface: hasVisibleSurface(`${task.title} ${task.instructions} ${task.acceptance}`),
                protectedLook: Boolean(cfg.protectedTurn),
                protectedRoute: Boolean(cfg.protectedTurn),
                documentSurface: hasDocumentSurface(`${task.title} ${task.instructions} ${task.acceptance}`),
                critiqueSurface: hasCritiqueSurface(`${task.title} ${task.instructions} ${task.acceptance}`)
              })}\n\n---\n\n${body}`
            : body

      const provider = adapterFor(agent.model)
      const reportFile = join(mkdtempSync(join(tmpdir(), 'damon-run-')), 'report.txt')
      const spec = cfg.protectedTurn ? null : provider.launch(
        {
          cliPath: cfg.cliPath,
          model: agent.model,
          cwd: cfg.cwd,
          sessionId: task.sessionId,
          skipPermissions: cfg.skipPermissions,
          strictMcpConfig: cfg.strictMcpConfig,
          mcpConfigPath: cfg.mcpConfigPath,
          mcpServers: cfg.mcpServers,
          mcpToolPrefixes: cfg.mcpToolPrefixes,
          baseTools: agent.tools,
          maxTurns: agent.maxTurns ?? MAX_AGENT_TURNS
        },
        reportFile
      )
      const native = cfg.protectedTurn ? nativeTurnTransport((prompt, onEvent) => cfg.protectedTurn!({ agent, task, prompt, onEvent })) : undefined
      const proc = native?.process ?? spawner(spec!.command, spec!.args, {
        cwd: cfg.cwd,
        owner: { projectId: cfg.projectId, agentId: agent.id }
      })
      const reader = native?.reader ?? provider.reader()

      let settled = false
      let sessionId: string | undefined = task.sessionId
      let lastText = ''
      let plan: PlanRecord | null = null
      let changedFiles = false
      let spoke = false
      let sessionTold = false
      const tellSession = (): void => {
        if (sessionTold || !spoke || !sessionId || sessionId === task.sessionId) return
        sessionTold = true
        cfg.onSession?.(task.id, sessionId)
      }
      let stderrTail = ''
      let ended: {
        ok: boolean
        error?: string
        limited?: boolean
        resetsAt?: number
        outOfSteps?: boolean
      } | null = null

      feed('status', feedback ? `Revising: ${task.title} (round ${task.round})` : `Starting: ${task.title}`)

      const silenceMs = cfg.silenceMs ?? DEFAULT_AGENT_SILENCE_MS
      const ceilingMs = cfg.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
      let clock: ReturnType<typeof setInterval> | undefined
      const outstanding = new Map<string, string>()
      const backgrounded = new Map<string, string>()
      const toolById = new Map<string, string>()
      let lastStep = ''
      let sameStep = 0

      const stopRun = (ranOut: string, why: string): void => {
        if (settled) return
        settled = true
        clearInterval(clock)
        proc.kill()
        try {
          rmSync(join(reportFile, '..'), { recursive: true, force: true })
        } catch {
        }
        if (native) {
          void native.closed.then(() => resolve({ ok: false, resultText: lastText ? `${ranOut}\n\nPartial report:\n${lastText}` : ranOut, sessionId, plan, changedFiles }))
          return
        }
        if (!sessionId) {
          feed('status', `Stopped: ${why}.`)
          resolve({ ok: false, resultText: ranOut, sessionId })
          return
        }
        feed('status', `Stopped because ${why}: asking ${agent.name} to hand over what it has.`)
        void lastCall(
          cfg,
          agent.id,
          agent.model,
          sessionId,
          spawner,
          (costUsd, tokens) =>
            cfg.onUsage?.(costUsd, tokens, { model: agent.model, reported: Boolean(costUsd || tokens) }),
          { why: 'clock', detail: why }
        )
          .then((recovered) => {
            const parsed = parseMemoryNotes(recovered)
            const handed = parseHandover(parsed.text)
            cfg.onHandover?.(agent.id, handed.handover, handed.answered)
              if (parsed.notes.length > 0) remember(parsed.notes)
            feed('status', handed.text ? `Stopped because ${why}, with its work handed over.` : `Stopped because ${why}.`)
            resolve({
              ok: false,
                resultText: memoryIssue + (handed.text ? `${ranOut}\n\nWhat it says it got done:\n\n${handed.text}` : ranOut),
              sessionId
            })
          })
          .catch(() => resolve({ ok: false, resultText: ranOut, sessionId }))
      }

      const tickMs = Math.max(10, Math.min(SILENCE_CHECK_MS, silenceMs, ceilingMs))
      let lastTickAt = Date.now()
      let quietFor = 0
      let ranFor = 0
      clock = setInterval(() => {
        if (settled) return
        const now = Date.now()
        const gap = now - lastTickAt
        const awake = gap - sleptThrough(gap, tickMs)
        lastTickAt = now
        quietFor += awake
        ranFor += awake
        const waitingOn = outstanding.size > 0 ? [...outstanding.values()][0] : backgrounded.size > 0 ? [...backgrounded.values()][0] : undefined
        const allowed = patienceFor(waitingOn !== undefined, silenceMs, cfg.commandSilenceMs)
        if (quietFor > allowed) {
          stopRun(
            waitingOn !== undefined
              ? `${agent.name} was waiting on “${waitingOn}” for ${howLong(allowed)} and nothing came back, so it was stopped. This did not finish, and the command may still be running.`
              : `${agent.name} stopped sending any sign of life for ${howLong(allowed)}, so it was stopped. This did not finish.`,
            waitingOn !== undefined ? 'a command never answered' : 'it went quiet'
          )
          return
        }
        if (ranFor > ceilingMs) {
          stopRun(
            `${agent.name} was stopped after ${howLong(ceilingMs)}, which is the longest one go at a job can run. This did not finish.`,
            'it hit the longest a job can run'
          )
        }
      }, tickMs)

      const heard = (): void => {
        if (settled) return
        quietFor = 0
      }

      const handle = (events: ManagerEvent[]): void => {
        for (const event of events) {
          if (event.kind === 'session') {
            if (native) continue
            sessionId = event.sessionId
            tellSession()
            if (provider.reportsMcp && cfg.expectedMcpServers && cfg.expectedMcpServers.length > 0) {
              const seen = configWasRead(event.mcpServers ?? [], cfg.expectedMcpServers)
              if (!seen.read || seen.missing.length > 0 || seen.failed.length > 0) {
                cfg.onMcpMismatch?.(seen)
              }
            }
          } else if (event.kind === 'tool_activity') {
            if (event.id) { outstanding.set(event.id, event.summary); toolById.set(event.id, event.tool) }
            feed('activity', event.summary)
            const step = `${event.tool}|${event.step ?? event.detail ?? event.summary}`
            sameStep = step === lastStep ? sameStep + 1 : 1
            lastStep = step
            if (sameStep >= SAME_STEP_LIMIT) {
              stopRun(
                `${agent.name} ran the same step ${sameStep} times in a row (${event.summary}) and was stopped for going round in circles. This did not finish.`,
                'it kept repeating the same step'
              )
              return
            }
            spoke = true
            tellSession()
            if (changesFiles(event.tool)) changedFiles = true
            cfg.onToolUse?.({
              id: event.id,
              at: new Date().toISOString(),
              agentId: agent.id,
              agentName: agent.name,
              taskId: task.id,
              taskTitle: task.title,
              provider: providerForModel(agent.model),
              model: agent.model,
              tool: event.tool,
              summary: event.summary,
              detail: event.detail,
              ...(event.background ? { background: true } : {})
            })
          } else if (event.kind === 'tool_done') {
            cfg.onToolResult?.(event)
            const label = outstanding.get(event.id)
            outstanding.delete(event.id)
            if (event.background && label) backgrounded.set(event.id, label)
            if (event.ok && /^(BashOutput|KillShell|KillBash)$/.test(toolById.get(event.id) ?? '')) backgrounded.clear()
            toolById.delete(event.id)
            if (!event.ok && event.outcome) feed('activity', `Failed: ${event.outcome}`)
          } else if (event.kind === 'assistant_text') {
            lastText = event.text
            spoke = true
            tellSession()
            if (!plan) {
              const said = planIn(event.text)
              if (said) {
                plan = { text: said, beforeChanges: !changedFiles }
                const refused = firstRound && !changedFiles ? (cfg.planCheck?.(task, said) ?? null) : null
                if (refused) {
                  if (!settled) {
                    settled = true
                    clearInterval(clock)
                    proc.kill()
                    try {
                      rmSync(join(reportFile, '..'), { recursive: true, force: true })
                    } catch {
                    }
                    feed('status', `Stopped before it changed anything: ${refused}`)
                    const refusedOutcome = { ok: false, resultText: refused, sessionId, plan, changedFiles: false }
                    if (native) void native.closed.then(() => resolve(refusedOutcome))
                    else resolve(refusedOutcome)
                  }
                  return
                }
                const park = firstRound && task.round === 1 && !task.parkedOnce && !changedFiles ? (cfg.planPark?.(task, event.text) ?? null) : null
                const parked = typeof park === 'string' ? park : park?.note
                if (parked) {
                  if (!settled) {
                    settled = true
                    clearInterval(clock)
                    proc.kill()
                    try {
                      rmSync(join(reportFile, '..'), { recursive: true, force: true })
                    } catch {
                    }
                    feed('status', `Parked before it changed anything: ${typeof park === 'string' ? parked : park!.owner}`)
                    const parkedOutcome = { ok: false, parked: true, resultText: parked, sessionId, plan, changedFiles: false }
                    if (native) void native.closed.then(() => resolve(parkedOutcome))
                    else resolve(parkedOutcome)
                  }
                  return
                }
              }
            }
            feed('text', event.text.length > 500 ? event.text.slice(0, 500) + '…' : event.text)
          } else if (event.kind === 'result') {
            ended = {
              ok: event.ok,
              error: event.error,
              limited: event.limited,
              resetsAt: event.resetsAt,
              outOfSteps: event.outOfSteps
            }
            cfg.onUsage?.(event.costUsd ?? 0, event.tokens ?? 0, {
              model: agent.model,
              reported: event.tokenUsage !== undefined || Boolean(event.costUsd || event.tokens),
              tokenUsage: event.tokenUsage,
              ...(event.estimated ? { estimated: true } : {}),
              steps: event.steps
            })
          }
        }
      }

      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      proc.stdout.on('data', (data) => {
        heard()
        handle(reader.stdout(outDecoder.write(data)))
      })
      proc.stderr.on('data', (data) => {
        heard()
        stderrTail = (stderrTail + errDecoder.write(data)).slice(-2000)
      })

      proc.onError?.((err) => {
        if (settled) return
        settled = true
        clearInterval(clock)
        feed('status', 'Failed.')
        resolve({ ok: false, resultText: `${agent.name} could not be started: ${err.message}`, sessionId })
      })

      proc.onExit?.((code) => {
        if (ended !== null) void finish(code)
      })

      proc.on('close', (code) => void finish(code))

      const finish = async (code: number | null): Promise<void> => {
        try {
          await settle(code)
        } catch (err) {
          resolve({
            ok: false,
            resultText: `${agent.name} finished, but Damon could not record the result: ${err instanceof Error ? err.message : String(err)}`,
            sessionId
          })
        }
      }

      const settle = async (code: number | null): Promise<void> => {
        if (settled) return
        settled = true
        clearInterval(clock)
        const report = existsSync(reportFile) ? readFileSync(reportFile, 'utf8').trim() : ''
        try {
          rmSync(join(reportFile, '..'), { recursive: true, force: true })
        } catch {
        }
        handle(reader.close({ code, stderrTail, report }))
        const done = ended as {
          ok: boolean
          error?: string
          limited?: boolean
          resetsAt?: number
          outOfSteps?: boolean
        } | null

        if (done?.limited) {
          feed('status', 'Paused: your usage limit was reached. Autopilot will continue after it resets.')
          resolve({
            ok: false,
            resultText: 'Usage limit reached.',
            sessionId: lastText ? sessionId : task.sessionId,
            limited: true,
            resetsAt: done.resetsAt
          })
          return
        }

        if (!native && task.sessionId && /No conversation found/i.test(done?.error ?? '')) {
          feed('status', 'Its earlier conversation could not be found, so it is starting this job again from the brief.')
          resolve(run(agent, { ...task, sessionId: undefined }, feedback))
          return
        }

        if (!native && done?.outOfSteps && sessionId) {
          feed('status', `Out of steps: asking ${agent.name} to hand over what it has.`)
          const recovered = await lastCall(cfg, agent.id, agent.model, sessionId, spawner, (costUsd, tokens) =>
            cfg.onUsage?.(costUsd, tokens, { model: agent.model, reported: Boolean(costUsd || tokens) })
          )
          const note = outOfStepsNote(agent.name, agent.maxTurns ?? MAX_AGENT_TURNS)
          const parsed = parseMemoryNotes(recovered)
          const handed = parseHandover(parsed.text)
          cfg.onHandover?.(agent.id, handed.handover, handed.answered)
          if (parsed.notes.length > 0) remember(parsed.notes)
          feed('status', 'Stopped at the step limit, with its work handed over.')
          resolve({
            ok: true,
            resultText: memoryIssue + (handed.text ? `${note}\n\n${handed.text}` : note),
            sessionId,
            stderr: stderrTail,
            plan,
            changedFiles,
            selfCheck: selfCheckIn(recovered) ?? undefined
          })
          return
        }

        if (done?.ok) {
          const parsed = parseMemoryNotes(lastText)
          const handed = parseHandover(parsed.text)
          cfg.onHandover?.(agent.id, handed.handover, handed.answered)
          if (parsed.notes.length > 0 && remember(parsed.notes)) {
            feed('status', `Learned ${parsed.notes.length} lesson${parsed.notes.length > 1 ? 's' : ''} for next time.`)
          }
          feed('status', 'Finished, waiting for the manager to review.')
          resolve({
            ok: true,
            resultText: memoryIssue + (handed.text || 'The agent finished but sent no report.'),
            sessionId,
            stderr: stderrTail,
            plan,
            changedFiles,
            selfCheck: selfCheckIn(lastText) ?? undefined
          })
          return
        }

        feed('status', 'Failed.')
        if (native) {
          const reason = done?.error ?? 'The protected turn did not finish.'
          resolve({ ok: false, resultText: lastText ? `${reason}\n\nPartial report:\n${lastText}` : reason, sessionId, plan, changedFiles })
          return
        }
        const said = done?.error || `The agent stopped unexpectedly (code ${String(code)}).`
        const channel = stderrTail.trim()
        resolve({
          ok: false,
          resultText: channel && !said.includes(channel) ? `${said}\n\nWhat it printed on its error channel:\n${channel.slice(-1500)}` : said,
          sessionId,
          stderr: stderrTail
        })
      }

      proc.stdin.write(prompt)
      proc.stdin.end()
    })
  }
  return run
}
