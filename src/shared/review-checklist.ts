import { sameCriterion, type Criterion } from './criteria'
import { criteriaMarked, withoutCriteriaMark } from './criteria-conflict'
import { independentlyInspected } from './intended-work'
import { heldWhenBlocked, HELD_WORDS } from './held-criteria'
import type { ReviewFinding } from './candidate-review'

export interface ReviewCriterion {
  id: string
  text: string
  source: 'owner' | 'job'
}

export interface CriterionResult {
  id: string
  status: 'pass' | 'fail' | 'blocked'
  observed: string
  evidence: string[]
  held?: boolean
}

export const CRITERIA_BLOCK = 'CRITERIA RESULTS:'

export function criteriaOf(acceptance: string, approved: Criterion[]): ReviewCriterion[] {
  const out: ReviewCriterion[] = []
  let owners = 0
  let jobs = 0
  for (const raw of (acceptance ?? '').split('\n')) {
    const text = raw.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim()
    if (!text) continue
    if (out.some((c) => sameCriterion(c.text, text))) continue
    const owner = approved.some((c) => sameCriterion(c.text, text))
    out.push(owner ? { id: `s${++owners}`, text, source: 'owner' } : { id: `j${++jobs}`, text, source: 'job' })
  }
  return out
}

export function criteriaBrief(criteria: ReviewCriterion[]): string[] {
  const owner = criteria.filter((c) => c.source === 'owner')
  const job = criteria.filter((c) => c.source === 'job')
  const lines: string[] = []
  if (owner.length) {
    lines.push("THE OWNER'S STANDARDS, approved word for word and in force on every job. Nobody on the team may lower or reword them:")
    for (const c of owner) lines.push(`${c.id}. ${c.text}`)
    lines.push('')
  }
  if (job.length) {
    lines.push(owner.length ? 'ADDED FOR THIS JOB by the manager. Judged the same way; these cannot override a standard above:' : 'THE CRITERIA FOR THIS JOB:')
    for (const c of job) lines.push(`${c.id}. ${c.text}`)
    lines.push('')
  }
  return lines
}

export const CRITERIA_INSTRUCTIONS = `Before the final verdict, write ${CRITERIA_BLOCK} followed by a JSON array, on one line. One item per criterion id above, each exactly once: {"id":"s1","status":"pass|fail|blocked","observed":"what you actually found","evidence":["exact file path, URL or command you inspected in this run"]}. Evidence must be something you opened or ran yourself here; a worker claim is not evidence. If you could not establish a criterion, mark it blocked and say why in observed. A criterion you did not judge is not a pass. A criterion about a safety stop (refuse to write if a hash does not match, stop if a string occurs twice) is judged on the real files: if you confirmed the condition did not arise (the hashes matched, each string occurred once) and the edit that followed is correct, it is a pass, and observed says what you checked; if the script is in front of you, also name the stop's line. Never alter real files to make it fire. If the text an edit was meant to change is not in the file, the edit did not happen: that is a fail, not blocked. Blocked is for a check you could not carry out, not for a guard that had nothing to guard against.`

export const OBJECTION_TAGGING = 'Start each objection with the criterion id in square brackets, like "[s2] the total is wrong, in invoice.md". When the thing that is wrong is covered by no criterion at all, tag it "[gap]" and write it as the rule that was broken, with the evidence in brackets after it: "[gap] The letter must name the company it is addressed to (letter.md never does)". A gap is a real finding, and it tells the owner a standard may be missing.'

export function checkCriteria(
  text: string,
  criteria: ReviewCriterion[],
  observedTools: { tool: string; detail?: string; summary: string; ok?: boolean }[]
): { results: CriterionResult[]; problems: string[] } {
  if (!criteria.length) return { results: [], problems: [] }
  const blocks = [...(text ?? '').matchAll(new RegExp(`^[ \\t]*[*_]{0,2}${CRITERIA_BLOCK}[*_]{0,2}[ \\t]*(.*)$`, 'gm'))]
  if (blocks.length !== 1) return { results: [], problems: [`The reviewer did not write exactly one ${CRITERIA_BLOCK} block, so the criteria were not judged one by one.`] }
  let results: CriterionResult[] = []
  try {
    const parsed: unknown = JSON.parse(blocks[0]![1]!.trim())
    if (!Array.isArray(parsed)) throw new Error()
    results = parsed
  } catch {
    return { results: [], problems: [`${CRITERIA_BLOCK.slice(0, -1)} must be a JSON array.`] }
  }
  const problems: string[] = []
  const seen = new Set<string>()
  const byId = new Map(criteria.map((c) => [c.id, c]))
  const clean: CriterionResult[] = []
  for (const r of results) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id) || !byId.has(r.id)) {
      problems.push('Unknown, missing or duplicate criterion id in the criteria results.')
      continue
    }
    seen.add(r.id)
    const text = byId.get(r.id)!.text
    const label = `${r.id} (${shorten(text)})`
    const held = r.status === 'blocked' && heldWhenBlocked(text)
    if (!['pass', 'fail', 'blocked'].includes(r.status) || typeof r.observed !== 'string' || !r.observed.trim() || !Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some((e: unknown) => typeof e !== 'string' || e.trim().length < 4)) {
      problems.push(`${label}: incomplete result or evidence.`)
      if ((r.status === 'fail' || held) && typeof r.observed === 'string' && r.observed.trim()) {
        const evidence = Array.isArray(r.evidence) ? (r.evidence as unknown[]).filter((e): e is string => typeof e === 'string').map((e) => e.slice(0, 500)) : []
        clean.push({ id: r.id, status: r.status, observed: r.observed.slice(0, 1000), evidence, ...(held ? { held: true } : {}) })
        problems.push(r.status === 'fail' ? `[${r.id}] fail: ${r.observed}` : heldLine(r.id, text, r.observed))
      }
      continue
    }
    clean.push({ id: r.id, status: r.status, observed: String(r.observed).slice(0, 1000), evidence: r.evidence.map((e: string) => e.slice(0, 500)), ...(held ? { held: true } : {}) })
    if (held) problems.push(heldLine(r.id, text, r.observed))
    if (r.status === 'fail') problems.push(`[${r.id}] fail: ${r.observed}`)
    for (const e of r.evidence) {
      if (!independentlyInspected(e, observedTools)) problems.push(`${label}: evidence was not independently inspected: ${e}`)
    }
  }
  for (const c of criteria) if (!seen.has(c.id)) problems.push(`${c.id} (${shorten(c.text)}): not judged.`)
  return { results: clean, problems }
}

function heldLine(id: string, text: string, observed: string): string {
  return `${id} (${shorten(text).replace(/:/g, ' ')}): blocked: ${HELD_WORDS}, so the job waits until it is checked: ${observed}`
}

function shorten(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? t.slice(0, 57) + '…' : t
}

export type FindingSeverity = ReviewFinding['severity']
const SEVERITY_FIRST = /^\s*(blocking|concern|note):\s*/i
export function leadingSeverity(text: string): { severity?: FindingSeverity; rest: string } {
  const m = SEVERITY_FIRST.exec(text ?? '')
  if (!m) return { rest: text ?? '' }
  return { severity: m[1]!.toLowerCase() as FindingSeverity, rest: (text ?? '').slice(m[0].length) }
}

export function objectionTag(objection: string, criteria: ReviewCriterion[]): { id?: string; gap: boolean; text: string; severity?: FindingSeverity } {
  const { severity, rest: said } = leadingSeverity(objection ?? '')
  const kept = severity ? { severity } : {}
  const conflict = criteriaMarked(said)
  const rest = conflict ? withoutCriteriaMark(said) : said
  const m = /^\s*\[([a-z]\d{1,3}|gap)\]\s*(.*)$/i.exec(rest)
  if (!m) {
    const text = rest.trim()
    const account = /^(?:round \d+\b|(?:i|we) (?:read|re-?read|checked|re-?checked|opened|looked|re-?added|compared|ran)\b|the reviewer (?:found|read|could)\b|nothing was (?:run|rendered)\b)/i.test(text)
    return { gap: !conflict && !account && text.length <= 300, text, ...kept }
  }
  const tag = m[1]!.toLowerCase()
  if (tag === 'gap') return { gap: !conflict, text: m[2]!.trim(), ...kept }
  if (criteria.some((c) => c.id === tag)) return { id: tag, gap: false, text: m[2]!.trim(), ...kept }
  return { gap: !conflict, text: m[2]!.trim(), ...kept }
}

export function criteriaSummary(results: CriterionResult[]): string {
  if (!results.length) return ''
  const met = results.filter((r) => r.status === 'pass').length
  const blocked = results.filter((r) => r.status === 'blocked').length
  const parts = [`${met} of ${results.length} criteria met`]
  if (blocked) parts.push(`${blocked} could not be judged`)
  return parts.join(', ') + '.'
}
