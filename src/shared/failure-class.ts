export type FailureClass = 'seat' | 'lane' | 'copy' | 'recovery' | 'turns' | 'time' | 'restart' | 'input' | 'auth' | 'work' | 'clock' | 'silence' | 'platform'

const RULES: [FailureClass, RegExp][] = [
  ['lane', /^Damon's own final check on the landed draft did not run \(/],
  ['clock', /\bwaited on the clock\b/i],
  ['silence', /stopped sending any sign of life|and nothing came back, so it was stopped/i],
  ['platform', /Unapproved native configuration reported: a second init frame/i],
  ['seat', /another Claude Code process is refreshing it/i],
  ['auth', /OAuth|authenticat|sign(ed)? ?in again|session expired|not logged in|subscription (has )?(ended|expired)|\b401\b/i],
  ['restart', /Damon (was )?(closed|restarted|quit)|interrupted by (a|the) restart|app (was )?(closed|quit)/i],
  ['recovery', /Native execution tracking needs recovery|ended before Damon could confirm its program had closed|Native (turn )?completion is unknown|Recovery is required|cleanup (is still )?unverified|could not confirm .* closed/i],
  ['seat', /another Claude Code process is refreshing it|waited too long for protected execution capacity|capacity is in use|Docker (Desktop )?(is not|isn't|was not) running|Docker .* not available/i],
  ['lane', /already has (queued or )?active work|already has an active native turn/i],
  ['copy', /could not (make|create|prepare) (a|the|its) (working )?copy|copy of the project (could not|failed)|workspace copy/i],
  ['turns', /Reached maximum number of turns|error_max_turns|lot of steps, so Damon stopped it/i],
  ['time', /exceeded its time limit|ran out of time|timed out after|the longest one go at a job can run/i],
  ['input', /Damon stopped this turn because a file|changed before completion|input version does not match|lacks an exact owner-reviewed file grant|records are too large to hand to a turn|Refresh the task basis/i]
]

export function classifyFailure(text: string | undefined): FailureClass {
  const said = (text ?? '').replace(/Partial report:[\s\S]*$/, '')
  for (const [cls, rule] of RULES) if (rule.test(said)) return cls
  return 'work'
}

export const INFRASTRUCTURE: ReadonlySet<FailureClass> = new Set(['seat', 'lane', 'copy', 'recovery', 'restart', 'platform'])
export const CONTINUATION: ReadonlySet<FailureClass> = new Set(['turns', 'time'])
