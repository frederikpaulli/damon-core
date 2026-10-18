import { isRenderedView } from './rendered-views'
import { plainForOwner } from './owner-plain'

export const PLAN_MARK = 'PLAN:'
const MAX_PLAN = 1800

const CHANGING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function changesFiles(tool: string): boolean {
  return CHANGING_TOOLS.has(tool)
}

export function planIn(text: string): string | null {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim().toUpperCase().startsWith(PLAN_MARK))
  if (start < 0) return null
  const first = lines[start]!.trim().slice(PLAN_MARK.length).trim()
  const rest = lines.slice(start + 1)
  const stop = rest.findIndex((l) => /^[A-Z][A-Z ]{2,30}:\s*$/.test(l.trim()) && !l.trim().toUpperCase().startsWith(PLAN_MARK))
  const body = (stop < 0 ? rest : rest.slice(0, stop)).join('\n').trim()
  const plan = [first, body].filter((s) => s.length > 0).join('\n').trim()
  if (!plan) return null
  return plan.length > MAX_PLAN ? plan.slice(0, MAX_PLAN - 1) + '…' : plan
}

export interface PlanRecord {
  text: string
  beforeChanges: boolean
}

export interface PlanFinding {
  kind: 'no-plan'
  text: string
}

export function planFinding(o: { firstRound: boolean; plan: PlanRecord | null; changedFiles: boolean }): PlanFinding | null {
  if (!o.firstRound || !o.changedFiles) return null
  if (!o.plan) {
    return {
      kind: 'no-plan',
      text: 'This job changed files without writing a plan first. Every job starts with a PLAN: block, before the first file is touched.'
    }
  }
  return null
}

export const LATE_PLAN_NOTE = 'The plan for this job was written after the first file had already been changed. That cannot be undone, so it is recorded on the job and counted, and the work is reviewed on its merits.'
export function planNote(o: { firstRound: boolean; plan: PlanRecord | null; changedFiles: boolean }): string | null {
  return o.firstRound && o.changedFiles && o.plan && !o.plan.beforeChanges ? LATE_PLAN_NOTE : null
}

export const LATE_PLAN_LESSON = 'Write the PLAN: block before changing the first file.'
export function processNotesBlock(job: { processNotes?: string[] }): string {
  const notes = job.processNotes ?? []
  return notes.length ? `\nDamon noted, and it is not a reason to send the work back:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''
}
export const LATE_PLAN_WINDOW = 10
export const LATE_PLAN_HABIT = 3
export function latePlans(jobs: { agentId: string; updatedAt: string; processNotes?: string[] }[], agentId: string): number {
  return jobs
    .filter((j) => j.agentId === agentId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, LATE_PLAN_WINDOW)
    .filter((j) => (j.processNotes ?? []).includes(LATE_PLAN_NOTE)).length
}
export function planHabitPrompt(agentName: string): string {
  return `[Routine notice: this is NOT a message from the user] The last ${LATE_PLAN_HABIT} plans from your agent "${agentName}" came after it had started changing files. Nothing was sent back for it. You may want to tell it to plan first: the PLAN: block comes before the first file is touched. No action is needed from you beyond that.`
}

export function planFiles(plan: string): string[] {
  const out: string[] = []
  for (const m of plan.matchAll(/(?:^|[\s(`"'=])((?:[\w.-]+[\\/])+[\w.*-]+|[\w-]+\.(?:md|html?|css|js|ts|tsx|jsx|json|ya?ml|pdf|txt|csv|xlsx?|docx?|png|jpe?g|svg|py|sql|sh))(?=[\s,;:.)`"'>]|$)/gi)) {
    const f = m[1]!.replace(/\\/g, '/').replace(/^\.\//, '').replace(/[.,;:]+$/, '')
    if (/[*?]/.test(f) || f.includes('://')) continue
    if (f.split('/').includes('..')) continue
    const before = plan.slice(Math.max(0, m.index - 12), m.index)
    if (/(href|src)\s*=\s*["']?$/i.test(before)) continue
    const last = f.split('/').pop() ?? ''
    if (f.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(last) && !f.endsWith('/')) continue
    if (!out.includes(f)) out.push(f)
  }
  return out
}

const WRITE_WORDS = /\b(writ(e|es|ing|ten)|creat(e|es|ing)|edit(s|ing)?|chang(e|es|ing)|updat(e|es|ing)|add(s|ing)?|sav(e|es|ing)|produc(e|es|ing)|generat(e|es|ing)|mak(e|es|ing)|modif(y|ies|ying)|append(s|ing)?|output|deliverable|deliver(s|ing)?|new file|files? (i|we) will (create|change|write))\b/i
const READ_WORDS = /\b(read(s|ing)?|open(s|ing)?|check(s|ing)?|consult(s|ing)?|look(s|ing)? at|review(s|ing)?|stud(y|ies|ying)|refer(s|ring)? to|from|based on|input(s)?|source(s)?|reference(s)?|according to|per|cite|quot(e|es|ing))\b/i

export function planWrites(plan: string): string[] {
  const out: string[] = []
  for (const named of planFiles(plan)) {
    if (/^attachments\//i.test(named)) continue
    const f = named.replace(/^outputs\//i, '')
    if (f.endsWith('/')) continue
    const at = plan.indexOf(named)
    const before = at < 0 ? '' : plan.slice(0, at)
    const clause = before.split(/\n|;|\.(?=\s|$)/).pop() ?? ''
    if (WRITE_WORDS.test(clause) || !READ_WORDS.test(clause)) out.push(f)
  }
  return out
}

export interface PlanRefusalInput {
  plan: string
  writes: string[]
  reads?: string[]
  outside: (files: string[]) => string[]
  own?: string
  others?: string[]
}

export function planRefusal(o: PlanRefusalInput): string | null {
  if (o.writes.length > 0) {
    const reads = (o.reads ?? []).map((r) => r.replace(/\\/g, '/').toLowerCase())
    const drawn = (f: string): boolean => isRenderedView(f) || isRenderedView(f.split('/')[0] ?? '')
    const strayed = o.outside(planWrites(o.plan).filter((f) => f.includes('/') && !drawn(f) && !reads.includes(f.replace(/\\/g, '/').toLowerCase())))
    if (strayed.length > 0) {
      return `The plan names ${strayed.slice(0, 4).join(', ')}${strayed.length > 4 ? ` and ${strayed.length - 4} more` : ''}, outside where this job may write (${o.writes.join(', ')}). Stopped before anything was changed. Either the plan stays inside the scope, or the job is given out again with the scope it needs.`
    }
  }
  if (o.own && o.others && o.others.length > 0) {
    const t = o.plan.toLowerCase()
    const own = o.own.toLowerCase()
    const mentionsOwn = t.includes(own) || t.includes(own.split(/\s+/)[0] ?? own)
    const wrong = o.others.find((c) => c.trim().length > 2 && t.includes(c.toLowerCase()) && c.toLowerCase() !== own)
    if (wrong && !mentionsOwn) {
      return `The plan is about ${wrong}, and this job is about ${o.own}. Stopped before anything was changed. The job's facts are in its own record; the plan works from those.`
    }
  }
  return null
}

export const CANNOT_MEET_MARK = 'CANNOT MEET:'
export function cannotMeetIn(plan: string): { ids: string[]; why: string } {
  const clean = (l: string): string => l.trim().replace(/^[-*\s]+/, '')
  const line = plan.split('\n').map(clean).find((l) => l.toUpperCase().startsWith(CANNOT_MEET_MARK))
  if (!line) return { ids: [], why: '' }
  const rest = line.slice(CANNOT_MEET_MARK.length).replace(/^[*\s]+/, '').trim()
  if (/^none\b/i.test(rest)) return { ids: [], why: '' }
  const lead = /^(?:[sj]\d{1,2}\b[\s,/&]*(?:and\b\s*)?)+/i.exec(rest)?.[0] ?? ''
  const ids = [...new Set([...lead.matchAll(/\b([sj]\d{1,2})\b/gi)].map((m) => m[1]!.toLowerCase()))]
  return { ids, why: ids.length ? rest.slice(0, 600) : '' }
}
export const PARK_ANSWER_HEAD = 'The manager changed what this job asks'
export const PARK_ANSWERED_HEAD = 'The manager answered your plan'
const oneStop = (why: string): string => why.replace(/\s+/g, ' ').trim().replace(/[\s.]+$/, '')
export function parkSentence(ids: string[], why: string): string {
  return `The worker's plan says it cannot meet ${ids.join(', ')} with its tools and where it may write: ${oneStop(why)}. Nothing was changed, and no round was spent. Damon parked the job for one manager turn: change or drop those job criteria with amend_task (criteria), or keep them and say how the worker can meet them with amend_task (resume_why). An owner standard (an s-id) cannot be reworded; if one is impossible here, tell the owner in one plain line.`
}

export function parkStatusLine(why: string): string {
  const said = oneStop(plainForOwner(why, 300, { card: true }))
  return `The worker said it cannot meet part of the job with its tools and where it may write${said ? `: ${said}` : ''}. Nothing was changed; the manager gets one turn to change the job.`
}

export function planInstruction(writes?: string[], protectedRoute = false): string {
  const scope =
    writes && writes.length > 0
      ? `Where this job may write: ${writes.join(', ')}. Nothing outside that, and nothing a teammate is building. Damon reads the plan the moment it appears: a plan that names a file outside this scope stops the job before anything is changed. If the job cannot be done without touching something outside it, do not touch it: say so in your report and stop that part.`
      : 'Stay on what this job asks for and off what your teammates are building.'
  return [
    'BEFORE YOU CHANGE ANYTHING, write your plan. It is the first thing you say, in a block that starts with the line "PLAN:", about ten lines: what you will make, the files you will create or change (paths), the order you will do it in, and how you will check that it works. Reading files, searching and looking around before the plan is fine; changing a file is not. Damon reads the plan in code, keeps it on the job and hands it to the reviewer: a job that changes a file before its plan, or never writes one, is a finding against it.',
    protectedRoute
      ? 'Use the skills you have for this rather than working from habit: superpowers:test-driven-development when you write code, superpowers:systematic-debugging when something is broken, and superpowers:verification-before-completion before you report. Read the one that fits with the skills tool and follow it, under the owner\'s rules at its top.'
      : 'Use the skills you have for this rather than working from habit: superpowers:writing-plans to shape the plan when the job spans more than a few files, superpowers:test-driven-development when you write code, superpowers:systematic-debugging when something is broken, and superpowers:verification-before-completion before you report. Invoke the one that fits with the Skill tool and follow it.',
    scope,
    'End the plan with one line "CANNOT MEET: <ids and why>" naming any criterion in DONE MEANS you cannot meet with your tools and where you may write, or "CANNOT MEET: none". Damon then parks the job before you change anything, and the manager fixes the criterion.'
  ].join('\n')
}
