import { matchesScope } from '../../shared/scope'
import type { DeliverablePlan, WorkNeed } from '../../shared/work-needs'

export const ARCHIVE_FILE = 'work-needs-archive.json'
export const ARCHIVE_AFTER_DAYS = 14
export const ACTIVE_PLAN_CAP = 100
export const ARCHIVE_NEAR_CAP = 90

export interface ArchivedPlanEntry<T = DeliverablePlan> { archivedAt: string; position: number; plan: T }
export interface PlanArchive { version: 1; entries: ArchivedPlanEntry[] }

export interface ArchiveRefs {
  tasks: { id: string; writes?: string[]; deliverableIds?: string[] }[]
  files: string[]
  planIds: string[]
  folders: string[]
}

export const needSettled = (n: Pick<WorkNeed, 'retired' | 'ownerDecision' | 'answer'>): boolean => Boolean(n.retired || n.ownerDecision || (n.answer !== undefined && n.answer !== null && (n.answer as unknown) !== ''))
export const planClosed = (p: DeliverablePlan): boolean => Array.isArray(p.needs) && p.needs.length > 0 && p.needs.every(n => needSettled(n) && !n.issue)

const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
const isFoundation = (p: DeliverablePlan): boolean => /^coverage-/.test(p.id) || /^spec-sync-/.test(p.id) || p.outputs.some(f => norm(f).startsWith('damon-coverage/'))

export function planReferenced(p: DeliverablePlan, refs: ArchiveRefs): boolean {
  if (isFoundation(p) || refs.planIds.includes(p.id)) return true
  const files = new Set(refs.files.map(norm)), folders = refs.folders.map(norm).filter(Boolean)
  if (p.outputs.some(f => files.has(norm(f)) || folders.some(d => norm(f).startsWith(d + '/')))) return true
  return refs.tasks.some(t => Boolean(t.deliverableIds?.includes(p.id)) || p.taskIds.includes(t.id) || p.outputs.some(f => matchesScope(t.writes ?? [], f)))
}

export function archivable(p: DeliverablePlan, refs: ArchiveRefs, now: number): boolean {
  const at = Date.parse(p.updatedAt)
  return planClosed(p) && Number.isFinite(at) && at <= now - ARCHIVE_AFTER_DAYS * 24 * 3600 * 1000 && !planReferenced(p, refs)
}

export function latestEntries<T extends { id: string }>(entries: ArchivedPlanEntry<T>[]): Map<string, ArchivedPlanEntry<T>> {
  const latest = new Map<string, ArchivedPlanEntry<T>>()
  for (const e of entries) if (e?.plan && typeof e.plan.id === 'string') latest.set(e.plan.id, e)
  return latest
}

export function mergeArchived<T extends { id: string }>(main: T[], entries: { position: number; plan: T }[]): T[] {
  if (!entries.length) return main
  const inMain = new Set(main.map(p => p.id))
  const latest = new Map<string, { position: number; plan: T }>()
  for (const e of entries) if (e?.plan && typeof e.plan.id === 'string') latest.set(e.plan.id, e)
  const shelved = [...latest.values()].filter(e => !inMain.has(e.plan.id)).sort((a, b) => a.position - b.position)
  const out: T[] = []
  let i = 0
  for (const e of shelved) {
    while (out.length < e.position && i < main.length) out.push(main[i++]!)
    out.push(e.plan)
  }
  while (i < main.length) out.push(main[i++]!)
  return out
}

export function shelvedPlans<T extends { id: string }>(main: T[], entries: { position: number; plan: T }[]): T[] {
  const inMain = new Set(main.map(p => p.id))
  return [...latestEntries(entries as ArchivedPlanEntry<T>[]).values()].filter(e => !inMain.has(e.plan.id)).sort((a, b) => a.position - b.position).map(e => e.plan)
}

type TaskRef = ArchiveRefs['tasks'][number] & { status: string }
export function archiveRefsFrom(input: {
  tasks: TaskRef[]
  cards: { doneAt?: string; taskId?: string; file?: string; files?: string[]; need?: { deliverableId?: string }; also?: { deliverableId?: string }[] }[]
  lanes: { retired?: unknown; files: string[]; taskIds: string[]; scope: string }[]
  packageFolders?: string[]
  foundations: string[]
}): ArchiveRefs {
  const byId = new Map(input.tasks.map(t => [t.id, t]))
  const named = new Map<string, ArchiveRefs['tasks'][number]>()
  const name = (t: TaskRef | undefined): void => { if (t) named.set(t.id, { id: t.id, writes: t.writes, deliverableIds: t.deliverableIds }) }
  for (const t of input.tasks) if (t.status !== 'approved' && t.status !== 'failed') name(t)
  const files: string[] = [], planIds: string[] = [...input.foundations], folders: string[] = []
  for (const card of input.cards.filter(c => !c.doneAt)) {
    const cardFiles = [...(card.files ?? []), ...(card.file ? [card.file] : [])]
    files.push(...cardFiles)
    if (card.taskId) name(byId.get(card.taskId))
    for (const t of input.tasks) if (cardFiles.some(f => matchesScope(t.writes ?? [], f))) name(t)
    for (const n of [card.need, ...(card.also ?? [])]) if (n?.deliverableId) planIds.push(n.deliverableId)
  }
  for (const lane of input.lanes.filter(x => !x.retired)) {
    files.push(...lane.files)
    for (const id of lane.taskIds) {
      name(byId.get(id))
      if (id.startsWith('solo-review:')) planIds.push(id.slice('solo-review:'.length))
    }
    if (lane.scope.startsWith('deliverable:')) planIds.push(...lane.scope.slice('deliverable:'.length).split(','))
  }
  folders.push(...(input.packageFolders ?? []))
  return { tasks: [...named.values()], files, planIds, folders }
}
