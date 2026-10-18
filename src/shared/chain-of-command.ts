export interface Person {
  id: string
  name: string
  kind?: 'agent' | 'submanager'
  parentId?: string
}

export interface Job {
  agentId: string
  status: string
}

const FINISHED = new Set(['approved', 'failed'])

export function isOrphanedLead(bossId: string | undefined, people: Person[], jobs: Job[]): boolean {
  if (!bossId || bossId === 'root') return false
  const boss = people.find((p) => p.id === bossId)
  if (!boss) return true
  if (boss.kind !== 'submanager') return false
  return !jobs.some((j) => j.agentId === bossId && j.status === 'working')
}

export function liveWorkUnder(bossId: string, people: Person[], jobs: Job[]): number {
  const team = new Set(people.filter((p) => p.parentId === bossId).map((p) => p.id))
  return jobs.filter((j) => team.has(j.agentId) && !FINISHED.has(j.status)).length
}

export function orphanedLeads(people: Person[], jobs: Job[]): Person[] {
  return people.filter(
    (p) => p.kind === 'submanager' && isOrphanedLead(p.id, people, jobs) && liveWorkUnder(p.id, people, jobs) > 0
  )
}

export function orphanHandoverPrompt(leadName: string, liveJobs: number): string {
  const jobs = liveJobs === 1 ? 'one job' : `${liveJobs} jobs`
  return (
    `${leadName} still has ${jobs} open under it but no assignment of its own, so it has no way to report back to you ` +
    `and never will: the tools it would use both require an assignment it no longer has. This is not something it can ` +
    `fix by trying again. Look at what its team has actually finished, then either give ${leadName} a fresh assignment ` +
    `covering the rest of that slice, take the slice over yourself, or hand it to someone else. Do not simply wait for ` +
    `${leadName} to report.`
  )
}

export function orphanNotice(leadName: string, liveJobs: number): string {
  const jobs = liveJobs === 1 ? 'a job' : `${liveJobs} jobs`
  return `${leadName} has ${jobs} still open but nothing to report against, so it cannot hand the work back. Damon is picking that slice up. Nothing that was finished is lost.`
}
