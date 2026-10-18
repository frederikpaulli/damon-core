// Shared types between the main process and the renderer.
import type { Finding } from './verification'
import type { ReviewRecord } from './review'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  kind?: 'project' | 'chat'
  pinned?: boolean
}

export interface Settings {
  managerModel: string
  fallbackModel: string
  agentModel: string
  leadModel: string
  fullAccess: boolean
  useAccountConnections: boolean
  teamMode: boolean
  autopilot: boolean
  buildAutopilot?: boolean
  budgetUsd: number
  ceilings?: Record<string, number>
  ceilingWindowHours?: number
  maxBrain: string
  reviewersAboveCeiling?: boolean
  viewsOffApprovedList?: boolean
  essentialsWithBrains?: 'per-version' | 'press'
  lean?: Partial<Record<import('./lean').LeanSwitch, boolean>>
}

export type ChatRole = 'user' | 'manager' | 'activity' | 'notice' | 'error'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: string
  weight?: 'routine'
}

export interface CliStatus {
  ok: boolean
  path?: string
  version?: string
  problem?: 'not-found' | 'no-version'
  detail?: string
}

export type ManagerEvent =
  | {
      kind: 'session'
      sessionId: string
      mcpServers?: { name: string; status?: string }[]
    }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'step_usage'; usage: Record<string, number>; messageId?: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_activity'
      tool: string
      summary: string
      detail?: string
      step?: string
      id?: string
      background?: boolean
    }
  | {
      kind: 'tool_done'
      id: string
      ok: boolean
      outcome?: string
      proof?: string[]
      background?: boolean
    }
  | {
      kind: 'rate_limit'
      status?: string
      resetsAt?: number
      utilization?: number
      rateLimitType?: string
      isUsingOverage?: boolean
    }
  | {
      kind: 'result'
      tokenUsage?: Record<string, number>
      ok: boolean
      error?: string
      costUsd?: number
      tokens?: number
      limited?: boolean
      resetsAt?: number
      outOfSteps?: boolean
      steps?: number
      firstStep?: Record<string, number>
      estimated?: boolean
      promptBytes?: { systemAppend: number; prompt: number }
      stableSha256?: string
      rebuildCause?: 'none' | 'first' | 'age' | 'instructions' | 'delta' | 'limit'
    }

export interface UsageChangedPayload {
  projectId: string
  costUsd: number
  tokens: number
}

export interface ManagerStreamPayload {
  projectId: string
  message?: ChatMessage
  draft?: string
  thinking?: string
  working?: boolean
  turnStartedAt?: number
  done?: boolean
  yoursWaiting?: number
  leadsBusy?: number
  step?: LiveStep | null
}

export interface LiveStep {
  id?: string
  text: string
  detail?: string
  startedAt: string
  n: number
  done?: { ok: boolean; outcome?: string }
}

export interface AgentInfo {
  id: string
  name: string
  role: string
  label?: string
  model: string
  kind?: 'agent' | 'submanager'
  parentId?: string
  tools?: string[]
  maxTurns?: number
  whenToUse?: string
  createdAt: string
}

export type TaskStatus =
  | 'queued'
  | 'working'
  | 'reviewing'
  | 'review'
  | 'revising'
  | 'approved'
  | 'failed'
  | 'paused'
  | 'escalated'

export interface TaskInfo {
  escalation?: import('./escalation').EscalationTo
  assignment?: import('./assignment').AssignmentProfile
  intent?: import('./intended-work').IntendedWork
  critiqueId?: string
  workBasis?: { files: { file: string; hash: string; observed?: boolean }[]; evidence: string[]; scope?: string[]; complete?: boolean }
  observedReads?: string[]
  operationId?: string
  id: string
  deliverableIds?: string[]
  finalizesDeliverables?: boolean
  inputUpdates?: string[]
  pendingInputs?: { key: string; feedback: string }[]
  agentId: string
  title: string
  label?: string
  instructions: string
  acceptance: string
  writes?: string[]
  needs?: string[]
  reads?: string[]
  milestone?: string
  builtOn?: { file: string; hash: string }[]
  draftReads?: string[]
  drifted?: string[]
  status: TaskStatus
  round: number
  result?: string
  plan?: string
  processNotes?: string[]
  lineage?: { rounds: number; pastCap: number; root: string; sent?: number }
  connections?: string[]
  route?: import('./gate-route').GateRoute
  lane?: 'small'
  reviewSkipped?: string
  reviewedAgain?: true
  brain?: string
  opusRefusals?: number
  fableTried?: true
  steppedUpFrom?: string
  continuesFrom?: string
  narrowedBecause?: string
  knownFault?: import('./known-faults').KnownFault
  fixes?: string
  stage?: 'screen' | 'wire'
  piece?: string
  feature?: import('./feature-job').FeatureState
  followsUp?: string
  skills?: { id: string; sha256: string; tree?: string }[]
  changedFiles?: boolean
  feedback: string[]
  sessionId?: string
  creatorId?: string
  notBefore?: number
  limitWait?: boolean
  waitingFor?: string
  interrupted?: boolean
  attempts?: { cls: import('./failure-class').FailureClass; at: string; partialChars?: number }[]
  parkedOnce?: boolean
  parkedFor?: string
  foundationSkipped?: true
  parkAnswer?: string
  criteriaAmended?: string[]
  runSince?: string; selfCheckRound?: number
  selfCheckResend?: string
  firstRun?: { firstRound: boolean; plan: { text: string; beforeChanges: boolean } | null; changedFiles: boolean }
  seatWaitSince?: string
  refusedFor?: string
  refusedTimes?: number
  holdRound?: true
  gatePending?: boolean
  verification?: {
    at: string
    findings: Finding[]
    overruledWhy?: string
    overruledKeys?: string[]
  }
  codeSendBacks?: number
  review?: ReviewRecord
  createdAt: string
  updatedAt: string
}

export interface AgentFeedLine {
  at: string
  kind: 'status' | 'activity' | 'text'
  text: string
}

export interface AgentEventPayload {
  projectId: string
  agentId: string
  line: AgentFeedLine
}

export interface RosterChangedPayload {
  projectId: string
  agents: AgentInfo[]
}

export interface TasksChangedPayload {
  projectId: string
  tasks: TaskInfo[]
}

export interface SpendEntry {
  estimated?: boolean
  tokenUsage?: Record<string, number>
  reviewRole?: 'worker' | 'reviewer' | 'critic' | 'coordination'
  reviewPurpose?: string
  retryCause?: string
  evidenceBytes?: number
  at: string
  actor: 'manager' | 'lead' | 'agent'
  agentId?: string
  name: string
  role?: string
  label?: string
  taskId?: string
  taskTitle?: string
  taskLabel?: string
  model: string
  provider: 'claude' | 'openai' | 'gemini'
  costUsd: number
  tokens: number
  reported: boolean

  turnKind?: 'owner' | 'routine'
  steps?: number
  contextTokens?: number
  firstStep?: Record<string, number>
  promptBytes?: { systemAppend: number; prompt: number }
  stableSha256?: string
  rebuildCause?: string
  gapSeconds?: number
  quota?: {
    utilization: number
    rateLimitType?: string
    resetsAt?: number
    isUsingOverage?: boolean
  }
}

import type { WhereItWent } from './meter'

export interface SpendBucket {
  costUsd: number
  tokens: number
  runs: number
  unreported: number
}

export interface SpendRollup {
  days: Record<string, SpendBucket>
  byProvider: Record<string, SpendBucket>
  byRole: Record<string, SpendBucket>
  byModel: Record<string, SpendBucket>
  byActor: Record<string, SpendBucket>
  hours?: Record<string, Record<string, number>>
  trustedFrom?: string
}

export interface PersonSpend {
  name: string
  role?: string
  label?: string
  model: string
  provider: string
  runs: number
  costUsd: number
  tokens: number
  unreported: number
}

export interface TaskSpend {
  taskId: string
  taskTitle: string
  name: string
  runs: number
  costUsd: number
  tokens: number
  unreported: number
}

export interface SpendView {
  rollup: SpendRollup
  byPerson: PersonSpend[]
  topTasks: TaskSpend[]
  meter?: WhereItWent
}

export type DamonEventKind =
  | 'team_proposed'
  | 'team_approved'
  | 'team_sent_back'
  | 'hired'
  | 'job_assigned'
  | 'job_finished'
  | 'job_sent_back'
  | 'job_amended'
  | 'job_failed'
  | 'job_escalated'
  | 'blocked_on_owner'
  | 'handed_to_owner'
  | 'sent_for_owner'
  | 'unblocked'
  | 'limit_reached'
  | 'work_paused'
  | 'work_resumed'
  | 'owner_stopped'
  | 'orphans_cleared'
  | 'check_overruled'
  | 'criteria_refused'
  | 'candidate_applied'

export interface DamonEventActor {
  id: string
  name: string
  kind: 'manager' | 'lead' | 'agent' | 'owner'
}

export interface DamonEventSubject {
  taskId?: string
  title?: string
  agentId?: string
  name?: string
  count?: number
  detail?: string
}

export interface DamonEventInput {
  kind: DamonEventKind
  actor: DamonEventActor
  subject?: DamonEventSubject
}

export interface DamonEvent extends DamonEventInput {
  seq: number
  at: string
  text: string
}

export interface Handover {
  file: string
  what: string
  at: string
  agentId: string
  agentName: string
  taskId?: string
  taskTitle?: string
}
