import type { TaskInfo } from './types'

export type EscalationTo = 'owner' | 'manager'

const MANAGER_BOUND = [
  'ended its turn without reporting back',
  'Required inputs could not be reserved',
  'The person this was given to is no longer on the team'
]

export function escalationTo(task: Pick<TaskInfo, 'escalation' | 'result'>): EscalationTo {
  if (task.escalation) return task.escalation
  const said = task.result ?? ''
  return MANAGER_BOUND.some(stem => said.includes(stem)) ? 'manager' : 'owner'
}

export function isForOwner(task: Pick<TaskInfo, 'status' | 'escalation' | 'result'>): boolean {
  return task.status === 'escalated' && escalationTo(task) === 'owner'
}

export function stallSummary(task: Pick<TaskInfo, 'escalation' | 'result'>): string {
  const said = task.result ?? ''
  if (said.includes('ended its turn without reporting back')) return 'The lead holding this stopped answering, so the work went back to the manager.'
  if (said.includes('Required inputs could not be reserved')) return 'This could not start: the files it needs could not be reserved.'
  if (said.includes('The person this was given to is no longer on the team')) return 'The teammate this was given to is no longer on the team, so it never started.'
  return 'This went back to the manager unfinished.'
}
