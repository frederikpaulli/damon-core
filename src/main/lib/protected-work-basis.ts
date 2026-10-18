import { createHash } from 'node:crypto'
import { protectedProjectContext } from './protected-context'
import { scopeForNativeTask, taskDefinition } from './protected-task-scope'
import type { TaskInfo } from '../../shared/types'
import { matchesScope } from '../../shared/scope'

export interface NativeWorkGuard {
  readonly sha256: string
  assertQueued(): void
  assertActive(): void
  drift(): string[]
  refreshed?(): NativeWorkGuard
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Snapshot = { stored: Record<string, any>; conversation: { ownerMessagesSha256: string; ownerMessageHashes: string[] } }
const snapshot = (stateDir: string): { context: string; data: Snapshot } => {
  let data!: Snapshot
  const context = protectedProjectContext(stateDir, raw => { data = raw })
  return { context, data }
}
function ownerBasis(data: Snapshot, spoken?: number, plans?: readonly string[]): unknown {
  const needs = data.stored['work-needs.json']
  if (needs !== undefined && (!needs || needs.version !== 1 || !Array.isArray(needs.plans))) throw Error('Requirements need recovery before execution.')
  const plans_: any[] = needs?.plans ?? []
  const standards = data.stored['standards.json']
  if (standards !== undefined && (!standards || typeof standards !== 'object' || Array.isArray(standards) || standards.approved !== undefined && !Array.isArray(standards.approved))) throw Error('Owner standards need recovery before execution.')
  if (data.stored['user-profile.json'] !== undefined && typeof data.stored['user-profile.json'] !== 'string') throw Error('The project owner profile needs recovery before execution.')
  return {
    conversation: spoken === undefined ? data.conversation.ownerMessagesSha256 : digest(data.conversation.ownerMessageHashes.slice(0, spoken).concat(data.conversation.ownerMessageHashes.length < spoken ? ['missing'] : [])),
    profile: data.stored['user-profile.json'] ?? null, standards: { approved: standards?.approved ?? [], approvedAt: standards?.approvedAt ?? null },
    delivery: data.stored.delivery ?? null,
    decisions: plans_.filter(plan => !plans || plans.includes(plan.id)).flatMap(plan => {
      if (!Array.isArray(plan.needs)) throw Error('Requirements need recovery before execution.')
      return plan.needs.filter((need: any) => need.ownerDecision || need.owner && need.answer).map((need: any) => ({ planId: plan.id, needId: need.id, decision: need.ownerDecision ?? null, answer: need.answer ?? null, issue: need.issue ?? null }))
    })
  }
}
function workerBasis(data: Snapshot, taskId: string, allowSyntheticReview: boolean, spoken?: number): unknown {
  const tasks = data.stored['tasks.json'] ?? []
  if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task.id !== 'string') || new Set(tasks.map(task => task.id)).size !== tasks.length) throw Error('Task history needs recovery before execution.')
  const task = tasks.find(task => task.id === taskId) as TaskInfo | undefined
  if (!task && !allowSyntheticReview) throw Error('The assigned task is no longer present. Reconcile its history before execution.')
  const order = data.stored['work-order.json']
  if (order !== undefined && (!order || order.version !== 1 || !['evidence', 'artifacts', 'actions', 'stages'].every(key => Array.isArray(order[key])))) throw Error('Critical evidence needs recovery before execution.')
  const evidence: any[] = order?.evidence ?? []
  for (const id of task?.workBasis?.evidence ?? []) {
    const saved = evidence.find(item => item.id === id)
    if (!saved || evidence.some(item => item.supersedes === id)) throw Error('Required critical evidence is missing or superseded. Prepare a fresh task basis.')
    if (saved.expiresAt && (!Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= Date.now())) throw Error('Required critical evidence expired. Refresh it before continuing.')
  }
  const definition = (value: TaskInfo) => {
    const stub = value as unknown as { onlyItsName?: boolean; sha256?: string }
    if (stub.onlyItsName && typeof stub.sha256 === 'string') {
      return { definitionSha256: stub.sha256, feedback: null, connections: value.connections ?? null }
    }
    return { definitionSha256: scopeForNativeTask(value, false).definitionSha256, feedback: value.feedback, connections: value.connections ?? null }
  }
  const writes = task?.writes ?? [], reads = task?.reads ?? [], deliverables = task?.deliverableIds ?? []
  const touches = (file: unknown): boolean => typeof file === 'string' && (matchesScope(writes, file) || reads.includes(file))
  const needs = data.stored['work-needs.json']
  const ownNeeds = task && needs && typeof needs === 'object' && Array.isArray((needs as { plans?: unknown[] }).plans)
    ? { ...(needs as object), plans: ((needs as { plans: any[] }).plans).filter(p => p && (deliverables.includes(p.id) || (Array.isArray(p.taskIds) && p.taskIds.includes(task.id)) || (Array.isArray(p.outputs) && p.outputs.some((f: unknown) => typeof f === 'string' && matchesScope(writes, f))))) }
    : task ? { version: 1, plans: [] } : needs ?? null
  const ownOrder = task
    ? { version: 1, evidence: evidence.filter(e => e && (task.workBasis?.evidence ?? []).includes(e.id)), artifacts: ((order?.artifacts ?? []) as any[]).filter(a => a && (a.taskId === task.id || touches(a.file))) }
    : order ?? null
  const critiquesRaw = data.stored['critiques.json']
  const critiqueList: any[] = Array.isArray(critiquesRaw) ? critiquesRaw : Array.isArray((critiquesRaw as { obligations?: unknown[] })?.obligations) ? (critiquesRaw as { obligations: any[] }).obligations : []
  const ownCritiques = task
    ? critiqueList.filter(c => c && ((Array.isArray(c.taskIds) && c.taskIds.includes(task.id)) || (Array.isArray(c.files) && c.files.some(touches)) || (typeof c.scope === 'string' && deliverables.some(id => c.scope === 'deliverable:' + id || c.scope.split(',').includes(id)))))
    : critiquesRaw ?? null
  const records = { ...Object.fromEntries(['brain/MAP.md', 'brain/DECISIONS.md', 'brain/GLOSSARY.md'].map(name => [name, data.stored[name] ?? null])), 'work-needs.json': ownNeeds, 'work-order.json': ownOrder, 'critiques.json': ownCritiques }
  const roster = data.stored['agents.json'] ?? []
  if (!Array.isArray(roster)) throw Error('Project team history needs recovery before execution.')
  return { owner: ownerBasis(data, spoken, task?.deliverableIds?.length ? task.deliverableIds : undefined), records, task: task ? definition(task) : null,
    worker: task ? roster.filter(agent => agent.id === task.agentId) : [],
    prerequisites: (task?.needs ?? []).map(id => { const prerequisite = tasks.find(item => item.id === id); return prerequisite ? { id, status: prerequisite.status, ...definition(prerequisite) } : { id, missing: true } })
  }
}
function coordinatorBasis(data: Snapshot): unknown {
  const tasks = data.stored['tasks.json'] ?? []
  if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task.id !== 'string') || new Set(tasks.map(task => task.id)).size !== tasks.length) throw Error('Task history needs recovery before execution.')
  const roster = data.stored['agents.json'] ?? []
  if (!Array.isArray(roster)) throw Error('Project team history needs recovery before execution.')
  const order = data.stored['work-order.json']
  if (order !== undefined && (!order || order.version !== 1 || !['evidence', 'artifacts', 'actions', 'stages'].every(key => Array.isArray(order[key])))) throw Error('Critical evidence needs recovery before execution.')
  return {
    owner: ownerBasis(data),
    plan: tasks.map((task: TaskInfo) => ({ id: task.id, agentId: task.agentId, definition: taskDefinition(task) })),
    team: roster.map((agent: any) => ({ id: agent?.id ?? null, name: agent?.name ?? null, model: agent?.model ?? null })),
    records: Object.fromEntries(['brain/MAP.md', 'brain/DECISIONS.md', 'brain/GLOSSARY.md', 'work-needs.json', 'work-order.json'].map(name => [name, data.stored[name] ?? null]))
  }
}
export function currentWorkerBasisSha256(stateDir: string, taskId: string, allowSyntheticReview = false): string {
  return digest(workerBasis(snapshot(stateDir).data, taskId, allowSyntheticReview))
}
export function captureNativeWorkBasis(stateDir: string, task?: { id: string; syntheticReview?: boolean }): { context: string; guard: NativeWorkGuard } {
  const captured = snapshot(stateDir)
  const spoken = captured.data.conversation.ownerMessageHashes.length
  const workerNow = (data: Snapshot, prefix?: number) => workerBasis(data, task!.id, !!task!.syntheticReview, prefix) as { owner: unknown; records: Record<string, unknown>; task: unknown; worker: unknown; prerequisites: unknown }
  const queued = digest(task ? workerNow(captured.data) : coordinatorBasis(captured.data))
  const active = task ? queued : digest(ownerBasis(captured.data, spoken))
  const assert = (actual: string, expected: string): void => {
    if (actual !== expected) throw Error('Project requirements, owner input or task basis changed. Prepare a fresh turn before continuing.')
  }
  const hardOf = (basis: ReturnType<typeof workerNow>): string => digest({ owner: basis.owner, task: basis.task, worker: basis.worker, prerequisites: basis.prerequisites })
  const recordsOf = (basis: ReturnType<typeof workerNow>): Record<string, string> => Object.fromEntries(Object.entries(basis.records).map(([name, value]) => [name, digest(value)]))
  const capturedWorker = task ? workerNow(captured.data, spoken) : null
  const hardCaptured = capturedWorker ? hardOf(capturedWorker) : ''
  const partsOf = (basis: ReturnType<typeof workerNow>): Record<string, string> => ({ 'the owner\'s word': digest(basis.owner), "the job's own definition": digest(basis.task), 'the worker': digest(basis.worker), 'its prerequisites': digest(basis.prerequisites) })
  const partsCaptured = capturedWorker ? partsOf(capturedWorker) : {}
  const recordsCaptured = capturedWorker ? recordsOf(capturedWorker) : {}
  const drift = (): string[] => {
    if (!capturedWorker) return []
    const now = recordsOf(workerNow(snapshot(stateDir).data))
    return Object.keys(recordsCaptured).filter((name) => now[name] !== recordsCaptured[name])
  }
  return { context: captured.context, guard: {
    sha256: queued,
    ...(task ? { refreshed: () => captureNativeWorkBasis(stateDir, task).guard } : {}),
    assertQueued: () => {
      const current = snapshot(stateDir)
      assert(digest(task ? workerNow(current.data) : coordinatorBasis(current.data)), queued)
    },
    assertActive: () => {
      const current = snapshot(stateDir)
      if (task) {
        const now = workerNow(current.data, spoken)
        if (hardOf(now) !== hardCaptured) {
          const partsNow = partsOf(now)
          const moved = Object.keys(partsCaptured).filter((name) => partsNow[name] !== partsCaptured[name])
          throw Error(`Project requirements, owner input or task basis changed (${moved.join(', ') || 'unknown part'}). Prepare a fresh turn before continuing.`)
        }
      }
      else assert(digest(ownerBasis(current.data, spoken)), active)
    },
    drift
  } }
}
