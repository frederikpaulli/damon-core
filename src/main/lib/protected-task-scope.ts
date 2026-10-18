import { createHash } from 'node:crypto'
import type { TaskInfo } from '../../shared/types'
import { nativeTaskScope, type NativeTaskScope } from '../../shared/native-task-scope'
import { matchesScope, scopeIsMeaningless } from '../../shared/scope'
import { workerPath } from './isolated-worker'

export function taskDefinition(task: TaskInfo): Record<string, unknown> {
  const observed = new Set(task.observedReads ?? [])
  const workBasis = task.workBasis ? { ...task.workBasis, files: task.workBasis.files.filter(f => !f.observed).map(({ file, hash }) => ({ file, hash })) } : null
  return {
    id: task.id, agentId: task.agentId, title: task.title, instructions: task.instructions, acceptance: task.acceptance,
    reads: (task.reads ?? []).filter(file => !observed.has(file)), writes: task.writes ?? [], needs: task.needs ?? [], intent: task.intent ?? null,
    assignment: task.assignment ?? null, deliverableIds: task.deliverableIds ?? [], finalizesDeliverables: task.finalizesDeliverables ?? false,
    workBasis,
    ...(task.skills?.length ? { skills: task.skills } : {})
  }
}
export function scopeForNativeTask(task: TaskInfo, readOnly: boolean, carryHeldFrom?: string): NativeTaskScope {
  const definition = taskDefinition(task)
  return validateNativeTaskScope({ taskId: task.id, reads: definition.reads as string[], writes: definition.writes as string[], readOnly,
    ...(task.workBasis ? { inputVersions: task.workBasis.files.filter(file => /^[a-f0-9]{64}$/.test(file.hash) && matchesScope(task.reads ?? [], file.file)).map(file => ({ path: file.file, sha256: file.hash })) } : {}),
    ...(task.steppedUpFrom || task.continuesFrom || carryHeldFrom ? { carryFrom: task.steppedUpFrom ?? task.continuesFrom ?? carryHeldFrom } : {}),
    definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex') })
}
export function validateNativeTaskScope(value: unknown): NativeTaskScope {
  const scope = nativeTaskScope.parse(value)
  scope.reads.forEach(workerPath)
  scope.inputVersions?.forEach(file => workerPath(file.path))
  if (scope.inputVersions && new Set(scope.inputVersions.map(file => file.path.toLowerCase())).size !== scope.inputVersions.length) throw Error('Task input versions must be distinct.')
  if (new Set(scope.reads.map(path => path.toLowerCase())).size !== scope.reads.length) throw Error('Task input paths must be distinct.')
  if (scope.writes.length && (scopeIsMeaningless(scope.writes) || scope.writes.some(path => /[\x00-\x1f:\\]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')))) throw Error('Task output scope needs an explicit project area.')
  return scope
}
export function requireTaskInput(scope: NativeTaskScope | undefined, path: string): void {
  if (scope && !scope.reads.includes(path)) throw Error('This input is outside the task assignment. Ask its coordinator to review the input scope.')
}
export function requireTaskOutputs(scope: NativeTaskScope | undefined, outputs: string[]): void {
  if (scope && outputs.length && (scope.readOnly || outputs.some(path => !matchesScope(scope.writes, path)))) throw Error('These outputs are outside the task assignment or this is a read-only review.')
}
