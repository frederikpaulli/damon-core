// Admission rules for a new job: a bounded assignment, recorded intent, declared reads and
// writes, acceptance criteria compared with the owner's standards, and routing checks.
import { gateRouteFor, type GateRoute } from '../../shared/gate-route'
import { intentProblem } from '../../shared/intended-work'
import { compareCriteria, sameCriterion, type Criterion, type CriteriaComparison } from '../../shared/criteria'
import { notApplicableStandards, notApplicableLine } from '../../shared/assign-contradictions'
import { checkRouting, type Handling } from '../../shared/routing'
import { scopeIsMeaningless } from '../../shared/scope'
import type { TaskInfo } from '../../shared/types'

export interface TaskAdmissionRequest {
  agentId: string
  title: string
  instructions: string
  acceptanceCriteria: string[]
  writes: string[]
  engineWidens?: string[]
  deliverableIds?: string[]
  finalizesDeliverables?: boolean
  reads?: string[]
  intent?: TaskInfo['intent']
  assignment?: TaskInfo['assignment']
  landsApprovedDraft?: boolean
}

export interface TaskAdmissionRules {
  coverage: boolean
  workOrder: boolean
  deliverableError(ids: string[] | undefined, finalizes: boolean | undefined, landsApprovedDraft?: boolean): string | null
  onTeam(agentId: string): boolean
  standards(): Criterion[]
  handling(): Handling
  assignee(agentId: string): { name: string; model: string } | undefined
  criteriaRefused(title: string, comparison: CriteriaComparison): void
  obligations(deliverableIds: string[]): TaskObligations
  bookkeeping?(path: string): boolean
  packageFolder?: (path: string) => string | undefined
}

export interface TaskObligations {
  unansweredOwnerNeeds: { deliverableId: string; needId: string; title: string; importance: 'required' | 'recommended' | 'optional' }[]
  openFindings: { id: string; statement: string }[]
}

export type AdmissionCode = 'assignment' | 'research' | 'intent' | 'reads' | 'deliverables' | 'obligations' | 'writes' | 'criteria' | 'team' | 'routing'
export const personLevelCodes: readonly AdmissionCode[] = ['team', 'routing']

export type TaskAdmission = { error: string; code: AdmissionCode } | { acceptance: string; comparison: CriteriaComparison; obligations: TaskObligations; route: GateRoute }

export function admitTask(request: TaskAdmissionRequest, rules: TaskAdmissionRules): TaskAdmission {
  const { agentId, title, instructions, acceptanceCriteria, writes, deliverableIds, finalizesDeliverables, reads, intent, assignment } = request
  if (rules.coverage && !assignment) return { error: 'Not assigned. Record a bounded assignment responsibility, reason, stopWhen and maxTurns. A small task does not need several agents.', code: 'assignment' }
  if (assignment?.responsibility === 'research' && !assignment.delegationReason) return { error: 'Explain the concrete benefit of a separate research assignment, or investigate the small gap within the current task.', code: 'research' }
  if (rules.workOrder && !intent) return { error: 'Not assigned. Record intent: outcome, assumptions and concrete scenarios.', code: 'intent' }
  if (intent && intentProblem(intent)) return { error: intentProblem(intent)!, code: 'intent' }
  if (rules.workOrder && reads === undefined) return { error: 'Not assigned. Declare exact reads, including source documents and research; use [] only if there are no file inputs.', code: 'reads' }
  const route = gateRouteFor({ writes, reads, text: `${title} ${instructions}`, ...(rules.bookkeeping && !finalizesDeliverables ? { bookkeeping: (p: string) => rules.bookkeeping!(p) } : {}), ...(rules.packageFolder ? { packageFolder: rules.packageFolder } : {}) })
  if (route.size === 'large') {
    const needsError = rules.deliverableError(deliverableIds, finalizesDeliverables, request.landsApprovedDraft)
    if (needsError) return { error: `${needsError} (This job counted as large because: ${route.because.join('; ')}. A one-file job with no outward action needs no deliverable record.)`, code: 'deliverables' }
  }
  const obligations = rules.obligations(deliverableIds ?? [])
  const blocking = obligations.unansweredOwnerNeeds.filter(need => need.importance === 'required')
  if (finalizesDeliverables && blocking.length) {
    return { error: [
      'Not assigned. This job says it produces the finished outputs, but the owner has not answered inputs it needs:',
      ...blocking.map(need => `- ${need.title} (${need.deliverableId})`),
      '',
      'These are already on the owner’s list in Your turn. Assign the parts that do not depend on them, or wait for the answers. Do not retire the need or drop the deliverable to get this started.'
    ].join('\n'), code: 'obligations' }
  }
  if (!rules.onTeam(agentId)) return { error: 'That agent is not on your team.', code: 'team' }
  if (scopeIsMeaningless(writes)) {
    return { error: `Not assigned. "${writes.join(', ')}" says this job may write anywhere, which tells the owner nothing and would stop every other job from running alongside it. Name the actual folders: "src/api/**", "tests/api/**". If the job really does touch the whole project, it is too big to be one job.`, code: 'writes' }
  }
  const comparison = compareCriteria(rules.standards(), acceptanceCriteria)
  if (comparison.nothingApproved) rules.criteriaRefused(title, comparison)
  if (comparison.needsApproval && !comparison.nothingApproved) {
    rules.criteriaRefused(title, comparison)
    return { error: [
      `Not assigned. ${comparison.line}`,
      '',
      ...comparison.edited.flatMap(e => [`Approved: ${e.before}`, `Yours: ${e.after}`, '']),
      'What the owner approved:',
      ...comparison.before.map(c => `- ${c}`),
      '',
      'What you sent:',
      ...comparison.after.map(c => `- ${c}`),
      '',
      'Assign this again without the reworded one: Damon attaches the approved criteria itself, so send only what this job adds. If you believe one of them is wrong for this work, say so to the owner and wait: it is theirs to change, not yours.'
    ].join('\n'), code: 'criteria' }
  }
  const person = rules.assignee(agentId)
  if (person) {
    const verdict = checkRouting(person.model, rules.handling())
    if (!verdict.allow) return { error: `Not assigned. ${verdict.warn} Move ${person.name} to a Claude brain first, or give this job to somebody already on one.`, code: 'routing' }
  }
  const na = notApplicableStandards(rules.standards().map(c => c.text), [...writes, ...(request.engineWidens ?? [])])
  const kept = comparison.merged.filter(c => !na.some(s => sameCriterion(s, c)))
  return { acceptance: [...kept, ...na.map(notApplicableLine)].map(c => `- ${c}`).join('\n'), comparison, obligations, route }
}

export function deliverableAdmissionError(input: {
  workNeeds: null | { list(): { id: string; outputs: string[]; retired?: unknown }[] }
  coverage: null | { list(): { foundation: string }[]; relevant(files: string[]): unknown[]; gate(files: string[], stage: 'start', ids: string[], requireFoundation?: boolean): string | null }
  ids?: string[]
  finalizes?: boolean
  requireFoundation?: boolean
}): string | null {
  const { workNeeds, coverage, ids, finalizes } = input
  if (!workNeeds) return null
  if (!ids || finalizes === undefined) return 'Not assigned. Record what each deliverable needs with record_deliverable, then provide deliverable_ids and finalizes_deliverables. For supporting research only, use [] and false.'
  const plans = workNeeds.list()
  if (ids.some(id => !plans.some(p => p.id === id))) return 'Not assigned. A deliverable ID is unknown. Use list_deliverables and record_deliverable first.'
  const retired = ids.filter(id => plans.some(p => p.id === id && p.retired))
  if (retired.length) return `Not assigned. ${retired.join(', ')} ${retired.length === 1 ? 'was' : 'were'} retired, so no job works under ${retired.length === 1 ? 'it' : 'them'} any more. Name a current deliverable.`
  if (finalizes && !ids.length) return 'Not assigned. Final work must name the deliverables it completes.'
  if (finalizes && coverage && !ids.every(id => coverage.list().some(r => r.foundation === id))) {
    const files = plans.filter(p => ids.includes(p.id)).flatMap(p => p.outputs)
    if (files.some(file => !coverage.relevant([file]).length)) return 'Not assigned. Use project_coverage to establish the applicable project concerns for every output before production. Reuse existing coverage for small changes; a concern is not a new agent.'
    const blocked = input.requireFoundation === false ? coverage.gate(files, 'start', ids, false) : coverage.gate(files, 'start', ids)
    if (blocked) return blocked
  }
  return null
}

export function obligationsFor(
  plans: { id: string; needs?: { id: string; title: string; importance: string; owner?: boolean; retired?: string; ownerDecision?: string; answer?: unknown }[] }[],
  order: null | { evidence?: { id: string; statement: string; scope?: string[]; supersedes?: string; expiresAt?: string }[] },
  deliverableIds: string[]
): TaskObligations {
  const named = new Set(deliverableIds)
  const unansweredOwnerNeeds = plans
    .filter(plan => named.has(plan.id))
    .flatMap(plan => (plan.needs ?? [])
      .filter(need => need.owner && !need.retired && !need.ownerDecision && !need.answer)
      .map(need => ({ deliverableId: plan.id, needId: need.id, title: need.title, importance: (['required', 'recommended', 'optional'].includes(need.importance) ? need.importance : 'optional') as TaskObligations['unansweredOwnerNeeds'][number]['importance'] })))
  const evidence = order?.evidence ?? []
  const openFindings = evidence
    .filter(item => !evidence.some(later => later.supersedes === item.id))
    .filter(item => !item.expiresAt || !(Date.parse(item.expiresAt) <= Date.now()))
    .filter(item => !item.scope?.length || item.scope.some(id => named.has(id)))
    .map(({ id, statement }) => ({ id, statement }))
  return { unansweredOwnerNeeds, openFindings }
}

export function directLineRefusal(input: { purpose: 'personal' | 'client'; model: string; name: string; handling: Handling }): string | undefined {
  if (input.purpose !== 'client') return undefined
  const verdict = checkRouting(input.model, input.handling)
  if (verdict.allow) return undefined
  return `Not sent. ${verdict.warn} Move ${input.name} to a Claude brain first, or say it to somebody already on one.`
}
