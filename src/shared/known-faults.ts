import type { TaskInfo } from './types'
import { scopeClash } from './scope'

export const FAULT_REMINDER_MS = 24 * 60 * 60 * 1000
export interface KnownFault { objection: string; keptAt: string; releasedAt?: string; verifiedFixId?: string; heldDraft?: string; heldFiles?: string[]; supersededBy?: string }

export function fixPassed(t: Pick<TaskInfo, 'status' | 'review'>): boolean {
  return t.status === 'approved' && t.review?.satisfied === true && !t.review?.overruledWhy
}
export function fixOf(kept: Pick<TaskInfo, 'id' | 'knownFault'>, tasks: TaskInfo[]): Pick<TaskInfo, 'id'> | undefined {
  const stamped = kept.knownFault?.verifiedFixId
  if (stamped) return tasks.find(t => t.id === stamped) ?? { id: stamped }
  return tasks.find(t => t.fixes === kept.id && fixPassed(t))
}
export function stampVerifiedFixes(tasks: TaskInfo[]): boolean {
  let changed = false
  for (const fix of tasks) {
    if (!fix.fixes || !fixPassed(fix)) continue
    const kept = tasks.find(t => t.id === fix.fixes)
    if (!kept?.knownFault || kept.knownFault.verifiedFixId) continue
    kept.knownFault = { ...kept.knownFault, verifiedFixId: fix.id }
    changed = true
  }
  return changed
}
export function faultOpen(kept: TaskInfo, tasks: TaskInfo[]): boolean {
  return !!kept.knownFault && !kept.knownFault.releasedAt && !fixOf(kept, tasks)
}
export function holdsDraft(task: Pick<TaskInfo, 'knownFault'>): boolean {
  return !!task.knownFault && !task.knownFault.releasedAt && !task.knownFault.verifiedFixId
}
export function heldDraftOut(task: Pick<TaskInfo, 'knownFault'>): boolean {
  const k = task.knownFault
  return !!k && (holdsDraft(task) || (!!k.heldDraft && (!!k.supersededBy || !!k.verifiedFixId)))
}
export function carriesHeldFiles(kept: Pick<TaskInfo, 'knownFault'>, written: string[]): boolean {
  const w = new Set(written.map(p => p.toLowerCase()))
  return !!kept.knownFault?.heldFiles && kept.knownFault.heldFiles.every(p => w.has(p.toLowerCase()))
}
export function heldFaultDraftFrom(task: Pick<TaskInfo, 'fixes'>, tasks: TaskInfo[]): string | undefined {
  if (!task.fixes) return undefined
  const kept = tasks.find(t => t.id === task.fixes)
  return kept?.knownFault?.heldDraft && faultOpen(kept, tasks) ? kept.id : undefined
}
export function heldByFault(task: TaskInfo, tasks: TaskInfo[]): TaskInfo | null {
  for (const kept of tasks) {
    if (kept.id === task.id || task.fixes === kept.id || !faultOpen(kept, tasks)) continue
    if (task.needs?.includes(kept.id)) return kept
    if (task.writes?.length && kept.writes?.length && scopeClash(task.writes, kept.writes).length) return kept
  }
  return null
}
export function overdueFaults(tasks: TaskInfo[], nowMs: number): TaskInfo[] {
  return tasks.filter(t => faultOpen(t, tasks) && nowMs - Date.parse(t.knownFault!.keptAt) >= FAULT_REMINDER_MS)
}
export function fixCriterion(kept: Pick<TaskInfo, 'title' | 'label' | 'knownFault' | 'review'>): string {
  return `The fault the reviewer found in "${kept.label ?? kept.title}" is fixed, and a test that fails without the fix shows it: ${kept.knownFault?.objection ?? kept.review?.objection ?? ''}`
}

export function canBeFixed(target: TaskInfo, tasks: TaskInfo[]): boolean {
  if (faultOpen(target, tasks)) return true
  return target.status === 'review' && !!target.review && target.review.satisfied === false && !target.review.overruledWhy && target.review.ran !== false
}
export function fixLinedUp(kept: Pick<TaskInfo, 'id'>, tasks: TaskInfo[]): TaskInfo | undefined {
  return tasks.find(t => t.fixes === kept.id && t.status !== 'failed')
}
export function acceptableAsKnownFault(task: Pick<TaskInfo, 'finalizesDeliverables'>): boolean {
  return !task.finalizesDeliverables
}

export function fixWaitsOn(fix: Pick<TaskInfo, 'title'> | undefined): string {
  if (!fix) return ''
  return ` Its fix "${fix.title}" is waiting for this job to be accepted, so neither can move until you act: record that evidence (supply_need) and approve again, or drop this job and give the fix the files in the folder in its place (amend_task with replace_prerequisite).`
}
