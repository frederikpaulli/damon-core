import { codeIntent } from './code-habits'
import { hasDocumentSurface, hasVisibleSurface } from './review'
import { SCREEN_SELF_CLAUSE } from './visual-review'

export type DraftKind = 'code' | 'screen' | 'document' | 'text'
export interface SeatLooks { screens?: string; page?: string; pages?: boolean; shell: boolean }

export const SELF_CHECK_MARK = 'SELF-CHECK:'
export const SELF_CHECK_HEAD = 'LOOK AT YOUR OWN DRAFT BEFORE A REVIEWER DOES'
export const SELF_CHECK_NOTE = 'The worker handed this draft over without checking it itself, after Damon had asked once. It is recorded on the job and counted; the reviewer reads the work as it is.'
export const SELF_CHECK_DEFERRED = 'Damon asked the worker to look at its own draft and fix it before a reviewer sees it'

export function seatLooks(tools: ReadonlySet<string> | undefined): SeatLooks {
  if (!tools) return { screens: 'mcp__damon__look_at_my_work', page: 'mcp__damon__look_at_my_work', pages: false, shell: true }
  return {
    ...(tools.has('look_at_screens') && tools.has('Read') ? { screens: 'look_at_screens' } : {}),
    ...(tools.has('look_at_my_page') ? { page: 'look_at_my_page', pages: true } : {}),
    shell: tools.has('Bash') || tools.has('run_isolated')
  }
}

export function draftKindsOf(task: { title: string; instructions: string; acceptance: string; writes?: string[]; plan?: string }, changed: readonly string[] = []): DraftKind[] {
  const words = `${task.title} ${task.instructions} ${task.acceptance}`
  const code = codeIntent(task, changed)
  const kinds: DraftKind[] = code ? ['code'] : []
  if (!code && hasDocumentSurface(words)) kinds.push('document')
  else if (hasVisibleSurface(words)) kinds.push('screen')
  return kinds.length ? kinds : ['text']
}

export const skillLine = (id: string): string => `"${id}: what I checked, what I changed"`
const shortName = (id: string): string => id.slice(id.lastIndexOf(':') + 1)
export function skillLinesMissing(selfCheck: string, skills: readonly string[]): string[] {
  const lines = selfCheck.toLowerCase().split('\n')
  return skills.filter(id => { const name = shortName(id).toLowerCase(); return !!name && !lines.some(l => l.includes(id.toLowerCase()) || l.includes(name)) })
}
export function selfCheckBlock(kinds: readonly DraftKind[], looks: SeatLooks, opts: { damonRunsSuite?: boolean; appleDesign?: boolean; skills?: readonly string[] } = {}): string {
  if (!kinds.length) return ''
  const lines: string[] = []
  const suite = opts.damonRunsSuite
    ? 'The targeted checks for what you changed are enough: you do not need the full suite (Damon runs it on the draft himself before the review), and counted checks keep their limit.'
    : 'Run every check your brief names, and no more: where it names no whole suite, the targeted checks for what you changed are enough, and counted checks keep their limit.'
  if (kinds.includes('code')) lines.push(`- Your change: when it is finished, run its checks once more on the finished draft (the ones DONE MEANS and your brief name) and read the real output, not your memory of an earlier run. Fix what fails and run once more. ${suite} Do not re-check parts you did not touch: the reviewer compares those itself.`)
  if (kinds.includes('screen')) lines.push(looks.screens
    ? `- Your screens: look at them with ${looks.screens} once you have something on screen, open every picture, and fix what you see${opts.appleDesign ? ` (${SCREEN_SELF_CLAUSE})` : ''}. At most three looks a round; the fourth is refused.`
    : '- Your screens: you have no camera for screens on this job. Judge from the code with care and say in SELF-CHECK what you could not see.')
  if (kinds.includes('document')) lines.push(looks.page
    ? `- Your document: print it with ${looks.page} and read back the pages, overflow and fonts, and look at the first page${looks.pages ? '; when it prints to more than one page, look at each further page with page set to 2, then 3' : ''}. Fix what you see and print again. Keep it to three prints a round.`
    : '- Your document: you cannot print it on this job. Read it through as the owner will and say in SELF-CHECK that you could not see it printed.')
  if (kinds.includes('text')) lines.push('- Your text: read your finished text once from the top as the owner will read it, and fix what is wrong, unclear or missing.')
  const skills = [...new Set(opts.skills ?? [])]
  if (skills.length) lines.push(`- The skills on this job: rate your finished draft against each one you were given. In SELF-CHECK write one line per skill: ${skills.map(skillLine).join(', ')}, naming the guideline or section of the skill you checked it against and what you changed because of it (or that nothing needed changing).`)
  return ['SELF-CHECK BEFORE YOU HAND OVER (the owner\'s rule: you see your own draft and fix it yourself before a reviewer sees it):', ...lines,
    'Then, in your report before HANDOVER, write "SELF-CHECK:" and one line for each thing you looked at: what you ran or looked at, what it showed, and what you changed because of it (or that nothing needed changing). When your brief has DONE MEANS, name the DONE MEANS id each line is about, like [j1]. If Damon told you a file was left out of the draft, fix that file or say so here. A hand-over without it, or without the look your job has, comes back to you once before any reviewer sees it.'].join('\n')
}

const MARK = /^[\s#>*_-]*SELF[- ]?CHECK\b[*_]*\s*:?[*_]*\s*/i
const NEXT_BLOCK = /^[\s#>*_-]*(?:HANDOVER|MEMORY NOTES|DONE MEANS|CANNOT MEET|PLAN)\b[*_]*\s*:/i
export function selfCheckIn(report: string): string | null {
  const lines = report.split('\n')
  const at = lines.findIndex(l => MARK.test(l))
  if (at < 0) return null
  const body = [lines[at]!.replace(MARK, '')]
  for (const l of lines.slice(at + 1)) { if (NEXT_BLOCK.test(l)) break; body.push(l) }
  const text = body.join('\n').trim()
  return text.length >= 10 ? text : null
}

const used = (uses: readonly { tool: string; ok?: boolean }[], name: string): boolean => uses.some(u => u.ok !== false && (u.tool === name || u.tool.endsWith(`__${name}`)))
const EDITS = /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit)$/
const CHECKS = /(?:^|__)(?:Bash|run_isolated|run_project_check)$/
const lastIndex = (uses: readonly { tool: string }[], test: RegExp): number => { for (let i = uses.length - 1; i >= 0; i--) if (test.test(uses[i]!.tool)) return i; return -1 }

export function selfCheckGap(o: { report: string; kinds: readonly DraftKind[]; looks: SeatLooks; uses: readonly { tool: string; ok?: boolean }[]; skills?: readonly string[] }): string | null {
  const gaps: string[] = []
  const said = selfCheckIn(o.report)
  if (!said) gaps.push('Your report has no SELF-CHECK section.')
  else {
    const missing = skillLinesMissing(said, [...new Set(o.skills ?? [])])
    if (missing.length) gaps.push(`Your SELF-CHECK has no line for ${missing.length === 1 ? 'the skill' : 'the skills'} ${missing.join(', ')}: write ${missing.map(skillLine).join(', ')}.`)
  }
  if (o.kinds.includes('document') && o.looks.page && !used(o.uses, o.looks.page)) gaps.push(`This is a document and you did not print it with ${o.looks.page} in this run.`)
  if (o.kinds.includes('screen') && o.looks.screens && !used(o.uses, o.looks.screens)) gaps.push(`You did not look at your screens with ${o.looks.screens} in this run.`)
  if (o.kinds.includes('code') && o.looks.shell) {
    const edit = lastIndex(o.uses, EDITS)
    if (edit >= 0 && lastIndex(o.uses, CHECKS) < edit) gaps.push('You did not run your checks after your last change.')
  }
  return gaps.length ? gaps.join(' ') : null
}

export function wroteThisRun(o: { changedFiles?: boolean; draftsAt: readonly string[]; since?: string }): boolean {
  return o.changedFiles === true || o.draftsAt.some(at => !o.since || at >= o.since)
}

export function selfCheckResend(gap: string): string {
  return `${SELF_CHECK_HEAD} (one short turn; no round is counted). ${gap}\nYour draft from your last run is kept. Look at it now the way SELF-CHECK below asks, fix only what you find, and report again with "SELF-CHECK:" (what you looked at, what it showed, what you changed), written before your HANDOVER, and then your HANDOVER. To change a file, write it again; a file you leave alone stays as it is in your draft. If nothing needs changing, say so in SELF-CHECK and hand over the same files. Damon asks this once a round; the next hand-over goes to review as it is.`
}
