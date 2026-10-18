import type { TaskInfo } from './types'

const ACTIVE: readonly string[] = ['queued', 'working', 'reviewing', 'review', 'revising']
const WAITING: readonly string[] = ['paused', 'escalated']

type Job = Pick<TaskInfo, 'status' | 'writes'> & { title?: string; label?: string }

const norm = (p: string): string => p.trim().replace(/[\\]/g, '/').replace(/^\.\//, '').replace(/\/+\*{0,2}$/, '').replace(/\/+$/, '').toLowerCase()
const dirOf = (p: string): string => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '' }
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
const SHARED = /^attachments(\/|$)/

export function actedOn(item: { kind?: string; file?: string; files?: readonly string[] }): string[] {
  const files = [...(item.files ?? []), ...(item.file ? [item.file] : [])].map(norm).filter(Boolean)
  let folders: string[] = []
  if (item.kind === 'submit') {
    const own = item.file ? dirOf(norm(item.file)) : ''
    if (own && !SHARED.test(own)) folders = [own]
    else {
      const count = new Map<string, number>()
      for (const d of files.map(dirOf).filter(d => d && !SHARED.test(d))) count.set(d, (count.get(d) ?? 0) + 1)
      const best = [...count.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0]
      if (best) folders = [best[0]]
    }
  }
  return [...new Set([...files, ...folders])]
}

const touching = <T extends Job>(targets: readonly string[], tasks: readonly T[] | undefined, statuses: readonly string[]): T[] => {
  const want = targets.map(norm).filter(Boolean)
  if (!want.length) return []
  return (tasks ?? []).filter(t => statuses.includes(t.status) && (t.writes ?? []).map(norm).filter(Boolean).some(w => want.some(f => overlaps(w, f))))
}
export function busyJobs<T extends Job>(targets: readonly string[], tasks: readonly T[] | undefined): T[] { return touching(targets, tasks, ACTIVE) }
export function waitingJobs<T extends Job>(targets: readonly string[], tasks: readonly T[] | undefined): T[] { return touching(targets, tasks, WAITING) }

const short = (s: string): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t }
const nameOf = (j: Job): string => short(j.title || j.label || 'a job')
const list = (jobs: readonly Job[]): string => `${nameOf(jobs[0]!)}${jobs.length > 1 ? ` and ${jobs.length - 1} more` : ''}`

type Card = { kind?: string; file?: string; files?: readonly string[] }
export function busyFilesLine(item: Card, tasks: readonly Job[] | undefined): string | null {
  const jobs = busyJobs(actedOn(item), tasks)
  return jobs.length ? `The team is still changing these files: ${list(jobs)}.` : null
}
export function waitingFilesLine(item: Card, tasks: readonly Job[] | undefined): string | null {
  const jobs = waitingJobs(actedOn(item), tasks)
  return jobs.length ? `A job that changes these files is waiting for a decision: ${list(jobs)}.` : null
}
export function jobToOpen<T extends Job & { id?: string }>(item: Card, tasks: readonly T[] | undefined): { id?: string; name: string } | null {
  const t = actedOn(item)
  const j = busyJobs(t, tasks)[0] ?? waitingJobs(t, tasks)[0]
  return j ? { id: j.id, name: nameOf(j) } : null
}

export function pressRefusal(item: Card, tasks: readonly Job[] | undefined): string | null {
  return item.kind === 'submit' || item.kind === 'send' ? busyFilesLine(item, tasks) : null
}
