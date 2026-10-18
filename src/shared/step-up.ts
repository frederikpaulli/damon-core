import { oneRungAbove, REVIEWER_SEND_BACK } from './review'
import { isAdminNote } from './rounds'
import { matchesScope } from './scope'

export interface CappedJob {
  id: string
  agentId: string
  feedback: string[]
  brain?: string
  steppedUpFrom?: string
}

export function stepUpBrain(
  old: CappedJob | undefined,
  person: { id: string; name: string; model: string },
  maxRounds: number,
  alreadyUsed: boolean,
  ceiling?: string,
  used?: number
): { brain: string } | { error: string } {
  if (!old) return { error: 'step_up_from must be the id of a job, live or closed, on this project.' }
  if (old.agentId !== person.id) return { error: `step_up_from names a job ${person.name} did not do. A step up is for the same person's work after it hit the revision cap.` }
  if (old.brain || old.steppedUpFrom) return { error: 'That job already ran a rung up. A job steps up once; after that, split it smaller or explain the situation to the owner.' }
  const sent = used ?? old.feedback.length
  if (sent < maxRounds) return { error: `That job has been sent back ${sent} of ${maxRounds} times. A step up is for a job that hit the revision cap; send it back instead.` }
  if (alreadyUsed) return { error: 'A job has already stepped up from that one. A job steps up once.' }
  const brain = oneRungAbove(person.model, ceiling)
  if (!brain) return { error: `No brain above ${person.model} is available${ceiling ? ' under the owner’s ceiling' : ''}, so this job cannot step up. Give it to the same person again with a sharper brief, or explain the situation to the owner.` }
  return { brain }
}

export function carrySource(own: boolean, carryFrom: string | undefined, on: boolean): 'own' | 'carry' | 'none' {
  if (own) return 'own'
  return carryFrom && on ? 'carry' : 'none'
}

export function continuationBlock(from: { id: string; title: string; feedback: string[] }): string {
  const last = [...from.feedback].reverse().find((f) => typeof f === 'string' && f.trim() && !isAdminNote(f))
  const said = last ? last.replace(REVIEWER_SEND_BACK, '').replace(/^\s*Deal with every point, then report back\.\s*/, '').trim().slice(0, 1500) : ''
  return [
    `THIS JOB CONTINUES "${from.title}" (id ${from.id}). Its latest draft is your starting point: keep what is right, fix what was objected to. Do not start over.`,
    said ? `Its last send-back said:\n${said}` : 'It was not sent back with a reason; read its draft and its report before you change anything.'
  ].join('\n')
}

export function draftFilesLeftOut(asked: readonly string[], draftFiles: readonly string[]): string[] {
  return draftFiles.filter(p => !matchesScope([...asked], p))
}
