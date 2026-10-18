import { classifyFailure, type FailureClass } from './failure-class'

export const AUTO_RETRIES = 3
export const MANAGER_RERUNS = 2
export const RECORDS_FAILED = 'The reviewer passed it, but Damon could not finish its own records'
export const OWNER_STOPPED = 'stopped'
export const OWNER_STOPPED_REVIEW_HEAD = 'The owner stopped the review of this job and sent it back to you. No round was spent.'
export const OWNER_STOPPED_NO_WORDS = 'The owner stopped the review and asked for changes.'
export const OWNER_STOPPED_DROPPED = 'The owner stopped the review and dropped this job.'
export const OWNER_STOPPED_ONLY = 'The owner stopped the review.'
export type ReviewInfraClass = FailureClass | 'records'
export type ReviewInfra = { cls: string; count: number; ownerAgain?: number; carded?: number }
const INFRA: ReadonlySet<FailureClass> = new Set(['seat', 'auth', 'silence', 'time', 'platform', 'recovery', 'restart', 'lane', 'copy', 'clock'])

export function reviewInfraClass(objection: string | undefined): ReviewInfraClass | null {
  const said = (objection ?? '').replace(/^The reviewer could not be run:\s*/, '')
  if (!said.trim()) return null
  if (said.startsWith(RECORDS_FAILED)) return 'records'
  const cls = classifyFailure(said)
  return INFRA.has(cls) ? cls : null
}

export const retriesItself = (cls: string): boolean => cls !== 'records'

export function reviewRetryDelayMs(count: number, cls: string): number {
  const base = cls === 'seat' || cls === 'auth' ? 60_000 : 30_000
  return Math.min(base * 2 ** Math.max(0, count - 1), 10 * 60_000)
}

export function reviewRunsAllowed(infra: ReviewInfra): number {
  return (retriesItself(infra.cls) ? AUTO_RETRIES + 1 : 1) + MANAGER_RERUNS + (infra.ownerAgain ?? 0)
}
export const reviewCapped = (infra: ReviewInfra | undefined): boolean => !!infra && infra.count >= reviewRunsAllowed(infra)

export function reviewRoom(previous: { ran?: boolean; infra?: { cls: string; count: number } } | undefined, critic = false): { turnMs: number; silenceMs: number; longer: boolean } {
  if (critic) return { turnMs: 45 * 60_000, silenceMs: 20 * 60_000, longer: false }
  const longer = previous?.ran === false && (previous.infra?.cls === 'silence' || previous.infra?.cls === 'time')
  return longer ? { turnMs: 20 * 60_000, silenceMs: 15 * 60_000, longer } : { turnMs: 15 * 60_000, silenceMs: 12 * 60_000, longer }
}

export function reviewInfraReason(objection: string | undefined, cls: string): string {
  const said = (objection ?? '').replace(/Partial report:[\s\S]*$/, '')
  if (cls === 'records') return 'Damon could not finish its own records after the reviewer passed it'
  if (cls === OWNER_STOPPED) return 'you stopped it'
  if (/another Claude Code process is refreshing it/i.test(said)) return 'two of Damon\'s own Claude programs renewed the sign-in at the same moment'
  if (/Docker/i.test(said)) return 'Docker Desktop was not running'
  if (cls === 'auth') return 'the Claude sign-in has expired or needs renewing'
  if (cls === 'silence') return 'it went quiet for longer than Damon waits'
  if (cls === 'time') return 'it ran past its time limit'
  if (cls === 'seat') return 'no seat came free in time'
  if (cls === 'restart') return 'Damon was closed or restarted while it ran'
  return 'it stopped for a reason in Damon\'s own machinery'
}
export const getsMoreTime = (cls: string): boolean => cls === 'silence' || cls === 'time'

export function reviewInfraWords(title: string, cls: string, count: number, objection?: string): string {
  const left = Math.max(0, MANAGER_RERUNS - Math.max(0, count - (retriesItself(cls) ? AUTO_RETRIES + 1 : 1)))
  const again = cls === 'records'
    ? `Fix that first (give the file to a job that may write it, or take it off the deliverable), then approve again to run the review once more.`
    : `Approving again runs the review once more${getsMoreTime(cls) ? ', with more time' : ''}.`
  const landed = LANDED_CHECK_NOT_RUN.test((objection ?? '').replace(/^The reviewer could not be run:\s*/, ''))
  const where = landed ? 'the reviewed draft is in the project folder, and Damon\'s own final check on it has not run yet' : 'its draft has NOT landed'
  return `The independent review of "${title}" did not finish ${count} time${count === 1 ? '' : 's'} in a row: ${reviewInfraReason(objection, cls)}. That is not a verdict on the work, nothing is on record against it, and ${where}. ${again} You may do that ${left} more time${left === 1 ? '' : 's'}; after that Damon stops and asks the owner.`
}
const LANDED_CHECK_NOT_RUN = /^Damon's own final check on the landed draft did not run \(/

export function reviewStuckCard(title: string, cls: string, count: number, objection?: string): { title: string; what: string } {
  if (cls === OWNER_STOPPED) return {
    title: `You stopped the review of “${title}”`,
    what: 'Nobody reviewed this draft, and it is not in your folder yet. Choose one: Keep it, after reading the draft yourself on the Files tab, and it goes into your folder as yours; Send it back, and the writer does it again; or Try the review again now.'
  }
  return {
    title: `The review of “${title}” could not finish`,
    what: `Damon tried the independent review ${count} times and it never finished, because ${reviewInfraReason(objection, cls)}; it says nothing about the work itself, and the draft is not in your folder yet. Choose one: Keep it, after reading the draft yourself on the Files tab, and it goes into your folder as yours; Send it back, and the writer does it again; or Try the review again now, once more.`
  }
}
