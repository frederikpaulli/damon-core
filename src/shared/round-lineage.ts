import { isAdminNote } from './rounds'
import { processFinding } from './file-role'

export interface LineageJob { id: string; writes?: string[]; feedback: string[]; lineage?: { rounds: number; pastCap: number; root: string; sent?: number }; status?: string }
export interface LineageAnswer { rounds: number; pastCap: number; root: string | null; from: string | null; needsOwner: boolean; sendBacks: number }

export const DECLARING_OR_CONTRACT = /(^|\/)(mod\.rs|lib\.rs|main\.rs|commands\.rs|index\.tsx?)$|(^|\/)(cargo\.toml|cargo\.lock|package\.json|package-lock\.json)$|^docs\/contracts\/|^docs\/METRICS\.md$/i
const exactWork = (writes: readonly string[]): string[] => writes.map(w => w.replace(/\\/g, '/').toLowerCase()).filter(w => !/[*?]/.test(w) && !DECLARING_OR_CONTRACT.test(w))

export function sameWork(newWrites: readonly string[], cappedWrites: readonly string[]): boolean {
  const mine = exactWork(newWrites), theirs = new Set(exactWork(cappedWrites))
  if (!mine.length) return false
  return mine.filter(f => theirs.has(f)).length * 2 >= mine.length
}

export function objectionsAboutWork(feedback: readonly string[]): boolean {
  return feedback.some(f => !isAdminNote(f) && !processFinding(f))
}

export function totalRounds(j: LineageJob, roundsOf: (f: string[]) => number): number { return (j.lineage?.rounds ?? 0) + roundsOf(j.feedback) }
export function sentBacks(j: LineageJob, roundsOf: (f: string[]) => number): number { return (j.lineage?.sent ?? j.lineage?.rounds ?? 0) + roundsOf(j.feedback) }

export function lineageOf(
  input: { continuesFrom?: string; steppedUpFrom?: string; writes?: string[] },
  find: (id: string) => LineageJob | undefined,
  capped: readonly LineageJob[],
  roundsOf: (f: string[]) => number,
  max: number
): LineageAnswer {
  const linked = [input.continuesFrom, input.steppedUpFrom].filter((x): x is string => Boolean(x)).map(find).filter((j): j is LineageJob => Boolean(j))
  const near = capped.filter(j => sameWork(input.writes ?? [], j.writes ?? []))
  const parents = [...new Map([...linked, ...near].map(j => [j.id, j])).values()]
  if (parents.length === 0) return { rounds: 0, pastCap: 0, root: null, from: null, needsOwner: false, sendBacks: 0 }
  let best = parents[0]!
  for (const p of parents) if (totalRounds(p, roundsOf) > totalRounds(best, roundsOf)) best = p
  const steps = parents.filter(p => totalRounds(p, roundsOf) >= max || (p.status !== 'approved' && (p.lineage?.pastCap ?? 0) > 0))
  const pastCap = Math.max(0, ...steps.map(p => (p.lineage?.pastCap ?? 0) + 1))
  const rounds = pastCap > 0 ? max - 1 : totalRounds(best, roundsOf)
  const needsOwner = pastCap >= 2 && objectionsAboutWork(parents.flatMap(p => p.feedback))
  return { rounds, pastCap, root: best.lineage?.root ?? best.id, from: best.id, needsOwner, sendBacks: Math.max(...parents.map(p => sentBacks(p, roundsOf))) }
}
