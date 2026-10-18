// The task engine: one queue of jobs per project. It admits a job, starts its worker when
// what it waits for is done, sends the draft to review, and handles revision rounds, the
// round cap, step-up to a stronger model, known-fault follow-ups and usage-limit pauses.
import type { PlanRecord } from '../../shared/plan-first'
import { latePlans, LATE_PLAN_HABIT, LATE_PLAN_LESSON, PARK_ANSWER_HEAD, PARK_ANSWERED_HEAD } from '../../shared/plan-first'
import { dirname, join } from 'node:path'
import { appendFileSync, closeSync, copyFileSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentInfo, TaskInfo } from '../../shared/types'
import type { RosterStore } from './roster-store'
import { readJson, writeJson } from './json-file'
import type { Finding, Verdict } from '../../shared/verification'
import { arrivalOf, CODE_SEND_BACK, REVIEWER_SEND_BACK, type Arrival, type ReviewDepth, type ReviewRecord } from '../../shared/review'
import { clashSentence, matchesScope, sameLineOfCommand, scopeClash, touchesSharedSpine } from '../../shared/scope'
import { findKnot, resolveKeys } from '../../shared/knots'
import { findWaitCycles, type WaitEdge, type WaitEdgeKind } from '../../shared/wait-graph'
import { acceptableAsKnownFault, canBeFixed, carriesHeldFiles, faultOpen, fixCriterion, fixLinedUp, fixPassed, fixWaitsOn, heldByFault, stampVerifiedFixes } from '../../shared/known-faults'
import { driftBetween, type ContractStamp } from '../../shared/contracts'
import { milestonesAtRest } from '../../shared/product-critic'
import { liveWorkUnder } from '../../shared/chain-of-command'
import { attemptNote, decideAttempt, MAX_SEAT_WAIT_MS } from '../../shared/attempts'
import { nextSession } from '../../shared/feature-job'
import { MAX_FEEDBACK_ENTRIES } from '../../shared/rounds'
import { lineageOf, type LineageAnswer, type LineageJob } from '../../shared/round-lineage'
import { countReviewBrain, oneRungAbove } from '../../shared/review'
import { criteriaOf } from '../../shared/review-checklist'
import { AUTO_RETRIES, OWNER_STOPPED, OWNER_STOPPED_NO_WORDS, OWNER_STOPPED_REVIEW_HEAD, retriesItself, reviewCapped, reviewInfraClass, reviewRetryDelayMs, reviewRunsAllowed, type ReviewInfra } from '../../shared/review-infra'
import { SELF_CHECK_DEFERRED, SELF_CHECK_MARK, SELF_CHECK_NOTE, selfCheckResend } from '../../shared/self-check'
import { isStopSentence } from '../../shared/stop-cause'

export const ARCHIVE_FILE = 'tasks-done.jsonl'
const CAPPED_FILE = 'capped-drops.json'

export function onItsBrain(agent: AgentInfo, task: Pick<TaskInfo, 'brain'>): AgentInfo {
  return task.brain && task.brain !== agent.model ? { ...agent, model: task.brain } : agent
}
export const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
export const KEEP_FINISHED = 60

export interface RunFacts {
  firstRound: boolean
  plan: PlanRecord | null
  changedFiles: boolean
}

export interface AgentRunOutcome {
  ok: boolean
  resultText: string
  sessionId?: string
  limited?: boolean
  resetsAt?: number
  stderr?: string
  plan?: PlanRecord | null
  changedFiles?: boolean
  parked?: boolean
  selfCheck?: string
}

export type AgentRun = (agent: AgentInfo, task: TaskInfo, feedback: string | null) => Promise<AgentRunOutcome>

export const MAX_REVISIONS = 3

export const findingKey = (f: Finding): string => f.fingerprint ?? `${f.kind}|${f.text}`
export const overrulableKey = (f: Finding): string | undefined => f.fingerprint

export const INTERRUPTED_NOTE =
  'Damon was closed while you were working on this, so your run was cut off part way. What you had already done is still in the project. Look at what is there before you start: carry on from it, and do not build it a second time. If it turns out the job was already finished, say so in your report instead of redoing it.'

const GONE_AGENT: AgentInfo = {
  id: 'gone',
  name: 'Somebody no longer on the team',
  role: 'This person was removed from the team',
  model: '',
  kind: 'agent',
  createdAt: '1970-01-01T00:00:00.000Z'
}

export interface Overrule {
  taskId: string
  title: string
  agentId: string
  findings: string[]
  why: string
  gate: 'check' | 'reviewer'
}

const TOLD_FILE = 'told.json'

export interface ReviewOutcome {
  satisfied: boolean
  objections: string[]
  criteria?: ReviewRecord['criteria']
  standing: 'review' | 'second-opinion'
  why: string
  reviewerModel: string
  reviewerWhy?: string
  ran: boolean
  limited?: boolean
  resetsAt?: number
  held?: boolean
}

export interface TaskEngineEvents {
  onTaskUpdate: (task: TaskInfo) => void
  onAgentReport: (agent: AgentInfo, task: TaskInfo) => void
  onSignedOff?: (agent: AgentInfo, task: TaskInfo) => void
}

export interface TaskEngineOptions {
  approvedStandards?: () => { id: string; text: string }[]
  parkedDraft?: (task: TaskInfo) => string[]
  selfCheckGap?: (task: TaskInfo, report: string, ran: { changedFiles: boolean }) => string | null
  startBlocker?: (task: TaskInfo) => string | null
  coverageWaits?: (task: TaskInfo) => string[]
  prepareTask?: (task: TaskInfo) => void
  ownerKeepBlocker?: (task: TaskInfo) => string | null
  newTaskIntent?: (title: string, instructions: string, acceptance: string) => TaskInfo['intent']
  completionBlocker?: (task: TaskInfo) => string | null
  onOwnerKept?: (task: TaskInfo) => void
  onFaultAccepted?: (task: TaskInfo, fix: TaskInfo) => void
  processFollowUp?: (task: TaskInfo, gate?: { since: string; objections: readonly string[] }) => { title: string; instructions: string; acceptance: string } | null
  onFollowUpAccepted?: (task: TaskInfo, followUp: TaskInfo) => void
  criteriaConflict?: (task: TaskInfo, since: string) => string[] | null
  onCriteriaAccepted?: (task: TaskInfo) => void
  onAcceptanceBlocked?: (task: TaskInfo, why: string) => void
  featureSessions?: { on(): boolean; note(task: TaskInfo, partial?: string): string }
  onDeferred?: (task: TaskInfo, why: string, began?: boolean) => void
  maxParallel?: number
  roundsOf?: (feedback: string[]) => number
  oneJobPerAgent?: boolean
  hasRoom?: (alreadyRunning: number) => boolean
  roomSentence?: () => string
  fingerprint?: (task: TaskInfo) => ContractStamp[]
  onDrift?: (moved: { task: TaskInfo; files: string[] }[]) => void
  onStuck?: (stuck: { blocked: TaskInfo; behind: TaskInfo; unfixedFault?: true; sharesFiles?: true; cycle?: WaitEdgeKind }[]) => void
  onOwnerless?: (jobs: TaskInfo[]) => void
  onMilestoneDone?: (milestones: string[]) => void
  autopilot?: () => boolean
  onAutopilotWait?: (task: TaskInfo, resumeAt: number) => void
  onReviewInfra?: (task: TaskInfo, cls: string, count: number, retryAt?: number) => void
  smallFixLand?: (task: TaskInfo, why: 'lane' | 'stuck') => Promise<{ ok: true; summary: string } | { ok: false; why: string } | null>
  onReviewCapped?: (task: TaskInfo, cls: string, count: number) => boolean | void
  onAutopilotResumed?: () => void
  activateSubmanager?: (agent: AgentInfo, task: TaskInfo, feedback: string | null) => void
  overBudget?: (agent: AgentInfo) => boolean
  onBudgetReached?: (agent: AgentInfo) => void
  held?: (agentId: string) => boolean
  verify?: (agent: AgentInfo, task: TaskInfo, stderr: string, run: RunFacts) => Verdict | null
  onOverruled?: (overrule: Overrule) => void
  onApproved?: (task: TaskInfo) => void
  reviewDepth?: (task: TaskInfo) => ReviewDepth
  checkDocuments?: (task: TaskInfo) => Promise<Finding[]>
  review?: (agent: AgentInfo, task: TaskInfo, round: number, previous: string[]) => Promise<ReviewOutcome>
  stopReview?: (task: TaskInfo) => void
  onArrival?: (task: TaskInfo, arrival: Arrival) => void
  onRejected?: (agent: AgentInfo, task: TaskInfo, objections: string[]) => void
  onPlanHabit?: (agent: AgentInfo, task: TaskInfo, late: number) => void
}

export type TaskResult = TaskInfo | { error: string }

const archiveIndex = new Map<string, { key: string; at: Map<string, [number, number]> }>()
function indexArchive(file: string): { key: string; at: Map<string, [number, number]> } | null {
  let key: string
  try { const s = statSync(file); key = `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { return null }
  const known = archiveIndex.get(file)
  if (known && known.key === key) return known
  let buf: Buffer
  try { buf = readFileSync(file) } catch { return null }
  const at = new Map<string, [number, number]>()
  let start = 0
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = buf.length
    if (end > start) {
      const text = buf.toString('utf8', start, end)
      if (text.trim()) {
        try {
          const id = (JSON.parse(text) as { id?: unknown }).id
          if (typeof id === 'string') at.set(id, [start, end - start])
        } catch {}
      }
    }
    start = end + 1
  }
  const index = { key, at }
  archiveIndex.set(file, index)
  return index
}

const STUCK_SMALL: ReadonlySet<string> = new Set(['time', 'silence', 'ceiling'])

export class TaskEngine {
  private startBlocker?: TaskEngineOptions['startBlocker']
  private coverageWaits?: TaskEngineOptions['coverageWaits']
  private approvedStandards?: TaskEngineOptions['approvedStandards']
  private parkedDraft?: TaskEngineOptions['parkedDraft']
  private selfCheckGap?: TaskEngineOptions['selfCheckGap']
  private prepareTask?: TaskEngineOptions['prepareTask']
  private ownerKeepBlocker?: TaskEngineOptions['ownerKeepBlocker']
  private newTaskIntent?: TaskEngineOptions['newTaskIntent']
  private completionBlocker?: (task: TaskInfo) => string | null
  private onOwnerKept?: (task: TaskInfo) => void
  private onFaultAccepted?: (task: TaskInfo, fix: TaskInfo) => void
  private processFollowUp?: TaskEngineOptions['processFollowUp']
  private gateObjections = new Map<string, string[]>()
  private gateFollow = new Map<string, { title: string; instructions: string; acceptance: string }>()
  private onFollowUpAccepted?: TaskEngineOptions['onFollowUpAccepted']
  private criteriaConflict?: TaskEngineOptions['criteriaConflict']
  private onCriteriaAccepted?: TaskEngineOptions['onCriteriaAccepted']
  private onAcceptanceBlocked?: TaskEngineOptions['onAcceptanceBlocked']
  private featureSessions?: TaskEngineOptions['featureSessions']
  private onDeferred?: (task: TaskInfo, why: string, began?: boolean) => void
  private file: string
  private tasks: TaskInfo[]
  private running = new Set<string>()
  private oneJobPerAgent = false
  activeTaskIds(): string[] { return [...this.running] }
  private umbrellas = new Set<string>()

  private isLive(taskId: string): boolean {
    return this.running.has(taskId) || this.umbrellas.has(taskId) || this.activeGates.has(taskId)
  }
  private pendingFeedback = new Map<string, string>()
  private activeGates = new Map<string, symbol>()
  private pendingGateResume = new Set<string>()
  private maxParallel: number
  private hasRoom?: (alreadyRunning: number) => boolean
  private roomSentence?: () => string
  private roomTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxRounds = MAX_REVISIONS
  private isAutopilot: () => boolean
  private onAutopilotWait?: (task: TaskInfo, resumeAt: number) => void
  private onReviewInfra?: (task: TaskInfo, cls: string, count: number, retryAt?: number) => void
  private smallFixLand?: (task: TaskInfo, why: 'lane' | 'stuck') => Promise<{ ok: true; summary: string } | { ok: false; why: string } | null>
  private onReviewCapped?: (task: TaskInfo, cls: string, count: number) => boolean | void
  private onAutopilotResumed?: () => void
  private activateSubmanager?: (agent: AgentInfo, task: TaskInfo, feedback: string | null) => void
  private isOverBudget: (agent: AgentInfo) => boolean
  private onBudgetReached?: (agent: AgentInfo) => void
  private isHeld: (agentId: string) => boolean
  private budgetNotified = new Set<string>()
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = new Set<string>()
  private verifyRun?: (agent: AgentInfo, task: TaskInfo, stderr: string, run: RunFacts) => Verdict | null
  private changed = new Map<string, boolean>()
  private onOverruled?: (overrule: Overrule) => void
  private onApproved?: (task: TaskInfo) => void
  private reviewDepth?: (task: TaskInfo) => ReviewDepth
  private roundsOf?: (feedback: string[]) => number
  private reviewRun?:(agent: AgentInfo, task: TaskInfo, round: number, previous: string[]) => Promise<ReviewOutcome>
  private stopReview?: (task: TaskInfo) => void
  private checkDocuments?: (task: TaskInfo) => Promise<Finding[]>
  private onArrival?: (task: TaskInfo, arrival: Arrival) => void
  private fingerprint?: (task: TaskInfo) => ContractStamp[]
  private onDrift?: (moved: { task: TaskInfo; files: string[] }[]) => void
  private onStuck?: (stuck: { blocked: TaskInfo; behind: TaskInfo; unfixedFault?: true; sharesFiles?: true; cycle?: WaitEdgeKind }[]) => void
  private onOwnerless?: (jobs: TaskInfo[]) => void
  private toldOwnerless = new Set<string>()
  private onMilestoneDone?: (milestones: string[]) => void
  private toldCritic = new Set<string>()
  private toldStuck = new Set<string>()
  private onRejected?: (agent: AgentInfo, task: TaskInfo, objections: string[]) => void
  private onPlanHabit?: (agent: AgentInfo, task: TaskInfo, late: number) => void
  private toldPlanHabit = new Set<string>()

  constructor(
    stateDir: string,
    private roster: RosterStore,
    private run: AgentRun,
    private events: TaskEngineEvents,
    opts?: TaskEngineOptions
  ) {
    this.file = join(stateDir, 'tasks.json')
    this.startBlocker = opts?.startBlocker
    this.coverageWaits = opts?.coverageWaits
    this.approvedStandards = opts?.approvedStandards
    this.parkedDraft = opts?.parkedDraft
    this.selfCheckGap = opts?.selfCheckGap
    this.prepareTask = opts?.prepareTask
    this.ownerKeepBlocker = opts?.ownerKeepBlocker
    this.newTaskIntent = opts?.newTaskIntent
    this.completionBlocker = opts?.completionBlocker
    this.maxParallel = opts?.maxParallel ?? 3
    this.oneJobPerAgent = opts?.oneJobPerAgent ?? false
    this.hasRoom = opts?.hasRoom
    this.roomSentence = opts?.roomSentence
    this.onOverruled = opts?.onOverruled
    this.onApproved = opts?.onApproved
    this.onOwnerKept = opts?.onOwnerKept
    this.onFaultAccepted = opts?.onFaultAccepted
    this.processFollowUp = opts?.processFollowUp
    this.onFollowUpAccepted = opts?.onFollowUpAccepted
    this.criteriaConflict = opts?.criteriaConflict
    this.onCriteriaAccepted = opts?.onCriteriaAccepted
    this.onAcceptanceBlocked = opts?.onAcceptanceBlocked
    this.featureSessions = opts?.featureSessions
    this.onDeferred = opts?.onDeferred
    this.isAutopilot = opts?.autopilot ?? (() => false)
    this.onAutopilotWait = opts?.onAutopilotWait
    this.onReviewInfra = opts?.onReviewInfra
    this.smallFixLand = opts?.smallFixLand
    this.onReviewCapped = opts?.onReviewCapped
    this.onAutopilotResumed = opts?.onAutopilotResumed
    this.activateSubmanager = opts?.activateSubmanager
    this.isOverBudget = opts?.overBudget ?? (() => false)
    this.onBudgetReached = opts?.onBudgetReached
    this.isHeld = opts?.held ?? (() => false)
    this.verifyRun = opts?.verify
    this.reviewDepth = opts?.reviewDepth
    this.roundsOf = opts?.roundsOf
    this.reviewRun = opts?.review
    this.stopReview = opts?.stopReview
    this.checkDocuments = opts?.checkDocuments
    this.onArrival = opts?.onArrival
    this.fingerprint = opts?.fingerprint
    this.onDrift = opts?.onDrift
    this.onStuck = opts?.onStuck
    this.onOwnerless = opts?.onOwnerless
    this.onMilestoneDone = opts?.onMilestoneDone
    this.onRejected = opts?.onRejected
    this.onPlanHabit = opts?.onPlanHabit
    this.tasks = readJson<TaskInfo[]>(this.file, [])
    const told = readJson<{ stuck?: string[]; critic?: string[]; planHabit?: string[] }>(join(dirname(this.file), TOLD_FILE), {})
    this.toldPlanHabit = new Set(told.planHabit ?? [])
    this.toldStuck = new Set(told.stuck ?? [])
    this.toldCritic = new Set(told.critic ?? [])
    let dirty = false
    for (const task of this.tasks) {
      if (task.status === 'paused') {
        task.status = 'queued'
        dirty = true
      } else if (task.status === 'working') {
        task.status = 'queued'
        task.interrupted = true
        task.updatedAt = new Date().toISOString()
        task.attempts = [...(task.attempts ?? []), { cls: 'restart', at: task.updatedAt }]
        const objection = task.feedback.at(-1)
        this.pendingFeedback.set(task.id, objection ? `${INTERRUPTED_NOTE}\n\nThe latest revision feedback still applies:\n${objection}` : INTERRUPTED_NOTE)
        dirty = true
      } else if (task.status === 'reviewing') {
        task.status = 'review'
        task.gatePending = true
        task.updatedAt = new Date().toISOString()
        dirty = true
      } else if (task.gatePending && task.status !== 'review') {
        delete task.gatePending
        dirty = true
      } else if ((task.status === 'queued' || task.status === 'revising') && task.selfCheckResend) {
        this.pendingFeedback.set(task.id, task.selfCheckResend)
      } else if ((task.status === 'queued' || task.status === 'revising') && task.parkAnswer) {
        this.pendingFeedback.set(task.id, task.parkAnswer)
      } else if (task.status === 'revising') {
        const latest = task.feedback[task.feedback.length - 1]
        if (latest) this.pendingFeedback.set(task.id, latest)
      }
    }
    if (dirty) this.save()
    this.archiveFinished()
    if (this.tasks.some((t) => t.notBefore)) this.scheduleResume()
  }

  nudge(): void {
    this.pump()
  }

  quiesce(): void {
    for (const id of this.running) this.stopped.add(id)
  }

  dispose(): void {
    this.quiesce()
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    if (this.roomTimer) {
      clearTimeout(this.roomTimer)
      this.roomTimer = null
    }
  }

  stopRunning(agentId?: string): TaskInfo[] {
    const hit = this.tasks.filter(
      (t) => t.status === 'working' && (agentId === undefined || t.agentId === agentId)
    )
    for (const t of hit) {
      t.status = 'failed'
      t.result = 'You stopped this before it finished.'
      t.updatedAt = new Date().toISOString()
      this.running.delete(t.id)
      this.umbrellas.delete(t.id)
      this.stopped.add(t.id)
      this.touch(t)
    }
    const cut = agentId === undefined ? this.tasks.filter((t) => t.status === 'reviewing') : []
    for (const t of cut) {
      t.status = 'review'
      t.gatePending = true
      t.updatedAt = new Date().toISOString()
      this.running.delete(t.id)
      this.stopped.add(t.id)
      this.touch(t)
    }
    if (hit.length + cut.length > 0) this.save()
    return hit
  }

  rememberSession(taskId: string, sessionId: string): void {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task || task.status !== 'working' || task.sessionId === sessionId) return
    task.sessionId = sessionId
    this.save()
  }

  takeInterrupted(): TaskInfo[] {
    const hit = this.tasks.filter((t) => t.interrupted === true)
    if (hit.length === 0) return []
    for (const t of hit) delete t.interrupted
    this.save()
    return hit.map((t) => ({ ...t, interrupted: true }))
  }

  feedbackFor(taskId: string): string | null {
    return this.pendingFeedback.get(taskId) ?? null
  }

  list(): TaskInfo[] {
    return [...this.tasks]
  }

  get(taskId: string): TaskInfo | undefined {
    const live = this.tasks.find((t) => t.id === taskId)
    if (live) return live
    return this.archived(taskId)
  }

  restoreArchived(taskId: string): TaskInfo | undefined {
    const live = this.tasks.find((t) => t.id === taskId)
    if (live) return live
    const stored = this.archived(taskId, true)
    if (!stored) return undefined
    const { dropped: _dropped, droppedAt: _droppedAt, ...rest } = stored as TaskInfo & { dropped?: string; droppedAt?: string }
    const task: TaskInfo = { ...rest, status: 'approved', updatedAt: new Date().toISOString() }
    this.tasks.push(task)
    this.save()
    this.touch(task)
    return task
  }

  cappedJob(taskId: string): TaskInfo | undefined { return this.get(taskId) ?? this.archived(taskId, true) }
  get maxRevisionRounds(): number { return this.maxRounds }
  private roundsUsed(task: TaskInfo): number { const feedback = task.feedback.filter(f => typeof f !== 'string' || !f.startsWith(CODE_SEND_BACK)); return (this.roundsOf ? this.roundsOf(feedback) : feedback.length) + (task.lineage?.rounds ?? 0) }
  private feedbackRounds(feedback: string[]): number { return this.roundsOf ? this.roundsOf(feedback) : feedback.length }
  private readCapped(): { list: unknown[]; corrupt: boolean } {
    const file = join(dirname(this.file), CAPPED_FILE)
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return { list: [], corrupt: false } }
    try { const raw: unknown = JSON.parse(text); return Array.isArray(raw) ? { list: raw, corrupt: false } : { list: [], corrupt: true } } catch { return { list: [], corrupt: true } }
  }
  private cappedJobs(): LineageJob[] {
    const live = this.tasks.filter(t => (t.status !== 'approved' && (t.lineage?.pastCap ?? 0) > 0) || this.roundsUsed(t) >= this.maxRounds && (t.status === 'failed' || t.status === 'escalated' || ((t.status === 'review' || t.status === 'reviewing') && t.review?.satisfied === false && !t.review.overruledWhy)))
    const cutoff = Date.now() - 14 * 24 * 60 * 60_000
    const saved = this.readCapped().list.filter((r): r is LineageJob & { droppedAt: string } => !!r && typeof (r as LineageJob).id === 'string' && Array.isArray((r as LineageJob).feedback) && Date.parse((r as { droppedAt: string }).droppedAt) >= cutoff)
    return [...live, ...saved.filter(r => !live.some(l => l.id === r.id))]
  }
  lineageFor(input: { continuesFrom?: string; steppedUpFrom?: string; writes?: string[] }): LineageAnswer {
    try { return lineageOf(input, id => this.get(id) ?? this.archived(id, true), this.cappedJobs(), f => this.feedbackRounds(f), this.maxRounds) }
    catch { return { rounds: 0, pastCap: 0, root: null, from: null, needsOwner: false, sendBacks: 0 } }
  }
  private atCeiling(task: TaskInfo): boolean { return this.roundsOf !== undefined && task.feedback.length >= MAX_FEEDBACK_ENTRIES }
  roundsUsedBy(taskId: string): number {
    const task = this.get(taskId) ?? this.archived(taskId, true)
    return task ? this.roundsUsed(task) : 0
  }
  steppedUpAlready(fromTaskId: string): boolean {
    if (this.tasks.some(t => t.steppedUpFrom === fromTaskId)) return true
    try { return readFileSync(join(dirname(this.file), ARCHIVE_FILE), 'utf8').includes(`"steppedUpFrom":"${fromTaskId}"`) } catch { return false }
  }

  archived(taskId: string, evenDropped = false): TaskInfo | undefined {
    const file = join(dirname(this.file), ARCHIVE_FILE)
    const index = indexArchive(file)
    const where = index?.at.get(taskId)
    if (!where) return undefined
    let text: string
    try {
      const fd = openSync(file, 'r')
      try { const b = Buffer.alloc(where[1]); readSync(fd, b, 0, where[1], where[0]); text = b.toString('utf8') } finally { closeSync(fd) }
    } catch { return undefined }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || (parsed as TaskInfo).id !== taskId) return undefined
    if (!evenDropped && (parsed as { dropped?: unknown }).dropped !== undefined) return undefined
    return parsed as TaskInfo
  }

  assign(
    agentId: string,
    title: string,
    instructions: string,
    acceptance: string,
    creatorId?: string,
    label?: string,
    writes?: string[],
    needs?: string[],
    connections?: string[],
    deliverables?: { ids: string[]; finalizes: boolean; reads?: string[]; intent?: TaskInfo['intent']; critiqueId?: string; assignment?:TaskInfo['assignment']; operationId?: string; route?: TaskInfo['route']; brain?: string; steppedUpFrom?: string; continuesFrom?: string; narrowedBecause?: string; fixes?: string; skills?: TaskInfo['skills']; followsUp?: string; stage?: TaskInfo['stage']; piece?: string; feature?: TaskInfo['feature']; pastCapAllowed?: boolean; pastCapRefused?: boolean; lane?: TaskInfo['lane'] }
  ): TaskResult {
    const agent = this.roster.get(agentId)
    if (!agent) return { error: `No agent with id ${agentId}. Use list_agents to see the roster.` }
    const fixing = deliverables?.fixes ? this.get(deliverables.fixes) : undefined
    if (deliverables?.fixes && (!fixing || !canBeFixed(fixing, this.tasks))) return { error: `No open known fault on job ${deliverables.fixes}, and it is not a job in review that its reviewer refused. "fixes" names the job whose fault this job fixes.` }
    const twin = this.duplicateRefusal(agentId, title)
    if (twin) return twin
    const lin: LineageAnswer = deliverables?.followsUp || deliverables?.fixes
      ? { rounds: 0, pastCap: 0, root: null, from: null, needsOwner: false, sendBacks: 0 }
      : this.lineageFor({ continuesFrom: deliverables?.continuesFrom, steppedUpFrom: deliverables?.steppedUpFrom, writes })
    if (lin.needsOwner && !deliverables?.pastCapAllowed) return { error: deliverables?.pastCapRefused
      ? `This work has already been tried past its revision limit, and the owner said to stop here. Do not assign it again; change what is asked.`
      : `This work has already been tried past its revision limit, and its reviewers' objections were about the work itself. A further try needs the owner's yes: ask him (if a card for it is on his list, wait for his answer), then assign it again, or change what is asked.` }
    const id = randomUUID()
    const wanted = [...new Set([...(needs ?? []), ...(fixing && fixing.status !== 'approved' ? [fixing.id] : [])])].filter((n) => n.trim().length > 0)
    const refused = this.refuseBadNeeds(id, title, wanted)
    if (refused) return refused
    const task: TaskInfo = {
      id,
      agentId,
      title,
      label,
      instructions,
      acceptance: fixing ? `${acceptance}\n- ${fixCriterion(fixing)}` : acceptance,
      writes: fixing?.knownFault?.heldFiles?.length ? [...new Set([...(writes ?? []), ...fixing.knownFault.heldFiles])] : writes,
      reads: deliverables?.reads,
      intent: deliverables?.intent ?? this.newTaskIntent?.(title, instructions, acceptance),
      assignment: deliverables?.assignment,
      critiqueId: deliverables?.critiqueId,
      operationId: deliverables?.operationId,
      needs: wanted.length > 0 ? wanted : undefined,
      connections,
      deliverableIds: deliverables?.ids,
      finalizesDeliverables: deliverables?.finalizes,
      route: deliverables?.route,
      ...(deliverables?.lane ? { lane: deliverables.lane } : {}),
      brain: deliverables?.brain,
      steppedUpFrom: deliverables?.steppedUpFrom,
      ...(deliverables?.continuesFrom ? { continuesFrom: deliverables.continuesFrom } : {}),
      ...(deliverables?.narrowedBecause ? { narrowedBecause: deliverables.narrowedBecause } : {}),
      fixes: deliverables?.fixes,
      ...(lin.root ? { lineage: { rounds: lin.rounds, pastCap: lin.pastCap, root: lin.root, sent: lin.sendBacks } } : {}),
      ...(deliverables?.followsUp ? { followsUp: deliverables.followsUp } : {}),
      ...(deliverables?.stage ? { stage: deliverables.stage } : {}),
      ...(deliverables?.piece ? { piece: deliverables.piece } : {}),
      ...(deliverables?.feature ? { feature: deliverables.feature } : {}),
      ...(deliverables?.skills?.length ? { skills: deliverables.skills } : {}),
      creatorId,
      status: 'queued',
      round: 1,
      feedback: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    this.tasks.push(task)
    this.save()
    this.pump()
    return this.get(task.id)!
  }

  private refuseBadNeeds(id: string, title: string, needs: string[]): { error: string } | null {
    for (const dep of needs) {
      if (!this.tasks.some((t) => t.id === dep)) {
        return {
          error: `No job with id ${dep}, so nothing can wait for it. Check the id, in a swarm, use the short key of a job in the same call, or leave waits_for out.`
        }
      }
    }
    const edges = new Map(this.tasks.map((t) => [t.id, t.needs ?? []]))
    const knot = findKnot(edges, id, needs)
    if (!knot) return null
    const named = knot.map((k) => (k === id ? title : (this.tasks.find((t) => t.id === k)?.title ?? k)))
    return {
      error: `Refusing that: these jobs would wait on each other forever, ${named.join(' → ')}. Take one of those dependencies out.`
    }
  }

  assignMany(
    jobs: {
      agentId: string
      title: string
      instructions: string
      acceptance: string
      creatorId?: string
      label?: string
      writes?: string[]
      reads?: string[]
      milestone?: string
      key?: string
      waits_for?: string[]
      connections?: string[]
      intent?: TaskInfo['intent']
      critiqueId?: string
      deliverableIds?: string[]
      finalizesDeliverables?: boolean
      assignment?:TaskInfo['assignment']
    }[]
  ): TaskInfo[] | { error: string } {
    if (jobs.length === 0) return []
    for (const j of jobs) {
      if (!this.roster.get(j.agentId)) {
        return { error: `No agent with id ${j.agentId}. Use list_agents to see the roster.` }
      }
    }
    const seen = new Set<string>()
    for (const j of jobs) {
      const twin = this.duplicateRefusal(j.agentId, j.title)
      if (twin) return { error: `${twin.error} Nothing in this milestone was created.` }
      const key = `${j.agentId}:${j.title.trim().toLowerCase()}`
      if (seen.has(key)) {
        return {
          error: `Not assigned: “${j.title}” appears twice in this milestone for the same person, who cannot do it twice at once. Nothing was created. Send the set again without the repeat.`
        }
      }
      seen.add(key)
    }
    const ids: string[] = jobs.map(() => randomUUID())
    const needs = resolveKeys(jobs, ids)
    const known = new Set([...this.tasks.map((t) => t.id), ...ids])
    for (let i = 0; i < jobs.length; i++) {
      for (const dep of needs[i]!) {
        if (!known.has(dep)) {
          return {
            error: `“${jobs[i]!.title}” waits for ${dep}, which is neither a key in this call nor the id of a job that exists. Nothing was created. Fix it and send the whole set again.`
          }
        }
      }
    }
    const edges = new Map<string, string[]>(this.tasks.map((t) => [t.id, t.needs ?? []]))
    ids.forEach((id, i) => edges.set(id, needs[i]!))
    const titleOf = (id: string): string => {
      const at = ids.indexOf(id)
      return at >= 0 ? jobs[at]!.title : (this.tasks.find((t) => t.id === id)?.title ?? id)
    }
    for (let i = 0; i < jobs.length; i++) {
      const knot = findKnot(edges, ids[i]!, needs[i]!)
      if (knot) {
        return {
          error: `Refusing that swarm: these jobs would wait on each other forever, ${knot
            .map(titleOf)
            .join(' → ')}. Nothing was created. Take one of those dependencies out and send the whole set again.`
        }
      }
    }
    const now = new Date().toISOString()
    const made: TaskInfo[] = jobs.map((j, i) => ({
      id: ids[i]!,
      agentId: j.agentId,
      title: j.title,
      label: j.label,
      instructions: j.instructions,
      acceptance: j.acceptance,
      writes: j.writes,
      reads: j.reads,
        milestone: j.milestone,
      connections: j.connections,
      intent: j.intent ?? this.newTaskIntent?.(j.title, j.instructions, j.acceptance),
      critiqueId: j.critiqueId,
      deliverableIds: j.deliverableIds,
      finalizesDeliverables: j.finalizesDeliverables,
      assignment: j.assignment,
      needs: needs[i]!.length > 0 ? needs[i]! : undefined,
      creatorId: j.creatorId,
      status: 'queued',
      round: 1,
      feedback: [],
      createdAt: now,
      updatedAt: now
    }))
    this.tasks.push(...made)
    this.save()
    for (const t of made) this.touch(t)
    this.pump()
    return made.map((t) => this.get(t.id)!)
  }

  addNeeds(taskId: string, needs: string[]): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    const wanted = needs.filter((n) => n.trim().length > 0 && n !== taskId)
    if (wanted.length === 0) return task
    const refused = this.refuseBadNeeds(taskId, task.title, wanted)
    if (refused) return refused
    task.needs = [...new Set([...(task.needs ?? []), ...wanted])]
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    this.pump()
    return task
  }

  reviewAgain(taskId: string): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (this.activeGates.has(taskId) || task.gatePending || this.isLive(taskId)) return { error: 'A review of this job is already running.' }
    if (task.status !== 'approved' && task.status !== 'review') return { error: `Task "${task.title}" is ${task.status}; only a finished job can be reviewed again.` }
    if ((this.reviewDepth?.(task) ?? 'none') === 'none') return { error: `"${task.title}" is not a job a reviewer reads.` }
    task.status = 'review'
    task.gatePending = true
    delete task.reviewSkipped
    task.updatedAt = new Date().toISOString()
    this.save(); this.touch(task); this.pump()
    return task
  }

  markReviewedAgain(taskId: string): void {
    const task = this.get(taskId)
    if (!task) return
    task.reviewedAgain = true
    this.save()
  }
  allowReviewAgain(taskId: string): void {
    const task = this.get(taskId)
    if (!task?.reviewedAgain) return
    delete task.reviewedAgain
    this.save()
  }

  widenReads(taskId: string, reads: string[]): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (!['queued', 'revising', 'escalated'].includes(task.status) || this.isLive(taskId)) return { error: `Task "${task.title}" is ${task.status}; only a job that has not started can have its reads widened. A job in review takes add_reads on request_revision.` }
    for (const raw of reads) {
      const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (!path || path.startsWith('/') || path.includes('..') || /[\x00-\x1f:]/.test(path)) continue
      if (!(task.reads ?? []).includes(path)) task.reads = [...(task.reads ?? []), path]
    }
    task.updatedAt = new Date().toISOString()
    this.save(); this.touch(task)
    return task
  }

  checkFix(taskId: string, fixesId: string, alsoNeeds: string[] = []): { error: string } | null {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (!['queued', 'revising', 'escalated'].includes(task.status) || task.gatePending || this.isLive(taskId)) return { error: `Task "${task.title}" is ${task.status}; only a job that has not started, or waits for another round, can become a fix.` }
    if (task.fixes) return { error: `"${task.title}" already fixes job ${task.fixes}.` }
    if (task.feature) return { error: 'A fix is an ordinary job, never a feature job.' }
    if (fixesId === taskId) return { error: 'A job cannot fix itself.' }
    const target = this.get(fixesId)
    if (!target || !canBeFixed(target, this.tasks)) return { error: `No open known fault on job ${fixesId}, and it is not a job in review that its reviewer refused. "fixes" names the job whose fault this job fixes.` }
    const wait = [...alsoNeeds, ...(target.status !== 'approved' && !(task.needs ?? []).includes(target.id) ? [target.id] : [])]
    return wait.length ? this.refuseBadNeeds(taskId, task.title, wait) : null
  }
  checkAmend(taskId: string, change: { waitFor?: string[]; replacePrerequisite?: { producerId: string; files: string[]; reason: string }; addReads?: string[]; fixes?: string; criteria?: { id: string; text?: string }[]; resumeWhy?: string }): { error: string } | null {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (change.criteria || change.resumeWhy) { const bad = this.checkCriteria(taskId, change.criteria ?? [], change.resumeWhy); if (bad) return bad }
    const wanted = (change.waitFor ?? []).filter(n => n.trim().length > 0 && n !== taskId)
    if (change.replacePrerequisite) {
      const r = change.replacePrerequisite
      if (!['queued', 'escalated'].includes(task.status) || this.isLive(taskId)) return { error: 'Only work that has not started can have its prerequisite replaced.' }
      if (!task.needs?.includes(r.producerId) || !r.files.length || !r.reason.trim()) return { error: 'Name the existing prerequisite, reviewed replacement files and why they satisfy it.' }
    }
    if (change.addReads?.length && (!['queued', 'revising', 'escalated'].includes(task.status) || this.isLive(taskId))) return { error: `Task "${task.title}" is ${task.status}; only a job that has not started can have its reads widened.` }
    if (change.fixes) return this.checkFix(taskId, change.fixes, wanted)
    return wanted.length ? this.refuseBadNeeds(taskId, task.title, wanted) : null
  }
  makeFix(taskId: string, fixesId: string): TaskResult {
    const refused = this.checkFix(taskId, fixesId)
    if (refused) return refused
    const task = this.get(taskId)!, target = this.get(fixesId)!
    if (target.status !== 'approved') task.needs = [...new Set([...(task.needs ?? []), target.id])]
    task.fixes = target.id
    if (task.status !== 'revising') this.widenForHeldDraft(task)
    task.acceptance = `${task.acceptance}
- ${fixCriterion(target)}`
    task.updatedAt = new Date().toISOString()
    this.save(); this.touch(task); this.pump()
    return this.get(taskId)!
  }

  queueInputUpdate(taskId: string, key: string, feedback: string): void {
    const task = this.get(taskId)
    if (!task || task.inputUpdates?.includes(key) || task.pendingInputs?.some(p => p.key === key)) return
    task.pendingInputs = [...(task.pendingInputs ?? []), { key, feedback }]
    this.save()
    this.pump()
  }
  noteInputChange(taskId: string, key: string): boolean {
    const task = this.get(taskId)
    if (!task || task.inputUpdates?.includes(key) || task.pendingInputs?.some(p => p.key === key)) return false
    task.inputUpdates = [...(task.inputUpdates ?? []), key]
    this.save()
    return true
  }

  observeInput(taskId: string, stamp: { file: string; hash: string }): void {
    const task = this.tasks.find(t => t.id === taskId)
    if (!task?.workBasis || task.status !== 'working') return
    if (!task.workBasis.files.some(f => f.file === stamp.file)) task.workBasis.files.push({ ...stamp, observed: true })
    if (!(task.reads ?? []).includes(stamp.file)) {
      task.reads = [...(task.reads ?? []), stamp.file]
      task.observedReads = [...new Set([...(task.observedReads ?? []), stamp.file])]
    }
    this.save()
  }

  requestRevision(taskId: string, feedback: string, addReads: string[] = []): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (this.activeGates.has(taskId) || task.gatePending) return { error: 'The current review must finish before this job can be revised.' }
    if (task.status !== 'review' && task.status !== 'failed' && task.status !== 'escalated') {
      return { error: `Task "${task.title}" is ${task.status}; only tasks in review (or failed, or handed back) can be revised.` }
    }
    if (this.atCeiling(task)) return { error: `Not sent back: "${task.title}" holds ${task.feedback.length} entries of feedback (${this.roundsUsed(task)} of them send-backs, the rest Damon's own notes). Deal with it yourself, or explain the situation honestly to the user.` }
    const spent = this.featureSpent(task)
    if (spent) return { error: spent }
    if (this.roundsUsed(task) >= this.maxRounds) {
      return {
        error: `Revision limit (${this.maxRounds}) reached for "${task.title}". Fix the remaining issues yourself, or explain the situation honestly to the user.${task.brain || task.steppedUpFrom || !oneRungAbove(this.roster.get(task.agentId)?.model ?? '') ? '' : ` Or close it and give the work to the same person again with step_up_from set to ${task.id}: that one job runs one brain above theirs, once (C425).`}${task.lineage?.pastCap ? ` This work was already tried ${task.lineage.pastCap} time(s) past its limit; another try needs the owner if the objections are about the work.` : ''}`
      }
    }
    task.feedback.push(feedback)
    delete task.parkedFor
    task.status = 'revising'
    delete task.reviewedAgain
    delete task.holdRound
    if (task.feature) task.feature = { ...task.feature, sessions: 0 }
    for (const raw of addReads) {
      const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (!path || path.startsWith('/') || path.includes('..') || /[\x00-\x1f:]/.test(path)) continue
      if (!(task.reads ?? []).includes(path)) task.reads = [...(task.reads ?? []), path]
    }
    delete task.review
    delete task.verification
    delete task.reviewSkipped
    task.updatedAt = new Date().toISOString()
    delete task.selfCheckResend
    this.pendingFeedback.set(task.id, feedback)
    const author = this.roster.get(task.agentId)
    if (author && feedback.trim().length > 0) this.onRejected?.(author, task, [feedback.trim()])
    this.save()
    this.touch(task)
    this.pump()
    return task
  }

  approveByOwner(taskId: string, by: 'owner' | 'damon' = 'owner'): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (this.activeGates.has(taskId) || task.gatePending) return { error: 'The current review must finish before this job can be approved.' }
    if (task.status !== 'review' || !task.review?.disputed) return { error: `Task "${task.title}" is not waiting on the owner.` }
    const who = task.review.decidedBy === 'owner' ? 'owner' : by
    task.review = { ...task.review, accepted: undefined, overruledWhy: `${who === 'owner' ? 'The owner kept it' : 'Damon settled it itself'}. Damon's reason: ${task.review.disputed}`, decidedBy: who }
    if (task.review.knownFault) task.knownFault = { objection: task.review.objection ?? 'The reviewer did not say what was wrong.', keptAt: new Date().toISOString() }
    this.save()
    this.onOwnerKept?.({ ...task })
    const needBlock = this.completionBlocker?.(task)
    if (needBlock) return { error: needBlock }
    task.status = 'approved'
    this.onApproved?.({ ...task })
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    this.pump()
    return task
  }

  drop(taskId: string, why: string): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    const waitingToRevise = task.status === 'revising' && !this.isLive(taskId)
    if (task.status !== 'queued' && task.status !== 'failed' && task.status !== 'escalated' && task.status !== 'review' && !waitingToRevise) {
      return { error: `Task "${task.title}" is ${task.status}; only a job that has not started, one that failed or was escalated, or one finished and waiting for a look, can be dropped. Wait for it to finish, or send it back with request_revision.` }
    }
    if (task.status === 'review' && this.activeGates.has(taskId)) return { error: `Task "${task.title}" is being reviewed right now; wait for the review to finish before dropping it.` }
    delete task.parkedFor
    try {
      appendFileSync(join(dirname(this.file), ARCHIVE_FILE), JSON.stringify({ ...task, dropped: why, droppedAt: new Date().toISOString() }) + '\n', 'utf8')
      archiveIndex.delete(join(dirname(this.file), ARCHIVE_FILE))
    } catch {
      return { error: `Task "${task.title}" could not be written to the archive, so it was not dropped.` }
    }
    if (this.roundsUsed(task) >= this.maxRounds || (task.lineage?.pastCap ?? 0) > 0) {
      try {
        const { list, corrupt } = this.readCapped()
        if (corrupt) { try { copyFileSync(join(dirname(this.file), CAPPED_FILE), join(dirname(this.file), `capped-drops.corrupt-${Date.now()}.json`)) } catch {} }
        list.push({ id: task.id, writes: task.writes ?? [], feedback: task.feedback, lineage: { rounds: task.lineage?.rounds ?? 0, pastCap: task.lineage?.pastCap ?? 0, root: task.lineage?.root ?? task.id, sent: task.lineage?.sent ?? task.lineage?.rounds ?? 0 }, droppedAt: new Date().toISOString() })
        writeJson(join(dirname(this.file), CAPPED_FILE), list.slice(-100))
      } catch {}
    }
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.save()
    this.touch({ ...task, status: 'failed', result: `Dropped: ${why}` })
    this.pump()
    return task
  }

  private recordOverrule(task: TaskInfo, found: Finding[], reason: string): void {
    const keys = [...new Set([...(task.verification?.overruledKeys ?? []), ...found.map(overrulableKey).filter((k): k is string => Boolean(k))])]
    task.verification = { ...task.verification!, overruledWhy: reason, overruledKeys: keys }
    this.save()
    this.onOverruled?.({ taskId: task.id, title: task.title, agentId: task.agentId, findings: found.map((f) => f.text), why: reason, gate: 'check' })
  }

  private cappedRefusal(task: TaskInfo): { error: string } | null {
    const infra = task.review?.ran === false ? task.review.infra : undefined
    if (!infra || !reviewCapped(infra)) return null
    if (infra.carded !== infra.count) this.raiseCapCard(task, infra)
    if (infra.cls === OWNER_STOPPED) return { error: `Not approved and not run again: the owner stopped the review of "${task.title}", so nobody reviewed its draft. It waits on his card (keep it after reading it, send it back, or try the review again). Wait for his answer; do not approve again.` }
    if (infra.carded !== infra.count) return { error: `Not approved and not run again: the independent review of "${task.title}" did not finish ${infra.count} times, which is every run Damon allows. Damon could not put its card on the owner's list, so ask him in the chat whether to keep it after reading it, send it back, or try the review again.` }
    return { error: `Not approved and not run again: the independent review of "${task.title}" did not finish ${infra.count} times, which is every run Damon allows, so Damon stopped and put one card on the owner's list (keep it after reading it, send it back, or try the review again). Wait for his answer; do not approve again.` }
  }

  private raiseCapCard(task: TaskInfo, infra: ReviewInfra): void {
    let added: boolean | void = false
    try { added = this.onReviewCapped?.(task, infra.cls, infra.count) } catch { added = false }
    if (added !== false && this.onReviewCapped) { infra.carded = infra.count; this.save() }
  }

  ownerRetriesReview(taskId: string): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    const infra = task.review?.ran === false ? task.review.infra : undefined
    if (task.status !== 'review' || !infra) return { error: `"${task.title}" is not waiting on a review that could not finish.` }
    if (this.activeGates.has(taskId) || task.gatePending || this.isLive(taskId)) return { error: 'A review of this job is already running.' }
    infra.ownerAgain = (infra.ownerAgain ?? 0) + 1
    delete task.notBefore
    this.regate(task)
    return task
  }

  ownerKeepsUnreviewed(taskId: string): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (task.status !== 'review' || task.review?.ran !== false || !task.review.infra) return { error: `"${task.title}" is not waiting on a review that could not finish.` }
    task.review = { ...task.review, disputed: task.review.infra.cls === OWNER_STOPPED ? 'The owner stopped the independent review, read the draft himself and kept it.' : `The independent review could not finish (${task.review.infra.count} tries); the owner read the draft himself and kept it.` }
    return this.approveByOwner(taskId, 'owner')
  }

  cancelReview(taskId: string, o: { then: 'drop' | 'back' | 'approve'; why: string; by: 'owner' | 'manager' }): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    const why = o.why.trim()
    if (!why) return { error: "Quote the owner's words that asked for this, so the record shows it was his call." }
    if (!this.activeGates.has(taskId) && !task.gatePending) return { error: `"${task.title}" is not being reviewed now; drop it, send it back or approve it directly.` }
    this.activeGates.delete(taskId)
    this.running.delete(taskId)
    try { this.stopReview?.(task) } catch {}
    delete task.gatePending
    delete task.notBefore
    delete task.limitWait
    if (task.status === 'reviewing') task.status = 'review'
    task.review = undefined
    task.reviewSkipped = why
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    if (o.then === 'drop') return this.drop(taskId, why)
    if (o.then === 'back') {
      const said = why === OWNER_STOPPED_NO_WORDS ? '' : ` His words: ${why}`
      const feedback = `${OWNER_STOPPED_REVIEW_HEAD}${said}\n\nLook at your draft again against the brief, change what needs changing, and report back.`
      task.status = 'revising'
      delete task.reviewedAgain
      delete task.selfCheckResend
      task.holdRound = true
      task.parkAnswer = feedback
      this.pendingFeedback.set(task.id, feedback)
      task.updatedAt = new Date().toISOString()
      this.save()
      this.touch(task)
      this.pump()
      return task
    }
    const infra: ReviewInfra = { cls: OWNER_STOPPED, count: 0 }
    infra.count = reviewRunsAllowed(infra)
    task.review = { at: new Date().toISOString(), satisfied: false, ran: false, rounds: task.round, standing: 'second-opinion', why: 'The owner stopped the review before it finished.', reviewerModel: '', objection: 'The owner stopped the review before it finished, so nobody reviewed this draft.', depth: this.reviewDepth?.(task) ?? 'full', infra } as ReviewRecord
    delete task.reviewSkipped
    this.save()
    this.raiseCapCard(task, infra)
    this.touch(task)
    if (infra.carded !== infra.count) return { error: `The review of "${task.title}" is stopped, but Damon could not put its Keep card on the owner's list. Ask him in the chat whether to keep it after reading it, send it back, or try the review again.` }
    return task
  }

  approve(taskId: string, despite?: string, knownFault = false): TaskResult {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (this.activeGates.has(taskId)) return { error: 'The current review must finish before this job can be approved.' }
    if (task.status !== 'review') {
      return { error: `Task "${task.title}" is ${task.status}; only tasks in review can be approved.` }
    }
    const unread = !task.review || task.review.ran === false || /^The reviewer could not be run/.test(task.review.objection ?? '')
    const checkStopped = Boolean(task.verification?.findings?.length) && !(despite && task.finalizesDeliverables)
    if (!task.gatePending && unread && !task.reviewSkipped && !checkStopped && (this.reviewDepth?.(task) ?? 'none') !== 'none') {
      const capped = this.cappedRefusal(task)
      if (capped) return capped
      if (task.review?.ran === false && (task.review.refusals ?? 1) >= 2) return { error: `Not approved: the reviewer could not be admitted twice for the same reason on "${task.title}": ${task.review.objection ?? 'no reason recorded'} Damon will not run it again until that reason changes. Fix it (a grant, a file, a name), then approve.` }
      const pending = task.verification?.findings ?? []
      const reason = (despite ?? '').trim()
      if (pending.length > 0 && reason && !task.verification?.overruledWhy) this.recordOverrule(task, pending, reason)
      this.regate(task)
      return { error: `Not yet: no reviewer has read "${task.title}". Damon is running the review now; wait for its verdict, and approve after it.` }
    }
    if (task.gatePending) {
      return {
        error: `Not yet. The reviewer had not finished reading "${task.title}" when it was interrupted, and it reads it again on its own before this can be signed off. Wait for its verdict; you will get the report here.`
      }
    }
    const found = task.verification?.findings ?? []
    if (found.length > 0 && !task.verification?.overruledWhy) {
      const reason = (despite ?? '').trim()
      if (reason.length === 0) {
        return {
          error: [
            `Not approved. Damon checked "${task.title}" against what actually happened and they do not match:`,
            ...found.map((f) => `- ${f.text}`),
            '',
            'Send it back with these exact points (request_revision), or check them yourself. If you are certain the check is wrong, approve again with "despite" set to the reason, in one line. That reason is kept and the owner can read it, so it has to be a real one.'
          ].join('\n')
        }
      }
      this.recordOverrule(task, found, reason)
    }

    const review = task.review
    const neverRan = review?.ran === false || (review?.ran === undefined && /^The reviewer could not be run/.test(review?.objection ?? ''))
    if (review && !review.satisfied && neverRan && !review.overruledWhy) {
      if (this.activeGates.has(taskId) || task.gatePending) return { error: `Not yet. The reviewer is reading "${task.title}" now; wait for its verdict.` }
      const capped = this.cappedRefusal(task)
      if (capped) return capped
      if ((review.refusals ?? 1) >= 2) return { error: `Not approved: the reviewer could not be admitted twice for the same reason on "${task.title}": ${review.objection ?? 'no reason recorded'} Damon will not run it again until that reason changes. Fix it (a grant, a file, a name), then approve.` }
      delete review.disputed
      task.gatePending = true
      this.regate(task)
      return { error: `Not approved and not disputed: the reviewer never ran on "${task.title}" (${review.objection ?? 'no reason recorded'}). Damon is running the review now. Wait for its verdict; approving past a review that never happened is not something the owner should be asked to arbitrate.` }
    }
    if (review && !review.satisfied && !review.overruledWhy) {
      if (review.disputed) {
        return {
          error: `Not approved: the reviewer refused "${task.title}" and you disagree, so the owner decides. It is already on their list with your reason next to the objection. Stop here and wait; do not approve again.`
        }
      }
      const reason = (despite ?? '').trim()
      if (review.criteriaConflict?.length) {
        task.review = { ...review, overruledWhy: `Accepted with conflicting criteria under C557: its reviewer found the work correct within criteria that cannot all be met (${review.criteriaConflict.join(' ').slice(0, 1200)}), and the manager accepted it.${reason ? ` Damon's reason: ${reason}` : ''}`, decidedBy: 'manager', accepted: { how: 'criteria' } }
        this.save()
        this.onCriteriaAccepted?.({ ...task })
        const blocked = this.completionBlocker?.(task)
        if (blocked) { this.onAcceptanceBlocked?.({ ...task }, blocked); return { error: blocked } }
        task.status = 'approved'
        this.onApproved?.({ ...task })
        task.updatedAt = new Date().toISOString()
        this.save()
        this.touch(task)
        this.pump()
        return task
      }
      const follow = acceptableAsKnownFault(task) ? (this.gateFollow.get(task.id) ?? this.processFollowUp?.(task) ?? null) : null
      if (follow) {
        const made = this.assign(task.agentId, follow.title, follow.instructions, follow.acceptance, task.creatorId, undefined, task.writes, [task.id], task.connections, { ids: [], finalizes: false, ...(task.reads ? { reads: task.reads } : {}), followsUp: task.id })
        if (!('error' in made)) {
          task.review = { ...review, ...(reason ? { disputed: reason } : {}), overruledWhy: `Accepted with a follow-up under the owner's rule of 4 October 2026: every blocking objection was about process or wording, not about what the work does, and "${made.title}" deals with them.${reason ? ` Damon's reason: ${reason}` : ''}`, decidedBy: 'damon', accepted: { how: 'follow-up', with: made.title } }
          this.save()
          this.onFollowUpAccepted?.({ ...task }, { ...made })
          const blocked = this.completionBlocker?.(task)
          if (blocked) { this.onAcceptanceBlocked?.({ ...task }, blocked); return { error: `${blocked} Its follow-up "${made.title}" waits for this job to be accepted: record what is missing and approve again.` } }
          task.status = 'approved'
          this.onApproved?.({ ...task })
          task.updatedAt = new Date().toISOString()
          this.save()
          this.touch(task)
          this.pump()
          return task
        }
      }
      const objection = review.objection ?? 'The reviewer did not say what was wrong.'
      if (reason.length === 0) {
        const ordering =
          review.standing === 'second-opinion'
            ? `\n\nNote: this was a second opinion rather than a review. ${review.why}`
            : ''
        return {
          error: [
            `Not approved. The reviewer read the work on "${task.title}" and is not satisfied:`,
            `- ${objection}`,
            '',
            'Send it back with those points (request_revision), or deal with them yourself. If you are certain the reviewer is wrong, approve again with "despite" set to the reason, in one line: that does not approve it, it puts the objection and your reason in front of the owner, who decides.' +
              ordering
          ].join('\n')
        }
      }
      const lined = knownFault && acceptableAsKnownFault(task) ? fixLinedUp(task, this.tasks) : undefined
      if (lined) {
        task.review = { ...review, disputed: reason, knownFault: true, overruledWhy: `Accepted as a known fault under the owner's standing rule of 2 October 2026: its fix "${lined.title}" is already lined up. Damon's reason: ${reason}`, decidedBy: 'damon', accepted: { how: 'fault', with: lined.title } }
        task.knownFault = { objection, keptAt: new Date().toISOString() }
        this.save()
        this.onFaultAccepted?.({ ...task }, { ...lined })
        const blocked = this.completionBlocker?.(task)
        if (blocked) { this.onAcceptanceBlocked?.({ ...task }, blocked); return { error: blocked + fixWaitsOn(lined) } }
        task.status = 'approved'
        this.onApproved?.({ ...task })
        task.updatedAt = new Date().toISOString()
        this.save()
        this.touch(task)
        this.pump()
        return task
      }
      const unready = this.ownerKeepBlocker?.(task)
      if (unready) return { error: `Not handed to the owner yet: his Keep could not approve "${task.title}" while ${unready}. Record that evidence (supply_need) from the reviewer's recorded run, then approve again with your reason.${fixWaitsOn(fixLinedUp(task, this.tasks))}` }
      task.review = { ...review, disputed: reason, ...(knownFault ? { knownFault: true as const } : {}) }
      task.updatedAt = new Date().toISOString()
      this.save()
      this.touch(task)
      this.onOverruled?.({
        taskId: task.id,
        title: task.title,
        agentId: task.agentId,
        findings: [objection],
        why: knownFault ? `A real fault, kept now and fixed by a follow-up job: everything that builds on this waits until the fix passes its own review. ${reason}` : reason,
        gate: 'reviewer'
      })
      return {
        error: `Not approved: the reviewer refused "${task.title}" and you disagree, so the owner decides. Your reason is on their list next to the objection; their Keep it approves the job, their Send it back returns it. Stop here and wait; do not approve again.`
      }
    }

    const needBlock = this.completionBlocker?.(task)
    if (needBlock) return { error: needBlock }
    task.status = 'approved'
    this.onApproved?.({ ...task })
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    this.pump()
    this.checkDrift()
    return task
  }

  stuckBehind(): { blocked: TaskInfo; behind: TaskInfo; unfixedFault?: true; sharesFiles?: true; cycle?: WaitEdgeKind }[] {
    const out: { blocked: TaskInfo; behind: TaskInfo; unfixedFault?: true; sharesFiles?: true; cycle?: WaitEdgeKind }[] = []
    for (const task of this.tasks) {
      if (task.status !== 'queued' && task.status !== 'revising') continue
      const dep = this.blockedBy(task)
      if (dep && (dep.status === 'failed' || dep.status === 'escalated')) { out.push({ blocked: task, behind: dep }); continue }
      const fault = heldByFault(task, this.tasks)
      if (fault && !fixLinedUp(fault, this.tasks)) out.push({ blocked: task, behind: fault, unfixedFault: true, ...(task.writes?.length && fault.writes?.length && scopeClash(task.writes, fault.writes).length ? { sharesFiles: true as const } : {}) })
    }
    const opts = { now: Date.now(), coverageWaits: this.coverageWaits, capped: (t: TaskInfo) => this.roundsUsed(t) >= this.maxRounds }
    const dominant = (ring: WaitEdge[]): WaitEdgeKind => (['objection', 'coverage', 'fault'] as const).find(k => ring.some(e => e.kind === k)) ?? 'needs'
    for (const ring of findWaitCycles(this.tasks, opts)) {
      const edge = ring.find(e => e.kind === 'needs') ?? ring.find(e => ['queued', 'revising'].includes(this.get(e.from)?.status ?? '')) ?? ring[0]!
      const blocked = this.get(edge.from), behind = this.get(edge.to)
      if (blocked && behind && !out.some(x => x.blocked.id === blocked.id && x.behind.id === behind.id)) out.push({ blocked, behind, cycle: dominant(ring) })
    }
    return out
  }

  ownerless(): TaskInfo[] {
    return this.tasks.filter(
      (t) => (t.status === 'queued' || t.status === 'revising') && !this.roster.get(t.agentId)
    )
  }

  private checkOwnerless(): void {
    if (!this.onOwnerless) return
    const gone = this.ownerless()
    const live = new Set(gone.map((t) => t.id))
    for (const id of [...this.toldOwnerless]) if (!live.has(id)) this.toldOwnerless.delete(id)
    const fresh = gone.filter((t) => !this.toldOwnerless.has(t.id))
    if (fresh.length === 0) return
    for (const t of fresh) this.toldOwnerless.add(t.id)
    this.onOwnerless(fresh)
  }

  private checkMilestones(): void {
    if (!this.onMilestoneDone) return
    const done = milestonesAtRest(
      this.tasks.map((t) => ({ milestone: t.milestone ?? '', status: t.status }))
    )
    const live = new Set(done)
    for (const name of [...this.toldCritic]) if (!live.has(name)) this.toldCritic.delete(name)
    const fresh = done.filter((name) => !this.toldCritic.has(name))
    if (fresh.length === 0) return
    for (const name of fresh) this.toldCritic.add(name)
    this.saveTold()
    this.onMilestoneDone(fresh)
  }

  private saveTold(): void {
    try { writeJson(join(dirname(this.file), TOLD_FILE), { stuck: [...this.toldStuck], critic: [...this.toldCritic], planHabit: [...this.toldPlanHabit] }) } catch {}
  }

  private checkStuck(): void {
    if (!this.onStuck) return
    const stuck = this.stuckBehind()
    const live = new Set(stuck.map((s) => `${s.blocked.id}:${s.behind.id}`))
    for (const key of [...this.toldStuck]) if (!live.has(key)) this.toldStuck.delete(key)
    const fresh = stuck.filter((s) => !this.toldStuck.has(`${s.blocked.id}:${s.behind.id}`))
    if (fresh.length === 0) return
    for (const s of fresh) this.toldStuck.add(`${s.blocked.id}:${s.behind.id}`)
    this.saveTold()
    this.onStuck(fresh)
  }

  private featureSpent(task: TaskInfo): string | null {
    if (!task.feature || !this.featureSessions?.on()) return null
    const cap = 2 * task.feature.maxSessions
    if (task.feature.sessionsTotal < cap) return null
    return `Not sent back: the feature job "${task.title}" has run all ${task.feature.sessionsTotal} of its ${cap} sessions over its rounds. Its work is kept. Give the fix as an ordinary job with continues_from ${task.id}, or decide with the owner whether the piece is too big or the approach wrong.`
  }

  private objectionOf(task: TaskInfo): string | null {
    return task.feedback.at(-1) ?? null
  }

  private parkForCriteria(task: TaskInfo, why: string, plan?: string): { paused: true } {
    if (plan) task.plan = plan.slice(0, 1800)
    const left = this.parkedDraft?.(task) ?? []
    if (left.length) why = `${why} The run changed files in its copy anyway (${left.slice(0, 10).join(', ')}${left.length > 10 ? ' and more' : ''}), though its plan said it could not meet a criterion. Read that draft with candidates_for_task before you amend.`
    task.status = 'escalated'
    task.escalation = 'manager'
    task.parkedOnce = true
    task.parkedFor = why
    task.result = why
    this.running.delete(task.id)
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    this.events.onAgentReport(this.roster.get(task.agentId) ?? GONE_AGENT, task)
    return { paused: true }
  }

  checkCriteria(taskId: string, changes: { id: string; text?: string }[], resumeWhy?: string): { error: string } | null {
    const task = this.get(taskId)
    if (!task) return { error: `No task with id ${taskId}.` }
    if (!(task.status === 'queued' || (task.status === 'escalated' && task.parkedFor)) || this.isLive(taskId)) return { error: `Task "${task.title}" is ${task.status}; criteria change only on a job that has not started or that Damon parked for its criteria.` }
    if (!changes.length && !resumeWhy?.trim()) return { error: 'Name the criteria to change or drop, or say in resume_why how the worker can meet them.' }
    if (changes.some((c) => !/^j\d{1,2}$/.test(c.id))) return { error: "Only job criteria (j-ids) can be changed; the owner's standards (s-ids) cannot be reworded." }
    const judged = criteriaOf(task.acceptance, this.approvedStandards?.() ?? [])
    const missing = changes.find((c) => !judged.some((j) => j.id === c.id && j.source === 'job'))
    if (missing) return { error: `No criterion ${missing.id} on this job. Its job criteria are ${judged.filter((j) => j.source === 'job').map((j) => j.id).join(', ') || 'none'}.` }
    return null
  }
  amendCriteria(taskId: string, changes: { id: string; text?: string }[], resumeWhy?: string, pump = true): TaskResult {
    const refused = this.checkCriteria(taskId, changes, resumeWhy)
    if (refused) return refused
    const task = this.get(taskId)!
    const judged = criteriaOf(task.acceptance, this.approvedStandards?.() ?? [])
    task.acceptance = judged
      .flatMap((j) => {
        const c = changes.find((x) => x.id === j.id)
        return !c ? [j.text] : c.text?.trim() ? [c.text.trim()] : []
      })
      .map((t) => `- ${t}`)
      .join('\n')
    const wasParked = task.status === 'escalated'
    if (wasParked) {
      task.status = 'queued'
      delete task.escalation
      delete task.parkedFor
      delete task.result
      const left = criteriaOf(task.acceptance, this.approvedStandards?.() ?? [])
      const answer = [
        `${changes.length ? PARK_ANSWER_HEAD : PARK_ANSWERED_HEAD}, after Damon parked it on your plan because the plan said it could not meet a criterion. Nothing has changed in the project yet, and no round was spent: start this job afresh from the brief below, plan first.`,
        changes.length ? `The criteria now are:\n${left.map((c) => `[${c.id}] ${c.text}`).join('\n')}` : 'The criteria are unchanged.',
        resumeWhy?.trim() ? `The manager says: ${resumeWhy.trim()}` : ''
      ].filter(Boolean).join('\n\n')
      task.parkAnswer = answer
      this.pendingFeedback.set(task.id, answer)
      task.holdRound = true
    }
    task.criteriaAmended = [...(task.criteriaAmended ?? []), resumeWhy?.trim() || changes.map((c) => c.id).join(', ')]
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    if (pump) this.pump()
    return task
  }

  private escalateAttempts(task: TaskInfo, why: string): { paused: true } {
    task.status = 'escalated'
    task.escalation = 'manager'
    task.result = `${why} Damon stopped running it again by itself. Decide: split it into smaller jobs, change what it is given, or drop it.`
    this.running.delete(task.id)
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
    this.events.onAgentReport(this.roster.get(task.agentId) ?? GONE_AGENT, task)
    return { paused: true }
  }

  private checkDrift(): void {
    if (!this.fingerprint || !this.onDrift) return
    const moved: { task: TaskInfo; files: string[] }[] = []
    let dirty = false
    const stamped = new Map<string, ContractStamp[]>()
    const fingerprintOnce = (task: TaskInfo): ContractStamp[] => {
      const key = [...(task.reads ?? [])].sort().join('|')
      const hit = stamped.get(key)
      if (hit) return hit
      const fresh = this.fingerprint!(task)
      stamped.set(key, fresh)
      return fresh
    }
    for (const task of this.tasks) {
      if (task.status !== 'approved' || !task.builtOn || task.builtOn.length === 0) continue
      const mine = task.writes ?? []
      const files = driftBetween(task.builtOn, fingerprintOnce(task)).filter(
        (f) => mine.length === 0 || !matchesScope(mine, f)
      )
      if (files.length === 0) continue
      const already = task.drifted ?? []
      const fresh = files.filter((f) => !already.includes(f))
      if (fresh.length === 0) continue
      task.drifted = [...already, ...fresh]
      dirty = true
      this.touch(task)
      moved.push({ task, files: fresh })
    }
    if (dirty) this.save()
    if (moved.length > 0) this.onDrift(moved)
  }

  completeSubmanagerTask(submanagerId: string, report: string): TaskResult {
    const task = this.tasks.find((t) => t.agentId === submanagerId && t.status === 'working')
    if (!task) return { error: 'You have no active assignment to complete.' }
    const agent = this.roster.get(submanagerId)
    if (!agent) return { error: 'Submanager not found.' }
    const live = liveWorkUnder(submanagerId, this.roster.list(), this.tasks)
    if (live > 0) {
      return {
        error: `Your team still has ${live} job${live === 1 ? '' : 's'} open. Wait for them to finish, or send them back, before completing your assignment.`
      }
    }
    task.result = report
    task.status = 'review'
    task.updatedAt = new Date().toISOString()
    this.umbrellas.delete(task.id)
    this.running.delete(task.id)
    this.save()
    this.touch(task)
    this.events.onAgentReport(agent, task)
    this.pump()
    return task
  }

  escalateSubmanagerTask(submanagerId: string, reason: string): TaskResult {
    const task = this.tasks.find((t) => t.agentId === submanagerId && t.status === 'working')
    if (!task) return { error: 'You have no active assignment to escalate.' }
    const agent = this.roster.get(submanagerId)
    if (!agent) return { error: 'Submanager not found.' }
    task.result = reason
    task.status = 'escalated'
    task.escalation = 'owner'
    task.updatedAt = new Date().toISOString()
    this.umbrellas.delete(task.id)
    this.running.delete(task.id)
    this.save()
    this.touch(task)
    this.events.onAgentReport(agent, task)
    this.pump()
    return task
  }

  private pump(): void {
    for (const task of this.tasks) {
      if (!task.pendingInputs?.length || this.isLive(task.id) || task.status === 'reviewing') continue
      const updates = task.pendingInputs
      task.inputUpdates = [...(task.inputUpdates ?? []), ...updates.map(u => u.key)]
      delete task.pendingInputs
      const feedback = updates.map(u => u.feedback).join('\n\n')
      if (task.status !== 'queued' && (this.roundsOf ? task.feedback.length >= MAX_FEEDBACK_ENTRIES : task.feedback.length >= this.maxRounds)) {
        task.result = [task.result, `Not sent back: the revision limit (${this.maxRounds}) is reached. Its manager has to deal with this:`, feedback].filter(Boolean).join('\n\n')
      } else if (task.status !== 'queued' && this.featureSpent(task)) {
        task.result = [task.result, this.featureSpent(task), feedback].filter(Boolean).join('\n\n')
      } else if (task.status !== 'queued') {
        task.status = 'revising'
        delete task.reviewedAgain
        delete task.holdRound
        if (task.feature) task.feature = { ...task.feature, sessions: 0 }
        task.feedback.push(feedback)
        delete task.review
        delete task.verification
        delete task.gatePending
        delete task.selfCheckResend
        this.pendingFeedback.set(task.id, feedback)
      }
      task.updatedAt = new Date().toISOString()
      this.save()
      this.touch(task)
    }
    const now = Date.now()
    const ceilingReached = (agentId: string): boolean => {
      const agent = this.roster.get(agentId)
      if (!agent || !this.isOverBudget(agent)) return false
      if (!this.budgetNotified.has(agentId)) {
        this.budgetNotified.add(agentId)
        this.onBudgetReached?.(agent)
      }
      return true
    }
    for (const t of this.tasks) {
      if (this.running.size >= this.maxParallel) break
      if (t.status !== 'review' || !t.gatePending || this.isHeld(t.agentId)) continue
      if (ceilingReached(t.agentId)) continue
      if (this.hasRoom && !this.hasRoom(this.running.size)) break
      if (this.activeGates.has(t.id)) { this.pendingGateResume.add(t.id); continue }
      if (this.isLive(t.id)) continue
      if (t.notBefore && t.notBefore > Date.now()) continue
      this.regate(t)
    }
    while (this.running.size < this.maxParallel) {
      if (this.hasRoom && !this.hasRoom(this.running.size)) {
        const why = this.roomSentence?.()
        if (why) for (const t of this.tasks) if ((t.status === 'queued' || t.status === 'revising' || (t.status === 'review' && t.gatePending)) && !this.isLive(t.id) && t.waitingFor !== why && (!t.waitingFor || (!this.blockedBy(t) && this.clearToStart(t) === null))) { t.waitingFor = why; this.touch(t) }
        if (!this.roomTimer) {
          this.roomTimer = setTimeout(() => {
            this.roomTimer = null
            this.pump()
          }, 60_000)
        }
        break
      }
      const next = this.tasks.find(
        (t) =>
          (t.status === 'queued' || t.status === 'revising') &&
          !this.isLive(t.id) &&
          (!t.notBefore || t.notBefore <= now) &&
          !this.isHeld(t.agentId) &&
          !ceilingReached(t.agentId) &&
          !this.leadAlreadyBusy(t.agentId) &&
          !(this.oneJobPerAgent && this.agentWorking(t.agentId)) &&
          this.clearToStart(t) === null &&
          this.blockedBy(t) === null
      )
      if (!next) break
      this.start(next)
    }
    this.recordWhatIsWaiting()
    this.checkStuck()
    this.checkOwnerless()
    this.checkMilestones()
    for (const agentId of [...this.budgetNotified]) {
      const agent = this.roster.get(agentId)
      if (!agent || !this.isOverBudget(agent)) this.budgetNotified.delete(agentId)
    }
    this.scheduleResume()
  }

  private recordWhatIsWaiting(): void {
    let dirty = false
    for (const task of this.tasks) {
      if (task.status !== 'queued' && task.status !== 'revising') {
        if (task.waitingFor !== undefined) {
          delete task.waitingFor
          dirty = true
          this.touch(task)
        }
        continue
      }
      const dep = this.isLive(task.id) ? null : this.blockedBy(task)
      const busyLead =
        !dep && !this.isLive(task.id) && this.leadAlreadyBusy(task.agentId)
          ? `“${task.title}” waits: ${this.roster.get(task.agentId)?.name ?? 'that lead'} is already running another slice, and a lead can only do one at a time.`
          : null
      const why = dep
        ? `“${task.title}” waits: it needs “${dep.title}” to be signed off first.`
        : this.isLive(task.id)
          ? null
          : (busyLead ?? this.clearToStart(task) ?? null)
      if ((why ?? undefined) === task.waitingFor) continue
      if (why) task.waitingFor = why
      else delete task.waitingFor
      dirty = true
      this.touch(task)
    }
    if (dirty) this.save()
  }

  private alreadyOut(agentId: string, title: string): TaskInfo | undefined {
    const wanted = title.trim().toLowerCase()
    return this.tasks.find(
      (t) =>
        t.agentId === agentId &&
        t.title.trim().toLowerCase() === wanted &&
        (t.status === 'queued' ||
          t.status === 'working' ||
          t.status === 'revising' ||
          t.status === 'reviewing' ||
          t.status === 'review')
    )
  }

  private duplicateRefusal(agentId: string, title: string): { error: string } | null {
    const twin = this.alreadyOut(agentId, title)
    if (!twin) return null
    const who = this.roster.get(agentId)?.name ?? 'that agent'
    return {
      error: `Not assigned: ${who} already has “${twin.title}” (id ${twin.id}, ${twin.status}). Handing it out again would have them doing it twice at once, in the same folder, overwriting each other. If it looks stalled, look at that job rather than making another one; if it is genuinely wrong, send it back with request_revision.`
    }
  }

  private agentWorking(agentId: string): boolean {
    return this.tasks.some((t) => t.agentId === agentId && t.status === 'working' && this.isLive(t.id))
  }
  private leadAlreadyBusy(agentId: string): boolean {
    if (this.roster.get(agentId)?.kind !== 'submanager') return false
    return this.tasks.some((t) => t.agentId === agentId && this.umbrellas.has(t.id))
  }

  leadWentQuiet(leadId: string): TaskInfo | null {
    const held = this.tasks.find((t) => t.agentId === leadId && this.umbrellas.has(t.id))
    if (!held) return null
    const mine = new Set(this.roster.children(leadId).map((a) => a.id))
    const alive = this.tasks.some((t) => {
      if (!mine.has(t.agentId)) return false
      if (t.status === 'review') return t.creatorId !== leadId
      return (
        t.status === 'working' || t.status === 'queued' || t.status === 'revising' || t.status === 'reviewing'
      )
    })
    return alive ? null : held
  }

  releaseQuietLead(leadId: string): TaskResult {
    const held = this.leadWentQuiet(leadId)
    if (!held) return { error: 'That lead is not holding an assignment with an idle team.' }
    const agent = this.roster.get(leadId)
    if (!agent) return { error: 'Submanager not found.' }
    held.status = 'escalated'
    held.escalation = 'manager'
    held.result = `${agent.name} ended its turn without reporting back, and nothing on its team is running or waiting. The slice has been handed back rather than left in progress for ever. Nobody has said the work is wrong, only that whoever was holding it stopped answering. Check what actually got done, then give it out again.`
    held.updatedAt = new Date().toISOString()
    this.umbrellas.delete(held.id)
    this.save()
    this.touch(held)
    this.events.onAgentReport(agent, held)
    this.pump()
    return held
  }

  blockedBy(task: TaskInfo): TaskInfo | null {
    for (const id of task.needs ?? []) {
      const dep = this.tasks.find((t) => t.id === id)
      if (!dep) {
        const stored = this.archived(id, true)
        if (stored?.status === 'approved') continue
        if (stored) return { ...stored, status: stored.status === 'queued' ? 'escalated' : stored.status }
        return { ...task, id, title: `Missing prerequisite ${id}`, status: 'escalated' }
      }
      if (dep.status !== 'approved') return dep
    }
    const fault = heldByFault(task, this.tasks)
    if (fault) return { ...fault, title: `the fix of the known fault in “${fault.label ?? fault.title}”`, status: 'queued' }
    return null
  }

  releaseFault(taskId: string): TaskResult {
    const task = this.get(taskId)
    if (!task || !faultOpen(task, this.tasks)) return { error: 'There is no open known fault on that job.' }
    task.knownFault = { ...task.knownFault!, releasedAt: new Date().toISOString() }
    task.updatedAt = new Date().toISOString()
    this.save(); this.touch(task); this.pump()
    return task
  }
  holdFaultDraft(taskId: string, candidateId: string, files: string[]): void {
    const task = this.get(taskId)
    if (!task?.knownFault) return
    task.knownFault = { ...task.knownFault, heldDraft: candidateId, heldFiles: [...files] }
    for (const fix of this.tasks) if (fix.fixes === taskId && (fix.status === 'queued' || fix.status === 'escalated')) this.widenForHeldDraft(fix)
    this.save(); this.pump()
  }
  private widenForHeldDraft(fix: TaskInfo): void {
    const held = fix.fixes ? this.get(fix.fixes)?.knownFault?.heldFiles : undefined
    if (held?.length) fix.writes = [...new Set([...(fix.writes ?? []), ...held])]
  }
  supersedeHeldDraft(keptId: string, fixId: string, written: string[]): 'superseded' | 'not-covered' | 'not-passed' | 'none' {
    const kept = this.get(keptId), fix = this.get(fixId)
    if (!kept?.knownFault?.heldDraft || kept.knownFault.supersededBy || !fix || fix.fixes !== keptId) return 'none'
    if (!fixPassed(fix)) return 'not-passed'
    if (!carriesHeldFiles(kept, written)) return 'not-covered'
    kept.knownFault = { ...kept.knownFault, supersededBy: fixId }
    this.save()
    return 'superseded'
  }
  unsupersedeHeldDraft(keptId: string, fixId: string): void {
    const kept = this.get(keptId)
    if (kept?.knownFault?.supersededBy !== fixId) return
    const { supersededBy: _gone, ...rest } = kept.knownFault
    kept.knownFault = rest
    this.save()
  }

  replaceDependency(taskId: string, producerId: string, files: string[], reason: string): TaskResult {
    const task = this.get(taskId)
    if (!task || !['queued', 'escalated'].includes(task.status) || this.isLive(taskId)) return { error: 'Only work that has not started can have its prerequisite replaced.' }
    if (!task.needs?.includes(producerId) || !files.length || !reason.trim()) return { error: 'Name the existing prerequisite, reviewed replacement files and why they satisfy it.' }
    task.needs = task.needs.filter(id => id !== producerId)
    task.reads = [...new Set([...(task.reads ?? []), ...files])]
    task.feedback.push(`Prerequisite ${producerId} replaced by ${files.join(', ')}: ${reason}`)
    task.status = 'queued'; task.updatedAt = new Date().toISOString()
    this.save(); this.touch(task); this.pump(); return task
  }

  private clearToStart(task: TaskInfo): string | null {
    const blocked = this.startBlocker?.(task)
    if (blocked) return blocked
    for (const other of this.tasks.filter(t => this.running.has(t.id))) {
      const reads = task.reads ?? []
      const otherReads = other.workBasis?.files.map(f => f.file) ?? other.reads ?? []
      if (reads.some(f => matchesScope(other.writes ?? [], f)) || otherReads.some(f => matchesScope(task.writes ?? [], f))) return `Waiting for "${other.title}" to release a required input file.`
    }
    const mine = task.writes ?? []
    if (mine.length === 0) return null

    const parentOf = (agentId: string): string | undefined => this.roster.get(agentId)?.parentId
    const running = this.tasks.filter(
      (t) =>
        this.running.has(t.id) &&
        (t.writes ?? []).length > 0 &&
        !sameLineOfCommand(task.agentId, t.agentId, parentOf)
    )
    if (running.length === 0) return null

    const spine = touchesSharedSpine(mine)
    if (spine.length > 0) {
      const blocker = running.find((t) => touchesSharedSpine(t.writes ?? []).length > 0) ?? running[0]!
      return `"${task.title}" changes the shape of the stored information (${spine.join(', ')}), so it starts once the project is quiet. It is waiting for "${blocker.title}" to finish.`
    }
    for (const other of running) {
      const hits = scopeClash(mine, other.writes ?? [])
      if (hits.length > 0) return clashSentence(task.title, other.title, hits)
    }
    return null
  }

  private scheduleResume(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    const now = Date.now()
    const waiting = this.tasks
      .filter((t) => (t.status === 'queued' || t.status === 'revising' || (t.status === 'review' && t.gatePending)) && t.notBefore && t.notBefore > now)
      .map((t) => t.notBefore!)
    if (waiting.length === 0) return
    const soonest = Math.min(...waiting)
    const delay = Math.max(1000, Math.min(soonest - now, 2 ** 31 - 1))
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      let woke = false
      for (const t of this.tasks) {
        if (t.notBefore && t.notBefore <= Date.now() && (t.status === 'queued' || t.status === 'revising' || (t.status === 'review' && t.gatePending))) {
          t.notBefore = undefined
          if (t.limitWait) woke = true
          delete t.limitWait
        }
      }
      this.save()
      this.pump()
      if (woke) this.onAutopilotResumed?.()
    }, delay)
  }

  private start(task: TaskInfo): void {
    delete task.observedReads
    this.widenForHeldDraft(task)
    try { this.prepareTask?.(task) }
    catch (e) {
      task.status = 'escalated'
      task.escalation = 'manager'
      task.result = `Required inputs could not be reserved: ${e instanceof Error ? e.message : String(e)}`
      this.save(); this.touch(task); this.events.onAgentReport(this.roster.get(task.agentId) ?? GONE_AGENT, task)
      return
    }
    const agent = this.roster.get(task.agentId)
    if (!agent) {
      task.status = 'escalated'
      task.escalation = 'manager'
      task.result =
        'The person this was given to is no longer on the team, so it was never started. Nobody has said the work is wrong or unnecessary, only that whoever it was addressed to is gone. Give it to somebody who is here, or drop it if it is no longer needed.'
      task.updatedAt = new Date().toISOString()
      this.save()
      this.touch(task)
      this.events.onAgentReport(GONE_AGENT, task)
      return
    }

    const feedback = this.pendingFeedback.get(task.id) ?? null
    this.pendingFeedback.delete(task.id)
    delete task.parkAnswer
    delete task.selfCheckResend
    if (task.status === 'revising' && !task.holdRound && task.feature && this.featureSessions?.on() && task.feature.sessionsTotal >= 2 * task.feature.maxSessions) {
      return void this.escalateAttempts(task, `It has run ${task.feature.sessionsTotal} sessions over its rounds. Its work is kept: decide with the owner whether the piece is too big or the approach wrong before it runs again.`)
    }
    if (task.status === 'revising' && !task.holdRound) task.round += 1
    delete task.holdRound
    for (const key of [...this.toldStuck]) if (key.endsWith(`:${task.id}`)) this.toldStuck.delete(key)
    if (this.fingerprint) {
      const stamps = this.fingerprint(task)
      task.builtOn = stamps.length > 0 ? stamps : undefined
      delete task.drifted
    }
    task.status = 'working'
    task.updatedAt = new Date().toISOString()
    if (task.selfCheckRound !== task.round) task.runSince = task.updatedAt
    if (agent.kind === 'submanager' && this.activateSubmanager) this.umbrellas.add(task.id)
    else this.running.add(task.id)
    this.save()
    this.touch(task)

    let launched: ReturnType<AgentRun>
    try {
      if (agent.kind === 'submanager' && this.activateSubmanager) {
        this.activateSubmanager(agent, task, feedback)
        return
      }
      launched = this.run(onItsBrain(agent, task), task, feedback)
    } catch (err) {
      task.status = 'failed'
      task.result = `${agent.name} could not be started: ${err instanceof Error ? err.message : String(err)}`
      task.updatedAt = new Date().toISOString()
      this.running.delete(task.id)
      this.save()
      this.touch(task)
      this.events.onAgentReport(agent, task)
      this.pump()
      return
    }

    void launched
      .then((outcome) => {
        if (this.stopped.delete(task.id)) return { paused: true }
        task.result = outcome.resultText
        if (outcome.sessionId) task.sessionId = outcome.sessionId
        if (outcome.parked) return this.parkForCriteria(task, outcome.resultText, outcome.plan?.text)
        if (!outcome.ok && outcome.limited && this.isAutopilot()) {
          const resumeAt = outcome.resetsAt ? outcome.resetsAt * 1000 + 30_000 : Date.now() + 60 * 60 * 1000
          task.notBefore = resumeAt
          task.limitWait = true
          task.status = task.round > 1 || feedback ? 'revising' : 'queued'
          task.holdRound = true
          if (feedback) this.pendingFeedback.set(task.id, feedback)
          this.running.delete(task.id)
          task.updatedAt = new Date().toISOString()
          this.save()
          this.touch(task)
          this.onAutopilotWait?.(task, resumeAt)
          this.scheduleResume()
          return { paused: true }
        }
        if (!outcome.ok && /execution permissions do not include/i.test(outcome.resultText ?? '')) {
          task.status = 'escalated'
          task.escalation = 'manager'
          task.result = outcome.resultText ?? 'This job’s model is not allowed on this project.'
          this.running.delete(task.id)
          task.updatedAt = new Date().toISOString()
          this.save()
          this.touch(task)
          this.events.onAgentReport(this.roster.get(task.agentId) ?? GONE_AGENT, task)
          return { paused: true }
        }
        if (!outcome.ok && /could not (?:be admitted|start)|waited too long for protected execution capacity/i.test(outcome.resultText ?? '')) {
          task.seatWaitSince ??= new Date().toISOString()
          if (Date.now() - Date.parse(task.seatWaitSince) > MAX_SEAT_WAIT_MS) return this.escalateAttempts(task, `It has tried to start for over three hours without beginning. The last refusal: ${outcome.resultText ?? 'none recorded'}`)
          const refusal = (outcome.resultText ?? '').trim()
          if (/could not be admitted/i.test(refusal) && !/waited too long for protected execution capacity/i.test(refusal)) {
            task.refusedTimes = task.refusedFor === refusal ? (task.refusedTimes ?? 1) + 1 : 1
            task.refusedFor = refusal
            if (task.refusedTimes >= 3) return this.escalateAttempts(task, `It cannot start: the same refusal came back ${task.refusedTimes} times in a row. ${refusal}`)
          }
          task.notBefore = Date.now() + 30_000
          task.status = task.round > 1 || feedback ? 'revising' : 'queued'
          task.holdRound = true
          if (feedback) this.pendingFeedback.set(task.id, feedback)
          this.running.delete(task.id)
          task.updatedAt = new Date().toISOString()
          this.save()
          this.touch(task)
          this.onDeferred?.(task, outcome.resultText ?? 'it could not start')
          this.scheduleResume()
          return { paused: true }
        }
        if (!outcome.ok && isStopSentence(outcome.resultText) && !this.stopped.has(task.id)) {
          task.notBefore = Date.now() + 15_000
          task.status = task.round > 1 || feedback ? 'revising' : 'queued'
          task.holdRound = true
          task.interrupted = true
          task.attempts = [...(task.attempts ?? []), { cls: 'restart', at: new Date().toISOString() }]
          const partial = /Partial report:\n([\s\S]*)$/.exec(outcome.resultText ?? '')?.[1]?.trim()
          const sessionNote = task.feature && this.featureSessions?.on() ? this.featureSessions.note(task, partial) : ''
          const objection = this.objectionOf(task)
          this.pendingFeedback.set(task.id, sessionNote
            ? [sessionNote, objection ? `The latest revision feedback still applies:\n${objection}` : ''].filter(Boolean).join('\n\n')
            : [INTERRUPTED_NOTE, objection ? `The latest revision feedback still applies:\n${objection}` : '', partial ? `Your own report so far:\n${partial.slice(0, 4000)}` : ''].filter(Boolean).join('\n\n'))
          this.running.delete(task.id)
          task.updatedAt = new Date().toISOString()
          this.save()
          this.touch(task)
          this.onDeferred?.(task, 'Damon was closed while it ran; it carries on from what it had done', true)
          this.scheduleResume()
          return { paused: true }
        }
        if (task.feature && this.featureSessions?.on()) {
          const d = nextSession(task, { ok: outcome.ok, resultText: outcome.resultText })
          task.feature = { ...task.feature, sessions: task.feature.sessions + 1, sessionsTotal: task.feature.sessionsTotal + 1 }
          if (d.action === 'escalate') return this.escalateAttempts(task, d.why)
          if (d.action === 'continue') {
            delete task.seatWaitSince; delete task.refusedFor; delete task.refusedTimes
            const partial = /Partial report:\n([\s\S]*)$/.exec(outcome.resultText ?? '')?.[1]?.trim()
            const objection = this.objectionOf(task)
            this.pendingFeedback.set(task.id, [this.featureSessions.note(task, partial ?? (outcome.ok ? outcome.resultText : undefined)), objection ? `The latest revision feedback still applies:\n${objection}` : ''].filter(Boolean).join('\n\n'))
            task.notBefore = Date.now() + 15_000
            task.status = task.round > 1 || feedback ? 'revising' : 'queued'
            task.holdRound = true
            this.running.delete(task.id)
            task.updatedAt = new Date().toISOString()
            this.save(); this.touch(task)
            this.onDeferred?.(task, `${d.why}; a new session continues it from its last checkpoint`, true)
            this.scheduleResume()
            return { paused: true }
          }
        }
        delete task.seatWaitSince
        delete task.refusedFor
        delete task.refusedTimes
        if (!outcome.ok) {
          const decision = decideAttempt(task, outcome.resultText, Date.now())
          if (decision.action !== 'fail') {
            const partial = /Partial report:\n([\s\S]*)$/.exec(outcome.resultText ?? '')?.[1]?.trim()
            task.attempts = [...(task.attempts ?? []), { cls: decision.cls, at: new Date().toISOString(), ...(partial ? { partialChars: partial.length } : {}) }]
            if (decision.action === 'escalate') return this.escalateAttempts(task, `${decision.why} The last ending: ${(outcome.resultText ?? '').slice(0, 600)}`)
            task.notBefore = Date.now() + 30_000
            task.status = task.round > 1 || feedback ? 'revising' : 'queued'
            task.holdRound = true
            const objection = this.objectionOf(task)
            this.pendingFeedback.set(task.id, [attemptNote(decision.cls, partial), objection ? `The latest revision feedback still applies:\n${objection}` : ''].filter(Boolean).join('\n\n'))
            this.running.delete(task.id)
            task.updatedAt = new Date().toISOString()
            this.save()
            this.touch(task)
            this.onDeferred?.(task, `${decision.why}; it runs again as the same job`, true)
            this.scheduleResume()
            return { paused: true }
          }
        }
        const resent = task.selfCheckRound === task.round
        const changedFiles = resent && outcome.ok ? (outcome.changedFiles === true || task.changedFiles === true) : outcome.changedFiles
        if (outcome.ok && this.roster.get(task.agentId)?.kind !== 'submanager') {
          let gap: string | null = null
          const report = outcome.selfCheck ? `${outcome.resultText ?? ''}\n${SELF_CHECK_MARK} ${outcome.selfCheck}` : outcome.resultText ?? ''
          try { gap = this.selfCheckGap?.(task, report, { changedFiles: changedFiles === true }) ?? null } catch { gap = null }
          if (gap && task.selfCheckRound !== task.round) {
            task.selfCheckRound = task.round
            task.changedFiles = outcome.changedFiles ?? true
            this.changed.set(task.id, task.changedFiles)
            if (outcome.plan?.text) task.plan = outcome.plan.text
            task.firstRun = { firstRound: feedback === null, plan: outcome.plan ?? null, changedFiles: changedFiles === true }
            task.notBefore = Date.now() + 30_000
            task.status = task.round > 1 || feedback ? 'revising' : 'queued'
            task.holdRound = true
            const objection = this.objectionOf(task)
            const resend = [selfCheckResend(gap), objection ? `The latest revision feedback still applies:\n${objection}` : ''].filter(Boolean).join('\n\n')
            task.selfCheckResend = resend
            this.pendingFeedback.set(task.id, resend)
            this.running.delete(task.id)
            task.updatedAt = new Date().toISOString()
            this.save(); this.touch(task)
            this.onDeferred?.(task, SELF_CHECK_DEFERRED, true)
            this.scheduleResume()
            return { paused: true }
          }
          if (gap) task.processNotes = [...(task.processNotes ?? []), SELF_CHECK_NOTE].slice(-8)
        }
        task.status = outcome.ok ? 'review' : 'failed'
        if (outcome.plan?.text) task.plan = outcome.plan.text
        this.changed.set(task.id, changedFiles ?? true)
        task.changedFiles = changedFiles ?? true
        const first = resent ? task.firstRun : undefined
        delete task.firstRun
        if (outcome.ok && this.verifyRun) {
          const verdict = this.verifyRun(agent, task, outcome.stderr ?? '', {
            firstRound: first ? first.firstRound : feedback === null,
            plan: first ? (first.changedFiles ? first.plan : (outcome.plan ?? first.plan)) : (outcome.plan ?? null),
            changedFiles: changedFiles ?? false
          })
          if (verdict) task.verification = { at: new Date().toISOString(), findings: verdict.findings, ...(task.verification?.overruledKeys?.length ? { overruledKeys: task.verification.overruledKeys } : {}) }
          if (verdict?.notes?.length) task.processNotes = [...(task.processNotes ?? []), ...verdict.notes].slice(-8)
          const lessons = verdict ? [...verdict.findings.map((f) => f.text), ...(verdict.notes ?? []).map((n) => `${n} ${LATE_PLAN_LESSON}`)].filter((t) => t.trim().length > 0) : []
          if (verdict && lessons.length > 0) this.onRejected?.(agent, task, lessons)
          const late = latePlans(this.tasks, agent.id)
          if (late < LATE_PLAN_HABIT) {
            if (this.toldPlanHabit.delete(agent.id)) this.saveTold()
          } else if (verdict?.notes?.length && !this.toldPlanHabit.has(agent.id)) {
            this.toldPlanHabit.add(agent.id)
            this.saveTold()
            this.onPlanHabit?.(agent, task, late)
          }
        }
        return { paused: false }
      })
      .catch((err: unknown) => {
        if (this.stopped.delete(task.id)) return { paused: true }
        task.result = err instanceof Error ? err.message : String(err)
        task.status = 'failed'
        return { paused: false }
      })
      .then(async (r) => {
        if (r?.paused) return
        const next = task.status === 'review' ? await this.runGate(agent, task) : 'report'
        this.afterGate(agent, task, next)
      })
  }

  private regate(task: TaskInfo): void {
    delete task.gatePending
    delete task.waitingFor
    this.running.add(task.id)
    this.save()
    this.touch(task)
    const agent = this.roster.get(task.agentId) ?? GONE_AGENT
    void this.runGate(agent, task).then((next) => this.afterGate(agent, task, next))
  }

  private afterGate(agent: AgentInfo, task: TaskInfo, next: 'report' | 'revising' | 'cut' | 'waiting'): void {
    if (next === 'cut') {
      this.stopped.delete(task.id)
      if (this.pendingGateResume.delete(task.id)) this.pump()
      return
    }
    if (next === 'waiting') {
      task.updatedAt = new Date().toISOString()
      this.running.delete(task.id)
      this.save()
      this.touch(task)
      this.scheduleResume()
      this.pump()
      return
    }
    if (next === 'report' && task.status === 'review' && task.review?.ran === false && !task.review.infra && !task.reviewedAgain && !this.stopped.has(task.id) && (this.reviewDepth?.(task) ?? 'none') !== 'none') {
      this.markReviewedAgain(task.id)
      this.regate(task)
      return
    }
    task.updatedAt = new Date().toISOString()
    this.running.delete(task.id)
    this.save()
    this.touch(task)
    if (next === 'report' && task.review?.processOnly && !task.review.overruledWhy) {
      const objections = this.gateObjections.get(task.id) ?? [task.review.objection ?? 'The reviewer did not say what was wrong.']
      this.gateObjections.delete(task.id)
      const out = this.approve(task.id)
      this.gateFollow.delete(task.id)
      if (!('error' in out)) { this.checkStuck(); this.checkMilestones(); return }
      const review = task.review
      if (review && !review.overruledWhy) {
        delete review.processOnly
        this.onRejected?.(agent, task, objections)
        if (review.depth === 'full' && this.roundsUsed(task) < this.maxRounds && !this.atCeiling(task)) {
          this.sendBack(task, objections.join('\n'))
          this.pump()
          this.checkStuck()
          this.checkMilestones()
          return
        }
        this.save()
      }
    }
    if (next === 'report' && this.signsOffItself(task)) {
      task.status = 'approved'
      this.onApproved?.({ ...task })
      this.save()
      this.touch(task)
      this.events.onSignedOff?.(agent, task)
    } else if (next === 'report') this.events.onAgentReport(agent, task)
    this.pump()
    this.checkStuck()
    this.checkMilestones()
  }

  private sendBack(task: TaskInfo, objection: string, fromCode = false): void {
    const feedback = [
      fromCode ? `${CODE_SEND_BACK} Deal with every point, then report back.` : `${REVIEWER_SEND_BACK} Deal with every point, then report back.`,
      '',
      objection
    ].join('\n')
    task.feedback.push(feedback)
    task.status = 'revising'
    delete task.reviewedAgain
    delete task.holdRound
    if (task.feature) task.feature = { ...task.feature, sessions: 0 }
    delete task.selfCheckResend
    this.pendingFeedback.set(task.id, feedback)
    this.save()
    this.touch(task)
  }

  private async askSmallFix(task: TaskInfo, why: 'lane' | 'stuck'): Promise<string | null> {
    let out: { ok: true; summary: string } | { ok: false; why: string } | null
    try { out = await this.smallFixLand!(task, why) } catch (e) { out = { ok: false, why: e instanceof Error ? e.message : String(e) } }
    return out && out.ok ? out.summary : null
  }
  private recordSmallFix(task: TaskInfo, summary: string): void {
    task.review = {
      at: new Date().toISOString(), satisfied: true, rounds: task.round, standing: 'review', why: summary,
      reviewerModel: '', depth: this.reviewDepth?.(task) ?? 'single', ran: true, decidedBy: 'damon-code'
    } as ReviewRecord
    task.status = 'review'
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)
  }

  private signsOffItself(task: TaskInfo): boolean {
    if (this.completionBlocker?.(task)) return false
    if (task.status !== 'review') return false
    if ((task.verification?.findings?.length ?? 0) > 0) return false
    if (task.route?.bookkeeping && !task.finalizesDeliverables && (this.reviewDepth?.(task) ?? 'none') === 'none') return true
    const r = task.review
    return r !== undefined && r.satisfied === true && r.standing === 'review'
  }

  private async runGate(agent: AgentInfo, task: TaskInfo): Promise<'report' | 'revising' | 'cut' | 'waiting'> {
    const generation = Symbol(task.id)
    this.activeGates.set(task.id, generation)
    task.gatePending = true
    task.status = 'reviewing'
    delete task.reviewSkipped
    this.save()
    this.touch(task)
    const current = () => this.activeGates.get(task.id) === generation && !this.stopped.has(task.id) && task.status === 'reviewing'
    try {
      const next = await this.runGateDecision(agent, task, current)
      if (this.activeGates.get(task.id) !== generation || this.stopped.has(task.id)) return 'cut'
      if (next !== 'waiting' && next !== 'cut') {
        delete task.gatePending
        if (task.status === 'reviewing') task.status = 'review'
      }
      return next
    } finally {
      if (this.activeGates.get(task.id) === generation) this.activeGates.delete(task.id)
    }
  }

  private async runGateDecision(agent: AgentInfo, task: TaskInfo, current: () => boolean): Promise<'report' | 'revising' | 'cut' | 'waiting'> {
    const depth = this.reviewDepth?.(task) ?? 'none'
    if (depth === 'none' || !this.reviewRun) {
      task.review = undefined
      return 'report'
    }

    if ((task.verification?.findings?.length ?? 0) > 0 && !task.verification?.overruledWhy) {
      task.review = undefined
      return 'report'
    }

    if ((task.changedFiles ?? this.changed.get(task.id)) === false && !task.finalizesDeliverables && !task.intent && !task.critiqueId) {
      task.review = undefined
      task.reviewSkipped = 'nothing on disk changed, so there was nothing for a reviewer to open; the report is the work'
      return 'report'
    }
    delete task.reviewSkipped

    if (this.checkDocuments) {
      let found: Finding[] = []
      try {
        found = await this.checkDocuments(task)
      } catch (err) {
        found = [{ kind: 'document', text: `the document check itself failed: ${err instanceof Error ? err.message : String(err)}` }]
      }
      if (!current()) return 'cut'
      const prior = task.verification?.findings ?? []
      const overruledKeys = task.verification?.overruledKeys ?? []
      const overruled = new Set(overruledKeys)
      const standing = found.filter(f => { const k = overrulableKey(f); return !(k && overruled.has(k)) })
      const fresh = standing.filter(f => !prior.some(p => findingKey(p) === findingKey(f)))
      if (fresh.length > 0 || (standing.length > 0 && !task.verification?.overruledWhy)) {
        const kept = overruledKeys.length ? { overruledKeys } : {}
        const fromCode = fresh.some(f => f.fingerprint)
        if (fromCode && (task.codeSendBacks ?? 0) < 1 && this.roundsUsed(task) < this.maxRounds && !this.atCeiling(task)) {
          task.codeSendBacks = (task.codeSendBacks ?? 0) + 1
          task.verification = { at: new Date().toISOString(), findings: [], ...kept }
          task.review = undefined
          this.sendBack(task, standing.map(f => `- ${f.text}`).join('\n'), true)
          return 'revising'
        }
        task.verification = { at: new Date().toISOString(), findings: [...prior, ...fresh], ...kept }
        task.review = undefined
        return 'report'
      }
    }

    if (task.lane === 'small' && this.smallFixLand) {
      const small = await this.askSmallFix(task, 'lane')
      if (!current()) return 'cut'
      if (small) { this.recordSmallFix(task, small); return 'report' }
    }

    task.status = 'reviewing'
    task.updatedAt = new Date().toISOString()
    this.save()
    this.touch(task)

    const previous = task.review?.objection ? [task.review.objection] : []
    const began = new Date().toISOString()
    let outcome: ReviewOutcome
    try {
      outcome = await this.reviewRun(onItsBrain(agent, task), task, task.round, previous)
    } catch (err) {
      outcome = {
        satisfied: false,
        ran: false,
        objections: [`The reviewer could not be run: ${err instanceof Error ? err.message : String(err)}`],
        standing: 'second-opinion',
        why: 'The reviewer did not run.',
        reviewerModel: ''
      }
    }
    if (!current()) return 'cut'

    if (!outcome.ran && outcome.limited) {
      const resumeAt = outcome.resetsAt ? outcome.resetsAt * 1000 + 30_000 : Date.now() + 60 * 60 * 1000
      task.status = 'review'
      task.gatePending = true
      task.notBefore = resumeAt
      task.limitWait = true
      this.onAutopilotWait?.(task, resumeAt)
      return 'waiting'
    }
    if (!outcome.ran && outcome.held) {
      task.status = 'review'
      task.gatePending = true
      return 'waiting'
    }

    const objection = outcome.satisfied ? undefined : outcome.objections.join(' ')
    const infraCls = outcome.ran === false ? reviewInfraClass(objection) : null
    const before = task.review?.ran === false ? task.review.infra : undefined
    const infra: ReviewInfra | undefined = infraCls ? { cls: infraCls, count: (before?.count ?? 0) + 1, ...(before?.ownerAgain ? { ownerAgain: before.ownerAgain } : {}), ...(before?.carded ? { carded: before.carded } : {}) } : undefined
    const refusals = infra ? undefined : outcome.ran === false && task.review?.ran === false && task.review.objection === objection ? (task.review.refusals ?? 1) + 1 : outcome.ran === false ? 1 : undefined
    const record: ReviewRecord = {
      at: new Date().toISOString(),
      satisfied: outcome.satisfied,
      rounds: task.round,
      standing: outcome.standing,
      why: outcome.why,
      reviewerModel: outcome.reviewerModel,
      ...(outcome.reviewerWhy ? { reviewerWhy: outcome.reviewerWhy } : {}),
      objection,
      depth,
      ...(infra ? { infra } : {}),
      ran: outcome.ran,
      ...(refusals ? { refusals } : {}),
      criteria: outcome.criteria?.length ? outcome.criteria : undefined
    }
    task.review = record
    task.status = 'review'
    countReviewBrain(task, outcome)

    if (infra && infraCls) {
      if (STUCK_SMALL.has(infraCls) && infra.count >= 2 && this.smallFixLand && !this.stopped.has(task.id)) {
        const small = await this.askSmallFix(task, 'stuck')
        if (this.stopped.has(task.id)) return 'cut'
        if (small) { this.recordSmallFix(task, small); return 'report' }
      }
      if (reviewCapped(infra)) {
        if (infra.carded !== infra.count) this.raiseCapCard(task, infra)
        return 'report'
      }
      if (retriesItself(infraCls) && infra.count <= AUTO_RETRIES) {
        const resumeAt = Date.now() + reviewRetryDelayMs(infra.count, infraCls)
        task.gatePending = true
        task.notBefore = resumeAt
        try { this.onReviewInfra?.(task, infraCls, infra.count, resumeAt) } catch {}
        return 'waiting'
      }
      try { this.onReviewInfra?.(task, infraCls, infra.count) } catch {}
    }

    if (outcome.ran && !outcome.satisfied) {
      let conflict: string[] | null = null
      try { conflict = this.criteriaConflict?.(task, began) ?? null } catch { conflict = null }
      if (conflict?.length) {
        record.criteriaConflict = conflict
        return 'report'
      }
    }

    if (outcome.ran && !outcome.satisfied && !task.followsUp && acceptableAsKnownFault(task)) {
      let follow: ReturnType<NonNullable<TaskEngineOptions['processFollowUp']>> = null
      try { follow = this.processFollowUp?.(task, { since: began, objections: outcome.objections }) ?? null } catch { follow = null }
      if (follow) { record.processOnly = true; this.gateObjections.set(task.id, [...outcome.objections]); this.gateFollow.set(task.id, follow); return 'report' }
    }

    if (outcome.ran && !outcome.satisfied && outcome.objections.length > 0) {
      this.onRejected?.(agent, task, outcome.objections)
    }

    const onlyBlocked = outcome.objections.length > 0 && outcome.objections.every(o => /^[^:\n]{1,80}: blocked: /.test(o.trim()))
    const canRetry =
      outcome.ran && !outcome.satisfied && depth === 'full' && this.roundsUsed(task) < this.maxRounds && !this.atCeiling(task) && !onlyBlocked

    if (canRetry) {
      this.sendBack(task, outcome.objections.join('\n'))
      return 'revising'
    }

    this.onArrival?.(
      task,
      arrivalOf({
        title: task.title,
        satisfied: outcome.satisfied,
        rounds: task.round,
        lastObjection: record.objection,
        criteria: record.criteria,
        ran: record.ran
      })
    )
    return 'report'
  }

  private touch(task: TaskInfo): void {
    this.events.onTaskUpdate(task)
  }

  private save(): void {
    stampVerifiedFixes(this.tasks)
    writeJson(this.file, this.tasks)
  }

  private archiveFinished(): void {
    const cutoff = Date.now() - ARCHIVE_AFTER_MS
    const open = this.tasks.filter((t) => t.status !== 'approved' && t.status !== 'failed')
    const needed = new Set(open.flatMap((t) => t.needs ?? []))
    const openIds = new Set(open.map((t) => t.id))
    if (stampVerifiedFixes(this.tasks)) this.save()
    const done = this.tasks.filter((t) => t.status === 'approved' || t.status === 'failed')
    const newestFirst = [...done].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    const overTheCount = new Set(newestFirst.slice(KEEP_FINISHED).map((t) => t.id))
    const gone = done.filter(
      (t) => !needed.has(t.id) && !(t.fixes && openIds.has(t.fixes)) && !faultOpen(t, this.tasks) && (Date.parse(t.updatedAt) < cutoff || overTheCount.has(t.id))
    )
    if (gone.length === 0) return
    try {
      appendFileSync(join(dirname(this.file), ARCHIVE_FILE), gone.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8')
      archiveIndex.delete(join(dirname(this.file), ARCHIVE_FILE))
    } catch {
      return
    }
    const ids = new Set(gone.map((t) => t.id))
    this.tasks = this.tasks.filter((t) => !ids.has(t.id))
    this.save()
  }
}
