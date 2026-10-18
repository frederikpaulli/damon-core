import { actedOn, busyJobs } from './busy-files'
import type { TaskInfo } from './types'

type Card = { kind?: string; file?: string; files?: readonly string[] }
type Job = Pick<TaskInfo, 'status' | 'writes'> & { title?: string; label?: string }

export function autoCheckTargets(item: Card, also: readonly string[] = []): string[] {
  return [...new Set([...actedOn({ ...item, kind: 'submit' }), ...actedOn({ files: also })])]
}

export const QUEUED_HOLDS_MS = 30 * 60_000
const SOON_MS = 5 * 60_000
type Queued = Job & { id?: string; needs?: string[]; waitingFor?: string; parkedFor?: string; refusedFor?: string; notBefore?: number; updatedAt?: string; createdAt?: string; seatWaitSince?: string }
export function queuedCanStart(t: Queued, tasks: readonly Queued[], now: number, paused = false): boolean {
  if (t.status !== 'queued' && t.status !== 'revising') return true
  if (paused || t.waitingFor || t.parkedFor || t.refusedFor) return false
  if (typeof t.notBefore === 'number' && t.notBefore - now > SOON_MS) return false
  if ((t.needs ?? []).some(id => tasks.find(x => x.id === id)?.status !== 'approved')) return false
  const since = Date.parse(t.seatWaitSince ?? t.updatedAt ?? t.createdAt ?? '')
  return !(Number.isFinite(since) && now - since >= QUEUED_HOLDS_MS)
}

export function autoCheckBusy<T extends Job>(item: Card, tasks: readonly T[] | undefined, also: readonly string[] = [], opts: { now?: number; paused?: boolean } = {}): T[] {
  const all = (tasks ?? []) as readonly Queued[]
  const now = opts.now ?? Date.now()
  return busyJobs(autoCheckTargets(item, also), tasks).filter(t => queuedCanStart(t as Queued, all, now, opts.paused))
}

export function queuedCheckWords(place: 'started' | 'waiting' | 'already', ownRunning: boolean, running: string, waiting: string, started: string): string {
  if (place === 'started') return started
  return ownRunning ? running : waiting
}

export type AutoCheckStep = 'none' | 'wait-for-team' | 'wait-for-quiet' | 'start'

export function autoCheckStep(input: { blocked: boolean; onlyOwnCheck: boolean; busy: number; stillMs: number; quietMs: number }): AutoCheckStep {
  if (!input.blocked || !input.onlyOwnCheck) return 'none'
  if (input.busy > 0) return 'wait-for-team'
  if (input.stillMs < input.quietMs) return 'wait-for-quiet'
  return 'start'
}

const short = (s: string): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t }

export function checkWaitsForTeam(jobs: readonly Job[]): string {
  const first = jobs[0]
  const named = first ? `"${short(first.label || first.title || 'a job')}"${jobs.length > 1 ? ` and ${jobs.length - 1} more` : ''}` : 'a job'
  return `Damon runs its own final check on this package once the team has finished changing its files. Still changing them: ${named}. The check starts by itself when the last one lands. Nothing has been sent, and nothing is lost.`
}

export const CHECK_WAITING_TO_START =
  "Damon's own final check on this package is waiting to start: Damon runs one of its own checks at a time on this project, and another one is running first. " +
  'It starts by itself. Nothing has been sent, and nothing is lost.'

export const CHECK_ANYWAY_TITLE = 'Damon runs its own final check now, on the files as they are. The jobs still changing them carry on; nothing is sent.'

export const MOVED_RESTARTS_PER_HOUR = 3
export const MOVED_HOLD_MS = 10 * 60_000
export class MovedStopLimiter {
  private seen = new Map<string, number[]>()
  note(key: string, now: number = Date.now()): 'silent' | 'report' {
    const recent = (this.seen.get(key) ?? []).filter(t => now - t < 3_600_000)
    recent.push(now)
    if (recent.length > MOVED_RESTARTS_PER_HOUR) { this.seen.delete(key); return 'report' }
    this.seen.set(key, recent)
    return 'silent'
  }
}
export function movedTooOften(times: number, why: string): string {
  return `Damon's own final check on this package was stopped ${times} times in the last hour because files it reads kept changing (last: ${why.replace(/\s+/g, ' ').trim().slice(0, 200)}). Damon has stopped restarting it for 10 minutes. If nothing should be changing these files, look at what is.`
}

export function notRunMeaning(input: { limited?: boolean; retired: boolean; objections: readonly string[]; stopSentences: readonly string[] }): 'moved' | 'failed' {
  if (input.limited) return 'failed'
  return input.retired || input.objections.some(o => input.stopSentences.some(s => o.includes(s))) ? 'moved' : 'failed'
}

export type CheckOrigin = 'automatic' | 'press'

export function checkOriginTag(origin: CheckOrigin, what: 'Send' | 'Apply'): string {
  return origin === 'press' ? `[The owner pressed ${what}]` : "[Damon's automatic final check]"
}

export function checkReportForManager(origin: CheckOrigin, what: 'Send' | 'Apply', critiqueId: string, said: string): string {
  if (origin === 'press') {
    return `${checkOriginTag(origin, what)} He is waiting on Damon's own final check before this goes out. I ran it for him: critique ${critiqueId}. It said: ${said}. Read what it found through read_work_history, fix what it names, and tell him when it is clear. Do not send or submit anything yourself: he presses the button.`
  }
  return `${checkOriginTag(origin, what)} Damon ran its own final check by itself, before asking the owner; he did not press ${what}. Critique ${critiqueId}. It said: ${said}. Read what it found through read_work_history and fix what it names. When you tell him about it, say Damon ran the check, not that he pressed anything. Do not send or submit anything yourself: he presses the button.`
}

export function admissionInputMoved(objections: readonly string[]): boolean {
  return objections.some(o => /Protected work could not be admitted: An approved input changed\b/.test(o))
}
export const CHECK_REGRANTED =
  "Damon's own final check could not start because a file in this package changed after it was approved. " +
  'Damon approved the files as they are now and will run the check again by itself shortly. Nothing has been sent, and nothing is lost.'
