export type DecidedBy = 'owner' | 'damon' | 'manager' | 'damon-code'
export const DAMON_CODE_WORDS = 'Damon checked it in code and put it in'

export type AcceptedHow = 'criteria' | 'follow-up' | 'fault'
export const RULE_DATE: Record<AcceptedHow, string> = { fault: '2 October', 'follow-up': '4 October', criteria: '5 October' }
function howFromWords(words?: string): AcceptedHow | undefined {
  const s = (words ?? '').trim()
  if (/^Accepted as a known fault/.test(s)) return 'fault'
  if (/^Accepted with a follow-up/.test(s)) return 'follow-up'
  if (/^Accepted with conflicting criteria/.test(s)) return 'criteria'
  return undefined
}
export function acceptedHow(review?: { accepted?: { how: AcceptedHow }; overruledWhy?: string }): AcceptedHow | undefined {
  return review?.accepted?.how ?? howFromWords(review?.overruledWhy)
}
function subject(by: DecidedBy | undefined, how?: AcceptedHow): { lead: string; tail: string } | null {
  if (by === 'owner') return { lead: 'You kept', tail: '' }
  if (by === 'damon-code') return { lead: 'Damon checked', tail: ' in code and put it in' }
  if (how) return { lead: 'Damon accepted', tail: ` under your rule of ${RULE_DATE[how]}` }
  if (by === 'damon') return { lead: 'Damon settled', tail: ' itself' }
  if (by === 'manager') return { lead: 'Damon accepted', tail: '' }
  return null
}
export function keptWords(by: DecidedBy | undefined, name: string, how?: AcceptedHow): string {
  const s = subject(by, how)
  return s ? `${s.lead} “${name}”${s.tail}` : `“${name}” was kept`
}
const keptIt = (by: DecidedBy, how?: AcceptedHow): string => { const s = subject(by, how)!; return `${s.lead} it${s.tail}` }

export function pendingWords(by: DecidedBy | undefined, name: string, how?: AcceptedHow): string {
  if (by === 'owner' || by === 'damon-code') return keptWords(by, name, how)
  if (how) return `Under your rule of ${RULE_DATE[how]}, Damon is accepting “${name}” once its checks clear`
  if (by === 'damon') return `Damon is settling “${name}” itself once its checks clear`
  if (by === 'manager') return `Damon is accepting “${name}” once its checks clear`
  return `“${name}” is being kept`
}
export function heldFaultWords(by: DecidedBy | undefined, name: string, how?: AcceptedHow): string {
  if (by === 'owner') return `${keptWords(by, name, how)} with a known fault`
  return `${how ? `Under your rule of ${RULE_DATE[how]}, ` : ''}Damon will accept “${name}” with a known fault once its checks clear`
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export function plainDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}`.trim() : iso
}
const RULE_NAME: Record<AcceptedHow, string> = { fault: 'known-fault', 'follow-up': 'follow-up', criteria: 'conflicting-criteria' }
export function keptOn(by: DecidedBy | undefined, name: string, how: AcceptedHow | undefined, at: string): string {
  const day = plainDay(at)
  if (by === 'owner') return `You kept “${name}” on ${day}`
  if (by === 'damon-code') return `Damon checked “${name}” in code and put it in on ${day}`
  if (how) return `Damon accepted “${name}” on ${day} under your ${RULE_NAME[how]} rule`
  if (by === 'damon') return `Damon settled “${name}” itself on ${day}`
  if (by === 'manager') return `Damon accepted “${name}” on ${day}`
  return `“${name}” was kept on ${day}`
}
const PENDING_BECAUSE: Record<AcceptedHow, string> = {
  fault: "because its fault's fix is lined up (the reviewer had refused it)",
  'follow-up': "because the reviewer's points were only about process or wording, and a follow-up deals with them",
  criteria: "because two of the job's own criteria could not both be met (the reviewer had refused it)"
}
const HOW_WORDS: Record<AcceptedHow, string> = {
  fault: 'with a known fault whose fix is lined up',
  'follow-up': "with a follow-up for the reviewer's points about process or wording",
  criteria: "because two of the job's own criteria could not both be met"
}

export const RELEASED_REASON = 'You released its known fault, so it lands as it is'
export function landingReason(decidedBy: DecidedBy, summary?: string, pending = false): string {
  const s = (summary ?? '').trim()
  if (decidedBy === 'damon-code') return DAMON_CODE_WORDS
  if (decidedBy === 'owner' && !pending) return `${keptIt('owner')} over the reviewer's objection`
  const how = howFromWords(s)
  if (how && pending) return `Under your rule of ${RULE_DATE[how]} it goes in while its last checks run, ${PENDING_BECAUSE[how]}; it stays only if the job is approved`
  if (pending && /^Damon settled it itself/.test(s)) return "Damon is settling it itself over the reviewer's objection; it is approved once its checks clear"
  if (pending && decidedBy === 'manager' && !/^No reviewer reads a job this small/.test(s)) return "Damon is accepting it over the reviewer's objection; it is approved once its checks clear"
  if (how) return `${keptIt('manager', how)}, ${HOW_WORDS[how]}; the reviewer had refused it`
  if (/^No reviewer reads a job this small/.test(s)) return "No reviewer reads a job this small, so the manager's approval stands as its review"
  if (/^Damon's own bookkeeping/.test(s)) return "It only changed Damon's own records, and its own check stands as its review"
  if (/^Damon settled it itself/.test(s)) return `${keptIt('damon')} over the reviewer's objection`
  if (decidedBy === 'owner') return `${keptIt('owner')} over the reviewer's objection`
  if (decidedBy === 'manager') return `${keptIt('manager')} over the reviewer's objection`
  return 'Autopilot is on and the reviewer said it meets the criteria'
}
