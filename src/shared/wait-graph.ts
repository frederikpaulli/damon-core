import type { TaskInfo } from './types'
import { scopeClash } from './scope'
import { fixLinedUp, heldByFault } from './known-faults'

export type WaitEdgeKind = 'needs' | 'fault' | 'objection' | 'coverage'
export interface WaitEdge { from: string; to: string; kind: WaitEdgeKind }
export interface WaitOpts { now: number; coverageWaits?: (t: TaskInfo) => string[]; capped?: (t: TaskInfo) => boolean }
export const OBJECTION_STANDS_MS = 30 * 60_000

const waiting = (t: TaskInfo): boolean => t.status === 'queued' || t.status === 'revising'
function standingRefusal(t: TaskInfo, o: WaitOpts): boolean {
  if (t.parkedFor) return false
  if (t.status === 'escalated') return true
  if (t.status !== 'review' || t.review?.satisfied !== false || t.review.overruledWhy || t.review.disputed || t.review.ran === false || t.gatePending) return false
  const at = Date.parse((t.review as { at?: string }).at ?? '')
  return (o.capped?.(t) ?? false) || (Number.isFinite(at) && o.now - at >= OBJECTION_STANDS_MS)
}

export function waitEdges(tasks: TaskInfo[], o: WaitOpts): WaitEdge[] {
  const byId = new Map(tasks.map(t => [t.id, t])); const out: WaitEdge[] = []
  for (const a of tasks) {
    if (!waiting(a)) continue
    for (const id of a.needs ?? []) { const d = byId.get(id); if (d && d.id !== a.id && d.status !== 'approved') out.push({ from: a.id, to: d.id, kind: 'needs' }) }
    const kept = heldByFault(a, tasks); const fix = kept ? fixLinedUp(kept, tasks) : undefined
    if (fix && fix.id !== a.id) out.push({ from: a.id, to: fix.id, kind: 'fault' })
    let covered: string[] = []
    try { covered = o.coverageWaits?.(a) ?? [] } catch { covered = [] }
    for (const d of covered) for (const p of tasks) if (p.id !== a.id && p.status !== 'approved' && p.deliverableIds?.includes(d)) out.push({ from: a.id, to: p.id, kind: 'coverage' })
  }
  for (const b of tasks) {
    if (!standingRefusal(b, o)) continue
    for (const a of tasks) if (waiting(a) && a.needs?.includes(b.id) && a.fixes !== b.id && a.writes?.length && b.writes?.length && scopeClash(a.writes, b.writes).length) out.push({ from: b.id, to: a.id, kind: 'objection' })
  }
  return out
}

export function findWaitCycles(tasks: TaskInfo[], o: WaitOpts): WaitEdge[][] {
  const from = new Map<string, WaitEdge[]>()
  for (const e of waitEdges(tasks, o)) from.set(e.from, [...(from.get(e.from) ?? []), e])
  const found = new Map<string, WaitEdge[]>()
  for (const start of [...from.keys()].sort()) {
    const walk = (at: string, path: WaitEdge[], seen: Set<string>): void => {
      if (path.length > 12) return
      for (const e of from.get(at) ?? []) {
        if (e.to === start) { const ring = [...path, e]; const key = ring.map(r => r.from).sort().join('|'); if (!found.has(key)) found.set(key, ring); continue }
        if (e.to < start || seen.has(e.to)) continue
        seen.add(e.to); walk(e.to, [...path, e], seen); seen.delete(e.to)
      }
    }
    walk(start, [], new Set([start]))
  }
  return [...found.values()]
}
