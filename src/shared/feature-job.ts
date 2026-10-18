import { classifyFailure } from './failure-class'
import type { Checkpoint, CheckpointEntry, Handoff } from '../main/lib/checkpoint-store'

export interface FeatureState { checkpoints: number; sessions: number; sessionsTotal: number; maxSessions: number; startedAt: string; steps: string[] }
export const SESSION_HEAD = 'YOUR FEATURE JOB CONTINUES'
export const NOTES_HEAD = 'Your own notes from your last checkpoint:'
export const HANDOFF_HEAD = 'Your handoff from your last checkpoint:'
export const FEATURE_REVIEW_STEPS = 150
export const DEFAULT_FEATURE_SESSIONS = 8
export const DEFAULT_FEATURE_JOBS_AT_ONCE = 1

export type SessionDecision = { action: 'none' } | { action: 'continue'; why: string } | { action: 'escalate'; why: string }

export function asksForCheckpoint(reply: string): boolean {
  const last = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
  const bare = last.replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '')
  return /^CHECKPOINT:/.test(bare)
}

export function nextSession(task: { feature?: FeatureState }, outcome: { ok: boolean; resultText?: string }): SessionDecision {
  if (!task.feature) return { action: 'none' }
  const said = outcome.resultText ?? ''
  const cls = outcome.ok ? null : classifyFailure(said)
  const asked = outcome.ok && asksForCheckpoint(said)
  const ranOut = cls === 'turns' || cls === 'time'
  if (!asked && !ranOut) return { action: 'none' }
  if (task.feature.sessions + 1 >= task.feature.maxSessions) return { action: 'escalate', why: `It used all ${task.feature.maxSessions} sessions this round without reporting the piece finished. Its work so far is kept in its last checkpoint and draft: give it again with continues_from, or split what is left into its own piece.` }
  if (task.feature.sessionsTotal + 1 >= 2 * task.feature.maxSessions) return { action: 'escalate', why: `It has run ${task.feature.sessionsTotal + 1} sessions over its rounds. Its work is kept: decide with the owner whether the piece is too big or the approach wrong before it runs again.` }
  return { action: 'continue', why: asked ? 'it saved a checkpoint and asked for a fresh session' : cls === 'time' ? 'its session ran out of time' : 'its session ran out of steps' }
}

export const FEATURE_NEAR_FULL = { files: 15, bytes: 300_000 }
export const FEATURE_REVIEW_MAX = { files: 20, bytes: 500_000 }

export function nearFullWarning(files: number, bytes: number): string | null {
  if (files < FEATURE_NEAR_FULL.files && bytes < FEATURE_NEAR_FULL.bytes) return null
  return `THIS PIECE IS NEAR ITS SIZE LIMIT: ${files} changed file${files === 1 ? '' : 's'} (${Math.round(bytes / 1000)} KB) of about ${FEATURE_REVIEW_MAX.files} files, what its reviewers can read with care in one sitting. Finish the step you are on, check it, and report finished, saying what is left for the next piece.`
}

export function handoffBlock(h: Handoff): string {
  const decisions = (h.decisions ?? []).slice(0, 8), open = (h.open ?? []).slice(0, 8)
  return [
    HANDOFF_HEAD,
    ...(decisions.length ? ['Decisions:', ...decisions.map((d) => `- ${d}`)] : []),
    ...(open.length ? ['Still open:', ...open.map((o) => `- ${o}`)] : [])
  ].join('\n')
}

export function notPreservedLine(skipped: readonly string[]): string {
  if (!skipped.length) return ''
  return `NOT PRESERVED between sessions or in the draft (Damon keeps text files only, at most 1 MB each and 4 MB in all): ${skipped.slice(0, 40).join(', ')}${skipped.length > 40 ? ' and more' : ''}. Make them again from their sources in the session that needs them, or name them in the report.`
}

export function manifestLines(cp: Pick<Checkpoint, 'removed' | 'reset' | 'skipped'> | null, handoff: Handoff | null, prompt: string): string[] {
  const removed = cp?.removed ?? [], reset = cp?.reset ?? []
  return [
    ...(removed.length || reset.length ? ['YOUR CHECKPOINT ALSO ' + [removed.length ? 'REMOVED ' + removed.join(', ') : '', reset.length ? "PUT BACK TO THE PROJECT'S VERSION " + reset.join(', ') : ''].filter(Boolean).join('; ') + '. A deletion stays in your copy between sessions but never reaches your draft: name each file to delete in your report. Your checks ran without the removed files, while the review and the landing will still have them.'] : []),
    ...(cp?.skipped?.length ? [notPreservedLine(cp.skipped)] : []),
    ...(handoff && (handoff.decisions?.length || handoff.open?.length) && !prompt.includes(HANDOFF_HEAD) ? [handoffBlock(handoff)] : [])
  ]
}

export function sessionNote(input: { title: string; feature: FeatureState; log: readonly CheckpointEntry[]; partial?: string; files?: readonly string[]; bytes?: number; handoff?: Handoff }): string {
  const own = input.log.filter((e) => !e.auto)
  const last = input.log.at(-1)
  const files = input.files ?? []
  const nearFull = nearFullWarning(files.length, input.bytes ?? 0)
  return [
    `${SESSION_HEAD}: "${input.title}", session ${input.feature.sessions + 1} of at most ${input.feature.maxSessions}. Your work so far is already laid over this copy, from your newest checkpoint and draft. Do not start over and do not re-read the whole project: read what the next step needs.`,
    `The plan: ${input.feature.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    own.length ? `Done so far:\n${own.map((e) => `- ${e.done}`).join('\n')}` : 'No checkpoint was saved by you yet; look at what is in the copy first.',
    files.length ? `The files you have changed so far (${files.length}): ${files.slice(0, 40).join(', ')}${files.length > 40 ? ' and more' : ''}.` : '',
    `Next: ${last?.next || own.at(-1)?.next || input.feature.steps[0]}`,
    last?.notes ? `${NOTES_HEAD}\n${last.notes.slice(0, 2000)}` : '',
    input.handoff && (input.handoff.decisions?.length || input.handoff.open?.length) ? handoffBlock(input.handoff) : '',
    nearFull ?? '',
    input.partial ? `Your report when the last session ended:\n${input.partial.slice(0, 3000)}` : '',
    'Carry on: after each step that works, run its checks, look at the screen if it has one, and call save_checkpoint. Report finished only when every step of the plan is done and the checks pass.'
  ].filter(Boolean).join('\n\n')
}

export function featureBlock(feature: FeatureState): string {
  return [
    'THIS IS A FEATURE JOB: the whole piece, built by you in one long run, like one long working session.',
    `Your plan, in order: ${feature.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    'After each step: run the checks for what you changed (below), look at the screen if it has one, then call save_checkpoint with what is done and what is next, and carry straight on.',
    'A session ends when its hour or its 150 steps run out. Damon then starts the next one from your newest checkpoint, in a fresh copy that already holds your work, with your notes: save often, and write notes a stranger could continue from. If your context grows long and muddled, call save_checkpoint and end your reply with a line starting CHECKPOINT: you get a fresh session.',
    `Report finished only when every step is done and the checks pass. The piece is then reviewed once, as a whole, by two reviewers side by side: one reads the code and runs its checks, one judges how it looks. A piece is at most what they can read with care in one sitting, about ${FEATURE_REVIEW_MAX.files} changed files: Damon warns you at ${FEATURE_NEAR_FULL.files}; past that, finish the step you are on, report finished, and say what is left for the next piece.`
  ].join('\n')
}

export function featureRoomBlocker(task: { id: string; feature?: FeatureState }, running: readonly { id: string; feature?: FeatureState; status: string }[], cap: number): string | null {
  if (!task.feature) return null
  const busy = running.filter((t) => t.id !== task.id && t.feature && t.status === 'working').length
  return busy >= cap ? `Waiting: this computer runs ${cap === 1 ? 'one feature job at a time' : `${cap} feature jobs at a time`}, so a seat stays free for reviews; it starts when the running one ends a session or finishes.` : null
}

export function featureLeftWorking(seen: Set<string>, projectId: string, task: { id: string; feature?: FeatureState; status: string }): boolean {
  if (!task.feature) return false
  const key = `${projectId}:${task.id}`
  if (task.status === 'working') { seen.add(key); return false }
  return seen.delete(key)
}

export interface ReviewLike { satisfied: boolean; ran: boolean; objections: string[] }
export function mergeFeatureReviews<T extends ReviewLike>(code: T, look: ReviewLike): T {
  if (!look.ran) return { ...code, satisfied: false, ran: false, objections: [...code.objections, ...look.objections.map((o) => `The careful visual review: ${o}`)] }
  if (look.satisfied) return code
  return { ...code, satisfied: false, objections: [...code.objections, ...look.objections.map((o) => `The careful visual review: ${o}`)] }
}
