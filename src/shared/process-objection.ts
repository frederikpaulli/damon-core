import { processFinding } from './file-role'
import { isAdminNote } from './rounds'

export interface FindingLite { severity: string; statement: string; evidence?: string; file?: string }

export function processOnly(input: { verdict: string; findings: readonly FindingLite[]; neverLeaves: (path: string) => boolean; draftFiles: readonly string[] }): { points: string[] } | null {
  if (input.verdict !== 'does-not-meet') return null
  const blocking = input.findings.filter((f) => f.severity === 'blocking')
  if (!blocking.length) return null
  const draftStaysIn = input.draftFiles.length > 0 && input.draftFiles.every((p) => input.neverLeaves(p))
  for (const f of blocking) {
    if (!processFinding(f.statement, f.evidence ?? '')) return null
    if (f.file ? !input.neverLeaves(f.file) : !draftStaysIn) return null
  }
  return { points: [...new Set(blocking.map((f) => f.statement.trim()))] }
}

const FAIL_FIRST_POINT = /\bfail(?:s|ing|ed)?[- ]first\b|\bshown?(?: to)? fail|\bred[- ](?:before[- ])?green\b|\btest[- ]first\b|\btdd\b/i
export function followUpWords(task: { title: string; label?: string }, points: readonly string[]): { title: string; instructions: string; acceptance: string } {
  const name = task.label ?? task.title
  return {
    title: `Follow-up on "${name.slice(0, 120)}": the reviewer's process and wording points`,
    instructions: `"${name}" was accepted under the owner's rule of 4 October 2026: its reviewer's only objections were about process or wording, not about what the work does. Its work is already in the project. Deal with each point below in the same files (run the tests and quote the exact commands and their output, fix the wording or formatting), change nothing else, and report what you did with the real output. A run from before the change cannot be shown now and is not asked for: show the tests passing as the code stands.`,
    acceptance: points.map((p) => FAIL_FIRST_POINT.test(p)
      ? `- The tests for "${name.slice(0, 120)}" pass now, run as the code stands, with the exact command and its output quoted (the reviewer had asked to see them fail before the change, which cannot be shown after it landed)`
      : `- Dealt with: ${p}`).join('\n')
  }
}

const RUN_EVIDENCE = /\b(?:not|never|no|without)\b[^.;,]{0,50}\b(?:re-?run|ran|run|shown?|quoted?|printed|re-?built)\b[^.;,]{0,50}\b(?:tests?|suite|build|check|cargo|npm|vitest|exit|output)\b|\bexit (?:line|code|status)\b[^.;,]{0,30}\b(?:missing|absent|not (?:shown|quoted|given))\b|\b(?:tests?|suite|build|check)\b[^.;,]{0,40}\b(?:was|were|is) not (?:re-?run|run|shown)\b|\bexit (?:line|code|status) of the \w+ is not shown\b/i
const FILLER = new Set(['the', 'a', 'an', 'full', 'whole', 'entire', 'complete', 'cargo', 'npm', 'vitest', 'test', 'tests', 'suite', 'build', 'check', 'checks', 'backend', 'frontend', 'unit', 'after', 'since', 'before', 'last', 'latest', 'change', 'changes', 'fix', 'edit', 'in', 'on', 'this', 'report', 'draft', 'round', 'by', 'worker', 'it', 'its', 'yet', 'again', 'was', 'were', 'is', 'are', 'not', 'output', 'exit', 'line', 'code', 'status', 'of', 'for', 'any', 'project', 'final', 'new', 'readme', 'guide', 'docs', 'notes', 'document', 'heading', 'title', 'section', 'paragraph', 'sentence', 'changelog', 'comment', 'comments', 'summary', 'here', 'there', 'still'])
const JOINER = /\b(?:and|but|so|means?|meaning|says?|said|hides?|hid|which|that|because|when|whenever|while|whereas|then|thus|therefore|where|if|unless|makes?|causes?)\b|[;:—–]/i
const OWNER_STANDARD = /^\s*\[s\d{1,3}\]/i
const JOB_TAG = /^\s*\[(?:j\d{1,3}|gap)\]\s*/i
const words = (text: string): string[] => text.toLowerCase().match(/[a-z]+(?:[-'][a-z]+)*/g) ?? []
const onlyFiller = (text: string): boolean => !/\d/.test(text) && !JOINER.test(text) && words(text).every((w) => FILLER.has(w))
const evidenceOnlyWhere = (text: string): boolean => onlyFiller((text ?? '').replace(/[\w./\\-]+\.[a-z0-9]{1,6}(?::\d+(?:-\d+)?)?/gi, ' ').replace(/\blines? \d+(?:\s*[-–]\s*\d+)?\b/gi, ' '))

function missingRun(f: { statement: string; evidence?: string }): boolean {
  const raw = f.statement ?? ''
  if (OWNER_STANDARD.test(raw)) return false
  const s = raw.replace(JOB_TAG, '')
  if (!RUN_EVIDENCE.test(s) || JOINER.test(s)) return false
  if (!onlyFiller(s.replace(new RegExp(RUN_EVIDENCE.source, 'gi'), ' '))) return false
  return evidenceOnlyWhere((f.evidence ?? '').replace(new RegExp(RUN_EVIDENCE.source, 'gi'), ' '))
}

const SHOWN = [
  /\b(?:the |a |an |its )?(?:exact )?commands? (?:was|were|is|are) (?:not|never) (?:quoted|shown|printed|pasted)(?: (?:verbatim|in full|exactly))?/gi,
  /\b(?:does|do|did) ?(?:not|n't) (?:quote|paste|show) (?:the )?(?:exact |full )?(?:cargo |npm |vitest )?(?:test |build )?(?:commands?|output)\b/gi,
  /\bunquoted (?:commands?|output)\b/gi,
  /\b(?:the )?(?:test |command |build )?output (?:was|is|were) (?:not|never) (?:pasted|quoted|shown)\b/gi,
  /\b(?:the |a |its |new )?tests? (?:was|were|is|are) (?:not|never) (?:shown|seen|printed) (?:to )?fail(?:ing)?(?: first| before (?:the )?(?:fix|change|implementation))?/gi,
  /\b(?:no |missing |absent )?(?:test[- ]first|red[- ]green|tdd|failing[- ]first) (?:printouts?|outputs?|evidence|transcripts?|proofs?|runs?|steps?|records?)\b/gi
]
const WRITTEN = [
  /\b(?:the )?(?:wording|phrasing|punctuation|whitespace|spacing|headings?|spelling|capitali[sz]ation|formatting|indentation|grammar|tone)(?: of the (?:heading|title|section|paragraph|sentence|readme|guide|report|notes))? (?:is|are|was|were) (?:unclear|inconsistent|misspelt|misspelled|awkward|clumsy|untidy|messy)\b/gi,
  /\b(?:a |an |the )?(?:typos?|misspellings?|stray (?:commas?|spaces?|dash(?:es)?)|double spaces?|trailing whitespace|em[- ]?dash(?:es)?|en[- ]?dash(?:es)?|count words?)\b/gi
]
function shownOrWritten(f: { statement: string; evidence?: string }): 'evidence' | 'wording' | null {
  const raw = f.statement ?? ''
  if (OWNER_STANDARD.test(raw)) return null
  const s = raw.replace(JOB_TAG, '')
  if (JOINER.test(s) || /\d/.test(s)) return null
  let rest = s
  let kind: 'evidence' | 'wording' | null = null
  for (const re of SHOWN) if (new RegExp(re.source, 'i').test(rest)) { rest = rest.replace(re, ' '); kind = 'evidence' }
  for (const re of WRITTEN) if (new RegExp(re.source, 'i').test(rest)) { rest = rest.replace(re, ' '); kind = kind ?? 'wording' }
  if (!kind || !onlyFiller(rest) || !evidenceOnlyWhere(f.evidence ?? '')) return null
  return kind
}

export function missingRunOnly(findings: readonly { severity: string; statement: string; evidence?: string }[]): boolean {
  const blocking = findings.filter((f) => f.severity === 'blocking')
  return blocking.length > 0 && blocking.every(missingRun)
}

export type FindingClass = 'evidence' | 'wording' | 'plumbing' | 'work'
const PLUMBING = /^(?:the plan was written after the first file change(?: again)?|the draft could not be taken from the copy)\.?$/i
export function findingClass(f: { severity?: string; statement: string; evidence?: string }): FindingClass {
  const raw = (f.statement ?? '').trim()
  if (OWNER_STANDARD.test(raw)) return 'work'
  const s = raw.replace(JOB_TAG, '')
  if (isAdminNote(s) || PLUMBING.test(s.trim())) return 'plumbing'
  if (missingRun(f)) return 'evidence'
  return shownOrWritten(f) ?? 'work'
}
export function findingClasses(findings: readonly { severity: string; statement: string; evidence?: string }[]): FindingClass[] {
  return findings.filter((f) => f.severity === 'blocking').map(findingClass)
}

export interface GateRecord { reviewerId: string; at: string; verdict: string; summary?: string; findings: readonly FindingLite[] }
const REFUSED_HEAD = 'The reviewer found the draft does not meet the criteria.'
const VISUAL_PREFIX = 'The careful visual review: '
export function gateProcessOnly(input: { records: readonly GateRecord[]; since: string; objections: readonly string[]; neverLeaves: (path: string) => boolean; draftFiles: readonly string[] }): { points: string[] } | null {
  const newest = new Map<string, GateRecord>()
  for (const r of input.records) {
    if (r.at < input.since) continue
    const had = newest.get(r.reviewerId)
    if (!had || had.at < r.at) newest.set(r.reviewerId, r)
  }
  const read = [...newest.values()]
  const refusing = read.filter((r) => r.verdict !== 'meets' || r.findings.some((f) => f.severity === 'blocking'))
  if (!refusing.length) return null
  const draftStaysIn = input.draftFiles.length > 0 && input.draftFiles.every((p) => input.neverLeaves(p))
  const points: string[] = []
  for (const r of refusing) {
    if (r.verdict !== 'does-not-meet') return null
    const blocking = r.findings.filter((f) => f.severity === 'blocking')
    if (!blocking.length) return null
    for (const f of blocking) {
      if (findingClass(f) === 'work') return null
      if (f.file ? !input.neverLeaves(f.file) : !draftStaysIn) return null
      points.push(f.statement.trim())
    }
  }
  const known = new Set<string>([REFUSED_HEAD])
  for (const r of read) {
    if (r.summary?.trim()) known.add(r.summary.trim())
    for (const f of r.findings) known.add(`${f.severity}: ${f.statement} (${f.evidence ?? ''})`.trim())
  }
  for (const o of input.objections) {
    const line = o.trim().startsWith(VISUAL_PREFIX) ? o.trim().slice(VISUAL_PREFIX.length).trim() : o.trim()
    if (line && !known.has(line)) return null
  }
  return { points: [...new Set(points)] }
}
