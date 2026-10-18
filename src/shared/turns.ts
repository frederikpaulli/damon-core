export const MAX_AGENT_TURNS = 100
export const MIN_ASSIGNED_TURNS = 12
export const assignedTurns = (agentMax: number | undefined, assigned: number): number => Math.min(agentMax ?? MAX_AGENT_TURNS, Math.max(MIN_ASSIGNED_TURNS, assigned))

export const MAX_MANAGER_TURNS = 150

export const SAME_STEP_LIMIT = 8

export const LAST_CALL = lastCallFor('steps')

export function lastCallFor(reason: 'steps' | 'clock', detail?: string): string {
  const first =
    reason === 'steps'
      ? 'You have run out of steps for this task and Damon has stopped you. Do not use any tools now.'
      : `Damon has stopped you${detail ? ` because ${detail}` : ' because you were quiet for too long'}. Do not use any tools now.`
  return [
  first,
  '',
  'Report what actually happened, in this order:',
  '1. What you finished, with the real file paths.',
  '2. What you started and did not finish.',
  '3. What you had not begun.',
  '',
  'Do not describe unfinished work as done. This report is the only thing that survives the job, and somebody is going to pick it up from where you stopped, so the honest state is worth more to them than a tidy one.',
  '',
  'End with the HANDOVER: block covering every file you actually created or changed.'
].join('\n')
}

export function outOfStepsNote(agentName: string, turns: number): string {
  return `${agentName} ran out of steps: this job hit Damon's limit of ${turns} and was stopped before it finished. The report below is what it had done by then, so treat it as a progress note rather than finished work. If the job is genuinely this big, split what is left into smaller pieces rather than sending the whole thing back.`
}
