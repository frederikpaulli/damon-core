import type { ProjectKind } from './file-role'

export type IdleCause = 'paused' | 'autopilot-off' | 'usage-limit' | 'owner' | 'waiting-to-start' | 'nothing-assigned'
export interface IdleFacts {
  now: number
  lastWorkAt: number | null
  running: number
  queued: { title: string; notBefore?: number; limitWait?: boolean; waitingFor?: string; onOwner?: boolean }[]
  openCards: number
  autopilot: boolean
  paused: boolean
  recentWorkAt: number | null
  lastWakeAt: number | null
  wakesToday: number
}
export interface IdleStep { cause: IdleCause | null; wake?: string; say?: string; error?: string; minutes?: number }
export const IDLE_LOG_AFTER_MS = 60_000
export const IDLE_AFTER_MS = 30 * 60_000
export const WAKE_AFTER_MS = 60 * 60_000
export const MAX_WAKES_A_DAY = 3
const ACTIVE_MS = 3 * 24 * 60 * 60_000

export const IDLE_WAKE_TEXT = 'Nothing has run in this project for an hour, nothing is queued and nothing waits on the owner. If the work the owner gave you is not finished, assign the next piece now (one feature job; screens first). If it is finished, or it waits on something only he can give, say so in one plain line and stop: do not start work the owner did not ask for.'

export const ONE_CARD_LINE = 'Never stop the project for one card: keep building independent work while a card waits.'
export const IDLE_CARD_WAKE_TEXT = `Nothing has run in this project for an hour while the owner's answer is awaited on his list. ${ONE_CARD_LINE} If the roadmap or the queue he gave you holds work that does not depend on what those cards decide, assign it now (one feature job; screens first). If everything left depends on his answer, say so in one plain line and stop: do not start work the owner did not ask for.`

export function idleAction(f: IdleFacts): IdleStep {
  const quietFor = f.lastWorkAt === null ? Infinity : f.now - f.lastWorkAt
  if (f.running > 0 || quietFor < IDLE_LOG_AFTER_MS) return { cause: null }
  const minutes = Number.isFinite(quietFor) ? Math.min(5, Math.floor(quietFor / 60_000)) : 5
  const step = idleCause(f, quietFor)
  return quietFor < IDLE_AFTER_MS ? { cause: step.cause, minutes } : { ...step, minutes }
}

function idleCause(f: IdleFacts, quietFor: number): IdleStep {
  if (f.paused) return { cause: 'paused' }
  if (f.queued.length && !f.autopilot) return { cause: 'autopilot-off', say: `${f.queued.length === 1 ? 'One job is' : `${f.queued.length} jobs are`} ready to run, but Autopilot is off for this project, so nothing starts until you say so.` }
  if (f.queued.length && f.queued.every((q) => q.limitWait)) return { cause: 'usage-limit' }
  const free = f.queued.filter((q) => !q.onOwner)
  if (free.length) {
    const first = free.find((q) => q.waitingFor) ?? free[0]!
    return { cause: 'waiting-to-start', ...(quietFor >= WAKE_AFTER_MS ? { error: `Nothing has run for ${Math.round(quietFor / 60_000)} minutes while "${first.title}" waits to start${first.waitingFor ? `: ${first.waitingFor}` : ''}.` } : {}) }
  }
  const active = f.recentWorkAt !== null && f.now - f.recentWorkAt < ACTIVE_MS
  const wokenThisStretch = f.lastWakeAt !== null && (f.lastWorkAt === null || f.lastWakeAt > f.lastWorkAt)
  const wake = active && quietFor >= WAKE_AFTER_MS && !wokenThisStretch && f.wakesToday < MAX_WAKES_A_DAY
  if (f.openCards > 0 || f.queued.length) return { cause: 'owner', ...(wake ? { wake: IDLE_CARD_WAKE_TEXT } : {}) }
  return { cause: 'nothing-assigned', ...(wake ? { wake: IDLE_WAKE_TEXT } : {}) }
}

export function autopilotFor(input: { saved?: boolean; kind?: ProjectKind; settings: { autopilot?: boolean; buildAutopilot?: boolean } }): boolean {
  if (typeof input.saved === 'boolean') return input.saved
  if (input.kind === 'build') return input.settings.buildAutopilot ?? true
  return input.settings.autopilot ?? false
}
