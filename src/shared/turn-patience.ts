const minutes = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`
}

export const SILENCE_LIMIT_MS = 25 * 60 * 1000

export const COMMAND_SILENCE_MS = 45 * 60 * 1000

export function patienceFor(
  commandOutstanding: boolean,
  idleLimitMs: number,
  commandLimitMs: number = COMMAND_SILENCE_MS
): number {
  return commandOutstanding ? Math.max(idleLimitMs, commandLimitMs) : idleLimitMs
}

const FIRST_NOTICE_MS = 2 * 60 * 1000
const NOTICE_EVERY_MS = 4 * 60 * 1000

export function noticeDueAt(alreadySaid: number): number {
  return FIRST_NOTICE_MS + Math.max(0, alreadySaid) * NOTICE_EVERY_MS
}

const SETTLING_MS = 25_000

export function thinkingLine(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < SETTLING_MS) return 'Thinking…'
  return 'Still thinking. Nothing to show yet.'
}

export function waitingNotice(
  lastActivity: string | undefined,
  quietForMs: number,
  limitMs: number = SILENCE_LIMIT_MS
): string {
  const doing = lastActivity?.trim()
  const what = doing ? `on “${doing}”` : 'on a command that has not answered yet'
  const stops = Math.round(limitMs / 60_000)
  return `Damon is still working, waiting ${what} for ${minutes(quietForMs)}. Long builds and installers look like this. It will stop and hand back if nothing happens by ${stops} minutes.`
}

export function shouldGiveUp(o: {
  sinceLastOutputMs: number
  elapsedMs: number
  limitMs?: number
}): boolean {
  return o.sinceLastOutputMs > (o.limitMs ?? SILENCE_LIMIT_MS)
}

export const SILENCE_CHECK_MS = 15_000

export const LATE_TICK_FACTOR = 3

export function sleptThrough(sinceLastTickMs: number, tickMs: number): number {
  if (!Number.isFinite(sinceLastTickMs) || !Number.isFinite(tickMs) || tickMs <= 0) return 0
  return sinceLastTickMs > tickMs * LATE_TICK_FACTOR ? sinceLastTickMs - tickMs : 0
}

export function giveUpReason(lastActivity: string | undefined, silentForMs: number): string {
  const doing = lastActivity?.trim()
  const what = doing ? `waiting on “${doing}”` : 'waiting on something that never answered'
  return [
    `Damon was ${what} and said nothing for ${minutes(silentForMs)}, so it was stopped.`,
    'Whatever it started may still be running, an installer or a long command carries on after Damon is stopped, so check before starting another one.',
    'Press “Pick up the work” when you are ready for it to carry on.'
  ].join(' ')
}

export { MAX_COUNTED_CHECKS } from './broker-call-limits'

export interface TurnClock { pause(): void; resume(): void; stop(): void }
export function turnClock(budgetMs: number, pauseAllowanceMs: number, onTimeout: () => void, now: () => number = Date.now): TurnClock {
  let left = budgetMs, armedAt = now(), paused = 0, stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, budgetMs)
  const wall = setTimeout(fire, budgetMs + Math.max(0, pauseAllowanceMs))
  function fire(): void { if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(wall); onTimeout() }
  return {
    pause() { if (stopped || paused++ > 0) return; clearTimeout(timer); timer = undefined; left -= now() - armedAt },
    resume() { if (stopped || paused === 0 || --paused > 0) return; armedAt = now(); timer = setTimeout(fire, Math.max(0, left)) },
    stop() { stopped = true; clearTimeout(timer); clearTimeout(wall) }
  }
}

export function approvedCheckIn(command: string, approved: readonly string[]): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const c = norm(command).replace(/\s*\|\s*tail\s+(?:-n\s*)?-?\d+\s*$/i, '').replace(/\s*2>&1\s*$/, '')
  return approved.find(a => norm(a) === c) ?? null
}
