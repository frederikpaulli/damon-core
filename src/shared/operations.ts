import { z } from 'zod'
import type { PresentedMetric } from './metrics'

export const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const text = z.string().trim().min(1).max(2000)
const label = z.string().trim().min(1).max(160)
const date = z.string().datetime({ offset: true })
export const resourceKind = z.enum(['app', 'service', 'account', 'automation', 'other'])
export const resourceDefinition = z.object({
  id: operationId, name: label, kind: resourceKind, purpose: text,
  environment: label, owner: label,
  location: z.string().max(2000).refine(value => {
    if (!value) return true
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash } catch { return false }
  }, 'Use an HTTPS link without credentials, query parameters or a fragment.'),
  versionLabel: z.string().trim().max(160),
  lifecycle: z.enum(['planned', 'operating', 'paused', 'retired']),
  support: z.string().trim().max(2000),
  checks: z.array(z.object({ id: operationId, name: label, purpose: text, freshnessMinutes: z.number().int().min(1).max(525600) }).strict()).max(30)
}).strict().refine(value => new Set(value.checks.map(check => check.id)).size === value.checks.length, 'Each check needs a distinct ID.')
export type ResourceDefinition = z.infer<typeof resourceDefinition>
export const resourceInput = z.object({ expectedRevision: z.number().int().nonnegative(), resource: resourceDefinition }).strict()
export type ResourceInput = z.infer<typeof resourceInput>
export const reportInput = z.object({
  id: operationId, resourceId: operationId, resourceRevision: z.number().int().positive(), checkId: operationId,
  occurredAt: date, result: z.enum(['pass', 'fail', 'unknown']), summary: text,
  evidence: z.string().trim().max(2000), simulated: z.boolean()
}).strict()
export type ReportInput = z.infer<typeof reportInput>
export const resourceRecord = z.object({ definition: resourceDefinition, revision: z.number().int().positive(), at: date, by: label }).strict()
export type ResourceRecord = z.infer<typeof resourceRecord>
export const reportRecord = z.object({ input: reportInput, receivedAt: date, by: label, origin: z.enum(['owner-report', 'agent-report', 'simulation']) }).strict()
export type OperationReport = z.infer<typeof reportRecord>
export type CheckState = 'unmonitored' | 'unknown' | 'stale' | 'reported-pass' | 'reported-failure' | 'simulation'
export interface CheckView { id: string; name: string; state: CheckState; report?: OperationReport }
export interface ResourceView extends ResourceRecord { state: CheckState; checks: CheckView[]; priorFailures: OperationReport[] }
export type AttentionKind = 'problem' | 'waiting' | 'record'
export const ATTENTION_ORDER: AttentionKind[] = ['problem', 'waiting', 'record']
export interface OperationAttention { id: string; title: string; detail: string; state?: string; kind: AttentionKind; target: 'yours' | 'fleet' | 'files' | 'marketing' | 'overview' }
export type NotificationKind = 'needs-you' | 'milestone' | 'broke'
export interface OperationNotification {
  id: string
  kind: NotificationKind
  title: string
  detail: string
  at?: string
  target: 'yours' | 'fleet' | 'files' | 'marketing' | 'overview'
}

export interface OperationHistoryEntry { id: string; title: string; detail: string; at?: string }

export type ProjectStage = 'unset' | 'planning' | 'building' | 'reviewing' | 'releasing' | 'live'

export const PROJECT_STAGE_WORDS: Record<ProjectStage, { label: string; blurb: string }> = {
  unset: { label: 'Stage not set', blurb: 'Damon has not been told what this project is. These are the facts it has.' },
  planning: { label: 'Being planned', blurb: 'Nothing is running yet. What matters now is what has been agreed.' },
  building: { label: 'Being built', blurb: 'Work is being done. What matters now is what is finishing and what is failing.' },
  reviewing: { label: 'In review', blurb: 'The work is being checked before it goes anywhere.' },
  releasing: { label: 'Waiting to be released', blurb: 'The work is done. What matters now is what still stands between it and going out.' },
  live: { label: 'Live', blurb: 'It has shipped. What matters now is whether it is holding up.' }
}

export interface ProjectDashboard {
  stage: ProjectStage
  live: { operating: number; problems: number; lastReleaseAt: string | null }
  next: { stage: 'building' | 'reviewing' | 'releasing' } | null
  releasing: { accepted: number; prepared: number; blocked: number; blocks: { code: string; detail: string }[] }
  watched: { id: string; name: string; state: string; at: string | null }[]
  metrics: PresentedMetric[]
  since: string
  firstLook: boolean
  finished: number
  failed: number
  delivered: number
  allTime: { finished: number; failed: number; delivered: number }
  standing: { queued: number; working: number; review: number; approved: number; failed: number }
  activityMeasured?: boolean
  decisions: number
  team: { total: number; working: number; people: { name: string; label: string }[] }
  perDay: { day: string; finished: number; failed: number; runs: number }[]
  quality: { finished: number; sentBack: number; overruled: number; overruledLast: string | null; refused: number }
  waiting: number
  waitingTop: string | null
  waitingTarget: 'yours' | 'fleet' | 'files' | 'marketing' | 'overview'
}

export interface OperationsSnapshot {
  present: { incidents: boolean; resources: boolean; schedules: boolean; knowledge: boolean; clientWork: boolean }
  delivery?: { purpose: 'personal' | 'client'; clientName: string; stage: string; basisChanged: boolean; issueCount: number } | null
  projectId: string; projectName: string; generatedAt: string; revision: number;
  resources: ResourceView[]; attention: OperationAttention[];
  notifications: OperationNotification[]; history: OperationHistoryEntry[];
  dashboard: ProjectDashboard;
  schedules: { id: string; text: string; paused: boolean; nextAt: number; lastRunAt?: number }[];
  findings: { id: string; statement: string; kind: string; at: string }[];
  sourceErrors: string[];
  jobSearch?: boolean;
}
export const CHECK_STATE_LABEL: Record<CheckState, string> = {
  unmonitored: 'Not monitored', unknown: 'Unknown', stale: 'Report out of date',
  'reported-pass': 'Reported OK · unverified', 'reported-failure': 'Problem reported', simulation: 'Simulation only'
}

export const SUGGESTED_CHECKS: Record<ResourceDefinition['kind'], { id: string; name: string; purpose: string; freshnessMinutes: number }[]> = {
  app: [
    { id: 'availability', name: 'Availability', purpose: 'Can a user complete the main app workflow?', freshnessMinutes: 30 },
    { id: 'errors', name: 'Crashes and errors', purpose: 'Track failures against the affected app version.', freshnessMinutes: 60 }
  ],
  service: [{ id: 'availability', name: 'Availability', purpose: 'Check the representative service outcome independently.', freshnessMinutes: 30 }],
  account: [
    { id: 'access', name: 'Account access', purpose: 'Can the approved integration still access this exact account?', freshnessMinutes: 1440 },
    { id: 'publishing', name: 'Publishing and results', purpose: 'Check intended posts, failed or uncertain sends, and agreed results.', freshnessMinutes: 1440 }
  ],
  automation: [{ id: 'expected-work', name: 'Expected work', purpose: 'Reconcile expected and actual completed work, including stale inputs.', freshnessMinutes: 60 }],
  other: []
}

export function resourceView(record: ResourceRecord, reports: OperationReport[], now: number): ResourceView {
  const relevant = reports.filter(report => report.input.resourceId === record.definition.id && report.input.resourceRevision === record.revision)
  const checks: CheckView[] = record.definition.checks.map(check => {
    const candidates = relevant.filter(report => report.input.checkId === check.id)
    const real = candidates.filter(report => report.origin !== 'simulation')
    const report = [...(real.length ? real : candidates)].sort((a, b) => Date.parse(b.input.occurredAt) - Date.parse(a.input.occurredAt) || b.input.id.localeCompare(a.input.id))[0]
    let state: CheckState = 'unmonitored'
    if (report) {
      const age = now - Date.parse(report.input.occurredAt)
      state = report.origin === 'simulation' ? 'simulation' : report.input.result === 'fail' ? 'reported-failure' : age < 0 || age > check.freshnessMinutes * 60000 ? 'stale' : report.input.result === 'pass' ? 'reported-pass' : 'unknown'
    }
    return { id: check.id, name: check.name, state, report }
  })
  const order: CheckState[] = ['reported-failure', 'stale', 'unknown', 'unmonitored', 'simulation', 'reported-pass']
  const state = order.find(value => checks.some(check => check.state === value)) ?? 'unmonitored'
  const previous = new Map<string, OperationReport>()
  for (const report of reports) {
    if (report.input.resourceId !== record.definition.id || report.input.resourceRevision >= record.revision || report.origin === 'simulation') continue
    const key = `${report.input.resourceRevision}:${report.input.checkId}`
    const old = previous.get(key)
    if (!old || Date.parse(report.input.occurredAt) > Date.parse(old.input.occurredAt) || (report.input.occurredAt === old.input.occurredAt && report.input.id > old.input.id)) previous.set(key, report)
  }
  const priorFailures = [...previous.values()].filter(report => report.input.result === 'fail')
  return { ...record, state, checks, priorFailures }
}
