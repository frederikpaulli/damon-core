import { classifyFailure, CONTINUATION, type FailureClass } from './failure-class'
import { CLOCK_RETRY_LINE } from './clock-wait'

export const MAX_ATTEMPTS = 6
export const MAX_CONTINUATIONS = 2
export const MAX_SILENCE_RERUNS = 2
export const MAX_PLATFORM_RERUNS = 2
export const MAX_SEAT_WAIT_MS = 3 * 60 * 60_000

export type AttemptDecision =
  | { action: 'retry'; cls: FailureClass; why: string }
  | { action: 'escalate'; cls: FailureClass; why: string }
  | { action: 'fail'; cls: FailureClass }

export function decideAttempt(
  task: { id: string; attempts?: { cls: FailureClass; at: string }[]; seatWaitSince?: string },
  resultText: string | undefined,
  now: number
): AttemptDecision {
  const cls = classifyFailure(resultText)
  if (/^(send|apply):/.test(task.id)) return { action: 'fail', cls }
  const past = (task.attempts ?? []).filter(a => a.cls !== 'restart')
  if (cls === 'seat' || cls === 'lane') {
    const since = task.seatWaitSince ? Date.parse(task.seatWaitSince) : now
    if (now - since > MAX_SEAT_WAIT_MS) return { action: 'escalate', cls, why: 'It has waited over three hours for a free seat without starting.' }
    return { action: 'retry', cls, why: 'it could not start' }
  }
  if (cls === 'copy') return past.filter(a => a.cls === 'copy').length >= 2 ? { action: 'escalate', cls, why: 'Its working copy could not be made three times in a row.' } : { action: 'retry', cls, why: WORDS.copy }
  if (cls !== 'recovery' && cls !== 'clock' && cls !== 'silence' && cls !== 'platform' && !CONTINUATION.has(cls)) return { action: 'fail', cls }
  if (past.length + 1 >= MAX_ATTEMPTS) return { action: 'escalate', cls, why: `It has ended ${past.length + 1} times without finishing (the last: ${WORDS[cls]}).` }
  if (cls === 'clock' && past.some(a => a.cls === 'clock')) return { action: 'escalate', cls, why: 'It waited on the clock twice and was stopped both times: a check that depends on the date has to set the date itself, or report the date it fails on.' }
  if (cls === 'silence' && past.filter(a => a.cls === 'silence').length >= MAX_SILENCE_RERUNS) return { action: 'escalate', cls, why: `It went quiet and was stopped ${MAX_SILENCE_RERUNS + 1} times: something in it waits without a word (a command that never ends, or a long check that prints nothing). Its draft so far is kept.` }
  if (cls === 'platform' && past.filter(a => a.cls === 'platform').length >= MAX_PLATFORM_RERUNS) return { action: 'escalate', cls, why: 'The program broke its own protocol three times (a second init frame); this needs a look at the program, not the work.' }
  if (CONTINUATION.has(cls) && past.filter(a => CONTINUATION.has(a.cls)).length >= MAX_CONTINUATIONS) {
    return { action: 'escalate', cls, why: `It ran out of ${cls === 'time' ? 'time' : 'steps'} ${MAX_CONTINUATIONS + 1} times; it needs splitting into smaller jobs or a different approach.` }
  }
  return { action: 'retry', cls, why: WORDS[cls] }
}

const WORDS: Record<FailureClass, string> = {
  seat: 'no seat came free', lane: 'another run held its lane', copy: 'its copy could not be made',
  recovery: 'its program’s exit could not be confirmed, so nothing it produced was used',
  turns: 'it ran out of steps', time: 'it ran out of time', restart: 'Damon was closed while it ran',
  input: 'its inputs changed', auth: 'a sign-in expired', work: 'the work itself',
  clock: 'it waited on the clock, so Damon stopped it',
  silence: 'it went quiet and was stopped', platform: 'the program Damon runs failed, not the work'
}

export function continuationBudget(attempts: { cls: FailureClass }[] | undefined, steps: number, timeoutMs: number): { steps: number; timeoutMs: number } {
  const last = attempts?.filter(a => a.cls !== 'restart').at(-1)?.cls
  return {
    steps: last === 'turns' ? Math.min(150, Math.ceil(steps * 1.5)) : steps,
    timeoutMs: last === 'time' ? Math.min(3_600_000, Math.ceil(timeoutMs * 1.5)) : timeoutMs
  }
}

export function attemptNote(cls: FailureClass, partial: string | undefined): string {
  const head = cls === 'clock'
    ? `${CLOCK_RETRY_LINE}\nThis is the same job again: check what is already on disk before redoing anything, and never wait for a date or a time of day.`
    : cls === 'silence'
      ? 'YOUR LAST RUN OF THIS JOB WENT QUIET AND WAS STOPPED before Damon heard it finish. This is the same job again, and your draft so far is in the copy: check what is already on disk, finish what is left, and report. Never leave a command running that does not end by itself; run a long check with a time limit or in parts.'
      : cls === 'platform'
        ? 'YOUR LAST RUN OF THIS JOB ENDED ON A FAULT IN THE PROGRAM DAMON RUNS, not in your work. This is the same job again: check what is already on disk before redoing anything.'
        : CONTINUATION.has(cls)
          ? `YOUR LAST RUN OF THIS JOB ${cls === 'time' ? 'RAN OUT OF TIME' : 'RAN OUT OF STEPS'} before it finished. This is the same job, continued: do not start over. Check what is already on disk, then finish what is left, in fewer steps.`
          : 'YOUR LAST RUN OF THIS JOB ENDED BEFORE DAMON COULD CONFIRM ITS PROGRAM HAD CLOSED, so nothing it produced was used. This is the same job again: check what is on disk before redoing anything.'
  return partial ? `${head}\n\nYour own report so far:\n${partial.slice(0, 4000)}` : head
}
