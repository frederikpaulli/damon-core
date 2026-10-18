import type { FindingLite } from './process-objection'

export const CRITERIA_CONFLICT_MARKING = 'When the job\'s own criteria cannot all be met together and the work does what can be done within them, start that finding with "[criteria]", name the criteria that conflict and say what the manager could change, like "[criteria] [j4] j2 forbids touching the text above the heading, which holds the word, so j2 and j4 cannot both be met; the manager could relax j4 or allow that edit". It goes to the manager, who set the criteria; the worker cannot change them.'

const MARK = /^((?:\s*\[[a-z]\d{1,3}\])*)\s*\[criteria\]\s*/i
export function criteriaMarked(text: string): boolean {
  return MARK.test(text ?? '')
}
export function withoutCriteriaMark(text: string): string {
  return (text ?? '').replace(MARK, (_all, tags: string) => (tags.trim() ? `${tags.trim()} ` : ''))
}

const CONFLICT = [
  /\b[sj]\d{1,3}\s*(?:and|&|,)\s*[sj]\d{1,3}\b[^.;]{0,40}?\bcan(?:not|'t|’t) (?:both|all|each) be (?:met|satisfied)\b/i,
  /\b(?:criteria|constraints)\b[^.;]{0,30}?\bcan(?:not|'t|’t) (?:both|all) be (?:met|satisfied)\b/i,
  /\b[sj]\d{1,3}\s*(?:and|&)\s*[sj]\d{1,3}\s+(?:conflict|contradict|are incompatible)/i,
  /\b(?:the job['’]s|this job['’]s|its|the)\s+own\s+(?:criteria|constraints)\s+(?:\w+\s+)?(?:conflict|contradict)/i,
  /\bthe criteria\s+(?:themselves\s+)?(?:conflict|contradict)/i,
  /\bthe manager (?:needs to|must|should|has to|will need to|would need to|could) (?:either )?(?:relax|loosen|waive|amend|reword|drop)\s+(?:criterion\s+)?[sj]\d{1,3}\b/i
]

export function criteriaConflict(statement: string): boolean {
  const s = statement ?? ''
  return criteriaMarked(s) || CONFLICT.some((re) => re.test(s))
}

export function criteriaConflictOnly(review: { verdict: string; findings: readonly FindingLite[] }): { points: string[] } | null {
  if (review.verdict !== 'does-not-meet') return null
  const blocking = review.findings.filter((f) => f.severity === 'blocking')
  if (!blocking.length || !blocking.every((f) => criteriaConflict(f.statement))) return null
  return { points: [...new Set(blocking.map((f) => withoutCriteriaMark(f.statement).trim().slice(0, 700)))] }
}

export function criteriaConflictOf(reviews: readonly { verdict: string; findings: readonly FindingLite[] }[]): string[] | null {
  const points: string[] = []
  for (const r of reviews) {
    if (r.verdict === 'meets') continue
    const only = criteriaConflictOnly(r)
    if (!only) return null
    points.push(...only.points)
  }
  return points.length ? [...new Set(points)] : null
}

export interface CriterionLite { id: string; status: string; observed?: string; held?: boolean }
export function refusedByCriteria<R extends { verdict: string; findings: readonly FindingLite[] }>(record: R, criteria: readonly CriterionLite[] | undefined): R {
  const all = criteria ?? []
  const finding = (statement: string): FindingLite => ({ severity: 'blocking', statement: statement.slice(0, 1000), evidence: '' })
  const failed = record.verdict === 'meets' ? all.filter((c) => c.status === 'fail').map((c) => finding(`[${c.id}] ${(c.observed ?? '').trim()}`)) : []
  const held = record.verdict === 'meets' || record.verdict === 'does-not-meet'
    ? all.filter((c) => c.status === 'blocked' && c.held).map((c) => finding(`[${c.id}] could not be verified, and it is about money, security or privacy: ${(c.observed ?? '').trim()}`))
    : []
  if (!failed.length && !held.length) return record
  return { ...record, verdict: 'does-not-meet', findings: [...record.findings, ...failed, ...held] }
}

export function criteriaConflictLine(points: readonly string[]): string {
  return `The reviewer found the work correct within its criteria, but the criteria conflict: ${points.join(' ').slice(0, 1500)} Amend the criteria and re-check (request_revision, saying exactly what is now allowed, when the work must change), or accept the job (approve_task, when it is right as it stands); the worker cannot change its own criteria, and the owner is not asked.`
}
