// Review depth and reviewer choice by what a job touches, and the reviewer's brief.
import { MANAGER_MODELS, currentBrain } from './models'
import { intentBrief, checkInstructions, type IntendedWork } from './intended-work'
import { criteriaBrief, CRITERIA_INSTRUCTIONS, OBJECTION_TAGGING, type CriterionResult, type ReviewCriterion } from './review-checklist'
import { CRITERIA_CONFLICT_MARKING } from './criteria-conflict'
import { sawNothing, type Sighting } from './sighting'
import { usedByBlock } from './dependents'
import { FOUNDER_REVIEW_CRITERIA, SCREEN_SKILL, TRIGGERS } from './skill-policy'
import { DESIGN_SKILLS, SCREEN_CHECK } from './visual-review'
import { ROLE_WORDS, type FileRole } from './file-role'
import { CLOCK_RETRY_LINE, stoppedOnTheClock } from './clock-wait'
import { plainForOwner } from './owner-plain'
import { plainName } from './untrusted'
import { acceptedHow, keptWords, type AcceptedHow, type DecidedBy } from './landing-words'

export type ReviewDepth =
  | 'none'
  | 'single'
  | 'full'

export interface CapabilityStakes {
  capability: string
  depth: ReviewDepth
  words: string[]
}

export const STAKES: CapabilityStakes[] = [
  { capability: 'permission', depth: 'full', words: ['auth', 'login', 'log in', 'sign in', 'sign-in', 'signin', 'sign up', 'signup', 'password', 'session', 'token', 'permission', 'permissions', 'role', 'roles', 'admin', 'access'] },
  { capability: 'separation', depth: 'full', words: ['tenant', 'tenants', 'multi-tenant', 'account', 'accounts', 'customer', 'customers', 'user data', 'per user', 'isolation'] },
  { capability: 'secrets', depth: 'full', words: ['secret', 'secrets', 'api key', 'api keys', 'key', 'keys', 'credential', 'credentials', 'env', 'environment variable', '.env'] },
  { capability: 'engine', depth: 'full', words: ['payment', 'payments', 'checkout', 'billing', 'invoice', 'refund', 'refunds', 'charge', 'charges', 'stripe', 'order', 'orders', 'webhook', 'api', 'endpoint', 'endpoints', 'server', 'backend', 'validation'] },
  { capability: 'data', depth: 'full', words: ['database', 'schema', 'migration', 'migrations', 'prisma', 'sql', 'table', 'tables', 'model', 'models'] },
  { capability: 'recovery', depth: 'full', words: ['backup', 'backups', 'restore', 'delete', 'deletion', 'purge', 'wipe'] },

  { capability: 'screens', depth: 'single', words: ['page', 'pages', 'screen', 'screens', 'ui', 'interface', 'form', 'forms', 'layout', 'component', 'components', 'frontend', 'front-end'] },
  { capability: 'documents', depth: 'single', words: ['letter', 'report', 'one-pager', 'one pager', 'brochure', 'slides', 'deck', 'presentation', 'proposal', 'pdf', 'printable', 'a4', 'document'] },
  { capability: 'hosting', depth: 'single', words: ['deploy', 'deployment', 'docker', 'hosting', 'host', 'ci', 'pipeline', 'build'] },
  { capability: 'shipping', depth: 'single', words: ['test', 'tests', 'testing', 'lint', 'checks'] },
  { capability: 'flooding', depth: 'single', words: ['rate limit', 'rate limiting', 'throttle', 'quota', 'abuse'] },
  { capability: 'speed', depth: 'single', words: ['cache', 'caching', 'performance', 'slow', 'speed', 'optimise', 'optimize'] },
  { capability: 'crowds', depth: 'single', words: ['load', 'scale', 'scaling', 'traffic', 'concurrency'] },
  { capability: 'alarms', depth: 'single', words: ['monitoring', 'alerting', 'alerts', 'logging', 'sentry', 'errors'] },

  { capability: 'running-cost', depth: 'none', words: ['cost estimate', 'running cost', 'monthly cost', 'budget estimate'] }
]

const DEPTH_ORDER: Record<ReviewDepth, number> = { none: 0, single: 1, full: 2 }

function saysWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
}

export function capabilitiesIn(text: string): string[] {
  const t = (text ?? '').toLowerCase().replace(/\s+/g, ' ')
  return STAKES.filter((s) => s.words.some((w) => saysWord(t, w))).map((s) => s.capability)
}

export function hasVisibleSurface(text: string): boolean {
  return capabilitiesIn(text).includes('screens')
}

const CRITIQUE_WORDS = [
  'critique',
  'critic',
  'product review',
  'review the product',
  'review the app',
  'review the site',
  'quality check',
  'quality assurance',
  'pressure test',
  'pressure-test',
  'stress test',
  'audit',
  'poke holes',
  'find gaps',
  'find the gaps',
  'find problems',
  'find the problems',
  'test the product',
  'test the app',
  'test the site',
  'user test',
  "devil's advocate",
  'red team',
  'red-team',
  'qa'
]
export function hasCritiqueSurface(text: string): boolean {
  const t = (text ?? '').toLowerCase().replace(/\s+/g, ' ')
  return CRITIQUE_WORDS.some((w) => saysWord(t, w))
}

export function reviewWhyForManager(why: string): string {
  return why.replace(/\bteammate\b/g, 'worker')
}

export function hasDocumentSurface(text: string): boolean {
  return capabilitiesIn(text).includes('documents')
}

export function depthForWork(text: string): { depth: ReviewDepth; because: string[] } {
  const capabilities = capabilitiesIn(text)
  const hit = STAKES.filter((s) => capabilities.includes(s.capability))
  if (hit.length === 0) return { depth: 'single', because: [] }
  const top = hit.reduce((best, s) => (DEPTH_ORDER[s.depth] > DEPTH_ORDER[best.depth] ? s : best), hit[0]!)
  return { depth: top.depth, because: hit.filter((s) => s.depth === top.depth).map((s) => s.capability) }
}

const LEGACY_BRAINS = new Set<string>(MANAGER_MODELS.filter(m => m.legacy).map(m => m.id))
const CLAUDE_LADDER = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5-20251001'
] as const

const NEVER_REVIEWS = new Set<string>(['claude-haiku-5-5', 'claude-haiku-4-5-20251001'])

export function rankOf(model: string): number | null {
  const at = CLAUDE_LADDER.indexOf(model as (typeof CLAUDE_LADDER)[number])
  return at === -1 ? null : CLAUDE_LADDER.length - at
}

export type ReviewStanding =
  | { kind: 'review'; why: string }
  | { kind: 'second-opinion'; why: string; offer?: string }

export function standingOf(workerModel: string, reviewerModel: string, ceiling?: string): ReviewStanding {
  const worker = rankOf(workerModel)
  const reviewer = rankOf(reviewerModel)

  if (worker === null || reviewer === null) {
    return {
      kind: 'second-opinion',
      why: 'Damon has no honest way to say which of these two brains is stronger, because nobody publishes an ordering across different companies. A second pair of eyes still catches things, so this is worth having, but it is not a review.'
    }
  }

  if (reviewer > worker) {
    return { kind: 'review', why: 'The reviewer thinks with a stronger brain than the teammate.' }
  }

  if (reviewer === worker && reviewerModel === STANDARD_REVIEWER) {
    return { kind: 'review', why: 'An independent reviewer on Opus 5.5, Damon’s standard reviewing brain, read the work fresh against its criteria.' }
  }

  const cap = ceiling ? rankOf(ceiling) : null
  if (cap !== null && worker >= cap) {
    return {
      kind: 'second-opinion',
      why: 'Nobody on this project can be given a stronger brain than the teammate, because of the ceiling you set.',
      offer: 'Let reviewers alone go one step above your ceiling. They are a small share of the work, so it costs little, and without it this role is not really being reviewed.'
    }
  }

  if (worker === rankOf(CLAUDE_LADDER[0]!)) {
    return {
      kind: 'second-opinion',
      why: 'The teammate is already on the strongest brain there is, so nothing can review it from above. A second read still helps.'
    }
  }

  return {
    kind: 'second-opinion',
    why: 'The reviewer is not on a stronger brain than the teammate, so this is a second read rather than a review.'
  }
}

export function reviewerCeiling(maxBrain: string | undefined, aboveCeiling: boolean | undefined): string | undefined {
  if (!maxBrain || !aboveCeiling) return maxBrain || undefined
  const cap = rankOf(currentBrain(maxBrain))
  if (cap === null) return maxBrain
  for (let i = CLAUDE_LADDER.length - 1; i >= 0; i--) {
    const candidate = CLAUDE_LADDER[i]!
    if (rankOf(candidate)! > cap && !LEGACY_BRAINS.has(candidate) && !NEVER_REVIEWS.has(candidate)) return candidate
  }
  return maxBrain
}

export const STANDARD_REVIEWER = 'claude-opus-5-5'
export const STRONGEST_REVIEWER = 'claude-fable-5-1'

export type ReviewerReason = 'standard' | 'owner-pick' | 'second-try' | 'risky-code' | 'under-ceiling' | 'unranked'

export interface ReviewerContext {
  ownerPick?: boolean
  opusRefusals?: number
  fableTried?: boolean
  risky?: readonly string[]
}

export interface ReviewerPick {
  model: string | null
  reason: ReviewerReason
  line: string
}

const brainLabel = (id: string): string => MANAGER_MODELS.find((m) => m.id === id)?.label ?? id

function allowedUnder(ceiling: string | undefined): (model: string) => boolean {
  const cap = ceiling ? rankOf(currentBrain(ceiling)) : null
  return (model) => {
    const rank = rankOf(model)
    if (rank === null) return false
    if (cap !== null && rank > cap) return false
    return !LEGACY_BRAINS.has(model) && !NEVER_REVIEWS.has(model)
  }
}

function escalation(ctx: ReviewerContext, allowed: (m: string) => boolean): ReviewerPick | null {
  if (!allowed(STRONGEST_REVIEWER)) return null
  const fable = brainLabel(STRONGEST_REVIEWER)
  if (ctx.ownerPick) return { model: STRONGEST_REVIEWER, reason: 'owner-pick', line: `${fable}: you chose Fable for this project` }
  if (ctx.risky?.length) return { model: STRONGEST_REVIEWER, reason: 'risky-code', line: `${fable}: a code change touching ${ctx.risky.join(', ')}` }
  if ((ctx.opusRefusals ?? 0) >= 2 && !ctx.fableTried) return { model: STRONGEST_REVIEWER, reason: 'second-try', line: `${fable}: second try after two Opus refusals` }
  return null
}

export function reviewerPick(workerModel: string, ceiling?: string, ctx: ReviewerContext = {}): ReviewerPick {
  const worker = rankOf(workerModel)
  if (worker === null) return { model: null, reason: 'unranked', line: '' }
  const allowed = allowedUnder(ceiling)
  const up = escalation(ctx, allowed)
  if (up) return up
  const target = NEVER_REVIEWS.has(currentBrain(workerModel)) || NEVER_REVIEWS.has(workerModel) ? 'claude-sonnet-5-5' : STANDARD_REVIEWER
  const targetRank = rankOf(target)!
  if (allowed(target) && (targetRank > worker || target === STANDARD_REVIEWER)) {
    return { model: target, reason: 'standard', line: `${brainLabel(target)}: standard review` }
  }
  for (const candidate of CLAUDE_LADDER) {
    const rank = rankOf(candidate)!
    if (rank > targetRank || rank <= worker) continue
    if (allowed(candidate)) return { model: candidate, reason: 'under-ceiling', line: `${brainLabel(candidate)}: the strongest reviewer under your ceiling` }
  }
  return { model: null, reason: 'under-ceiling', line: `${brainLabel(workerModel)}: nothing stronger under your ceiling, so a second read` }
}

export function checkerPick(ceiling?: string, ctx: ReviewerContext = {}): ReviewerPick {
  const allowed = allowedUnder(ceiling)
  const up = escalation(ctx, allowed)
  if (up) return { ...up, line: up.reason === 'second-try' ? `${brainLabel(STRONGEST_REVIEWER)}: second try after two Opus refusals of this final check` : up.line }
  if (allowed(STANDARD_REVIEWER)) return { model: STANDARD_REVIEWER, reason: 'standard', line: `${brainLabel(STANDARD_REVIEWER)}: standard final check` }
  for (const candidate of CLAUDE_LADDER) {
    if (rankOf(candidate)! > rankOf(STANDARD_REVIEWER)!) continue
    if (allowed(candidate)) return { model: candidate, reason: 'under-ceiling', line: `${brainLabel(candidate)}: the strongest checker under your ceiling` }
  }
  return { model: null, reason: 'under-ceiling', line: '' }
}

export function countReviewBrain(task: { opusRefusals?: number; fableTried?: true }, outcome: { ran: boolean; satisfied: boolean; reviewerModel: string }): void {
  if (!outcome.ran) return
  if (outcome.reviewerModel === STRONGEST_REVIEWER) task.fableTried = true
  else if (!outcome.satisfied && outcome.reviewerModel === STANDARD_REVIEWER) task.opusRefusals = (task.opusRefusals ?? 0) + 1
}

export function reviewerFor(workerModel: string, ceiling?: string, ctx?: ReviewerContext): string | null {
  return reviewerPick(workerModel, ceiling, ctx).model
}

export function oneRungAbove(workerModel: string, ceiling?: string): string | null {
  const worker = rankOf(workerModel)
  if (worker === null) return null
  const cap = ceiling ? rankOf(currentBrain(ceiling)) : null
  for (let i = CLAUDE_LADDER.length - 1; i >= 0; i--) {
    const candidate = CLAUDE_LADDER[i]!
    const rank = rankOf(candidate)!
    if (rank <= worker) continue
    if (cap !== null && rank > cap) continue
    if (LEGACY_BRAINS.has(candidate)) continue
    if (NEVER_REVIEWS.has(candidate)) continue
    return candidate
  }
  return null
}

export function successorMove(model: string, ceiling?: string): { to: string; label: string; reviews: string } | null {
  const to = currentBrain(model)
  if (to === model) return null
  const next = MANAGER_MODELS.find((m) => m.id === to && !m.legacy)
  if (!next) return null
  const name = (id: string): string => MANAGER_MODELS.find((m) => m.id === id)?.label ?? id
  const before = reviewerFor(model, ceiling)
  const after = reviewerFor(to, ceiling)
  let reviews: string
  if (!after) reviews = `Nothing ${ceiling ? 'under your ceiling ' : ''}is stronger than ${next.label}, so its work gets a second read rather than a review.`
  else if (after === before) reviews = `Its reviews stay with ${name(after)}.`
  else if (before && (rankOf(after) ?? 0) > (rankOf(before) ?? 0)) reviews = `Its reviews move up to ${name(after)}, which costs more per review.`
  else reviews = `Its reviews move to ${name(after)}.`
  return { to, label: next.label, reviews }
}

export type Arrival =
  | { kind: 'passed'; line: string }
  | { kind: 'unresolved'; line: string; objection: string }

export interface RoleReview {
  name: string
  model: string
  kind: 'review' | 'second-opinion'
  why: string
  offer?: string
  reviewer: string | null
  reviewerWhy: string
}

export function reviewNotesFor(
  nodes: { name: string; model: string }[],
  ceiling?: string,
  aboveCeiling?: boolean
): RoleReview[] {
  const forReviewers = reviewerCeiling(ceiling, aboveCeiling)
  return nodes.map((n) => {
    const pick = reviewerPick(n.model, forReviewers)
    const reviewer = pick.model
    const standing = standingOf(n.model, reviewer ?? n.model, forReviewers)
    return {
      name: n.name,
      model: n.model,
      kind: standing.kind,
      why: standing.why,
      offer: standing.kind === 'second-opinion' ? standing.offer : undefined,
      reviewer,
      reviewerWhy: pick.line
    }
  })
}

export function unreviewedLine(notes: RoleReview[]): string {
  const weak = notes.filter((n) => n.kind === 'second-opinion')
  if (weak.length === 0) return ''
  const all = weak.length === notes.length
  const who = weak.map((n) => n.name).join(', ')
  const count = all
    ? `None of these ${notes.length} people`
    : `${weak.length} of these ${notes.length} people`
  const verb = weak.length === 1 && !all ? 'gets' : 'get'
  return `${count} (${who}) ${verb} a second opinion on their work rather than a review, because nothing stronger is available to check them.`
}

export function ceilingOfferFrom(notes: RoleReview[]): string {
  return notes.find((n) => n.offer)?.offer ?? ''
}

export interface Artifact {
  file: string
  how: 'written' | 'handed over' | 'recorded output'
}

export function filesTouched(calls: { tool: string; summary: string; detail?: string }[]): string[] {
  const out: string[] = []
  const push = (file: string): void => {
    const f = file.trim()
    if (f.length > 0 && f.length < 300 && !out.includes(f)) out.push(f)
  }
  for (const call of calls) {
    if (!call.summary.trim().startsWith('Editing')) continue
    if (call.detail) {
      for (const line of call.detail.split('\n')) push(line)
      continue
    }
    const m = /^Editing\s+(.+)$/.exec(call.summary.trim())
    if (m) push(m[1]!)
  }
  return out
}

export function artifactsFor(
  calls: { tool: string; summary: string }[],
  handedOver: { file: string }[]
): Artifact[] {
  const out: Artifact[] = []
  for (const file of filesTouched(calls)) out.push({ file, how: 'written' })
  for (const h of handedOver) {
    if (!out.some((a) => a.file === h.file)) out.push({ file: h.file, how: 'handed over' })
  }
  return out
}

export interface ReviewerBrief {
  reportOnly?: boolean
  intent?: IntendedWork
  report?: string
  needs?: string
  taskTitle: string
  instructions?: string
  criteria: string
  artifacts: Artifact[]
  round: number
  previousObjections: string[]
  sighting?: Sighting
  plan?: string
  facts?: string
  documents?: string[]
  audience?: string
  judged?: ReviewCriterion[]
  rulings?: string[]
  agentPlan?: string
  revision?: boolean
  managerAsked?: string[]
  usedBy?: string[]
  checklist?: string[]
  skillsUsed?: { ref: string; rules?: string; changed?: true; founder?: boolean }[]
  skillsTool?: boolean
  tools?: ReadonlySet<string>
  careful?: string
  pictureTool?: boolean
  roles?: { file: string; role: FileRole }[]
}

export const SEVERITY_BY_ROLE = [
  "HOW SERIOUS A FINDING IS, by what the file is for (Damon's rule, 4 October 2026):",
  "- blocking: the work is wrong, missing, untrue or unsafe, or it would mislead whoever reads or uses it, or it fails a criterion. In a file that goes out under the owner's name or to a client, his writing rules apply in full and a slip in them is blocking. A sheet written for the owner is judged like what goes out: his form may be filled from it.",
  '- concern: a real weakness that does not fail a criterion.',
  "- note: a cosmetic point (a long dash, a typo, punctuation, a heading, formatting, wording that reads fine) in a file that does not go out: an internal document, Damon's own record or a view. A note never sends the work back; it stays on the record for whoever next touches the file.",
  '- A wrong number, date, amount, count, name or claim is never cosmetic, wherever it is.',
  '- Code, tests and contracts are judged exactly as always.',
  "- A point that breaks one of the owner's standards above (s1, s2, ...) is blocking wherever it is: only he narrows a standard. Tag it with the standard.",
  'When everything you found is a note or a concern, the work meets its criteria; record those points with it.'
].join('\n')

export const VERDICT_BLOCK = 'VERDICT:'
export const OBJECTIONS_BLOCK = 'OBJECTIONS:'

const OPENING = [
  'Assume this work is wrong and your job is to find where.',
  '',
  'That is the stance to start from, not the conclusion you owe anybody. Work that is genuinely sound exists, and "I looked for the following specific problems and none of them are there" is a real answer that costs you nothing to give. What is not acceptable is a pass you arrived at by reading it over and feeling reassured. Name what you checked.'
].join('\n')

const INTERFACE_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$/i

export function interfaceFiles(files: string[]): string[] {
  return files.filter((f) => INTERFACE_FILE.test(f.trim()))
}

export const REVIEWER_SEND_BACK = 'The reviewer read your work and is not satisfied.'
export const CODE_SEND_BACK = "Damon's own checks read your files and found something to fix."
export function managerRevisions(feedback: string[] | undefined): string[] {
  return (feedback ?? []).filter((f) => typeof f === 'string' && f.trim() && !f.startsWith(REVIEWER_SEND_BACK) && !f.startsWith(CODE_SEND_BACK)).slice(-3).map((f) => f.trim().slice(0, 1500))
}

const designSkillRef = (ref: string): boolean => {
  const id = ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref
  return DESIGN_SKILLS.includes(id) || TRIGGERS.design.includes(id) || /design|ui-ux|ui-styling/i.test(id)
}
export function designCitation(ids: readonly string[]): string {
  const first = ids[0] ?? SCREEN_SKILL
  return `Every design finding (how a screen or page looks, reads or is used) names in its evidence the skill guideline it relies on, by skill and section, like "${first} > Working rules", or "${first} > color.md > Contrast" for a reference file the skill sent you to. The design skills on this job: ${ids.join(', ')}. Read the one you cite with the skills tool; never cite a section you did not read. A design point no guideline supports is labelled as your own judgement.`
}

export function reviewerBrief(b: ReviewerBrief): string {
  const clockStopped = b.previousObjections.some(stoppedOnTheClock)
  const previousObjections = b.previousObjections.filter((o) => !stoppedOnTheClock(o))
  const lines: string[] = [
    `You are reviewing finished work on the job "${b.taskTitle}".`,
    '',
    OPENING,
    '',
    b.report && !b.reportOnly
      ? 'The worker\'s report is below, after the criteria. It is a CLAIM about the files, not the work: judge the work from the files, and use the report only for criteria about what the worker says, flags or omits.'
      : 'You have NOT been given the worker\'s report, and that is deliberate. A report is a claim about the work. You are here to look at the work.',
    '',
    "The acceptance criteria for this job: the owner's approved standards, word for word, plus what the manager added for this one job. Do not lower them or override the owner's choices. Also check the agreed contents below and flag material omissions in what the intended reader needs; explain your evidence rather than treating every convention as mandatory:",
    ...(b.judged?.length ? criteriaBrief(b.judged) : [b.criteria.trim() || '(none were recorded, which is itself worth saying)', '']),
    'WHAT THE JOB ASKED FOR, so you can see what was requested and quietly not done. This is context and not a standard: do not mark the work against it, but if something here was plainly asked for and is missing from the work, say so and show your evidence.',
    b.instructions?.trim() || '(no brief was recorded for this job, which is itself worth saying)',
    ''
  ]

  if (b.audience?.trim()) lines.push('WHO THIS IS FOR, from the deliverable record. Judge register, level and what is left out against this reader:', b.audience.trim(), 'Also ask, of every number, name and term: can this reader judge it or do something with it? A figure with no comparison, a term this reader would not know, a claim with no consequence for them, is a finding: say what the reader would need instead, or that the line should go.', '')
  if (b.facts?.trim()) lines.push('THE FACT LEDGER the worker was bound to. A figure, a name, a title or a claim in the work that is not here, or that contradicts this, is a finding:', b.facts.trim(), '')
  if (b.documents?.length) lines.push('DOCUMENTS THE OWNER GAVE THE TEAM, in the project folder. They are the ground truth; open the ones that bear on this job and check the work against them:', ...b.documents.map(d => `- ${d}`), '')
  if (b.rulings?.length) lines.push('WHAT THE OWNER ALREADY RULED on earlier reviews in this project. Do not raise these again unless the facts have changed; he has decided them:', ...b.rulings.map(r => `- ${r}`), '')
  if (b.skillsUsed?.length) {
    lines.push('SKILLS THE WORKER USED, at the version it was given (read one with the skills tool for its full text and its reference files). Context, not a second standard: the criteria above are the standard, and the owner\'s rules came before every skill. Where the work plainly breaks a rule or guideline below, that is a finding; show your evidence:')
    for (const s of b.skillsUsed) lines.push(s.changed ? `- ${s.ref}: changed after the job named it, so its rules are not given; judge by the criteria above.` : `- ${s.ref}`, ...(s.rules && !s.changed ? [`  Its guidance, under the headings to cite:`, ...s.rules.split('\n').map(line => `    ${line}`)] : []))
    const design = b.skillsUsed.filter(s => !s.changed && designSkillRef(s.ref))
    if (design.length) lines.push(designCitation(design.map(s => s.ref.slice(0, s.ref.lastIndexOf('@')))))
    if (b.skillsUsed.some(s => s.founder)) lines.push('Founder work is also checked for these, from the founder pack\'s own graders:', ...FOUNDER_REVIEW_CRITERIA.map(c => `- ${c}`))
    if (b.skillsUsed.some(s => s.ref.startsWith(`${SCREEN_SKILL}@`))) lines.push(SCREEN_CHECK)
    lines.push('')
  }
  lines.push(intentBrief(b.intent))
  if (b.intent) lines.push(checkInstructions(b.tools))
  if (b.judged?.length) lines.push(CRITERIA_INSTRUCTIONS)
  if (b.report && b.reportOnly) lines.push('The report IS the deliverable for this job. Treat its statements as claims and verify them independently:', b.report)
  else if (b.report) lines.push('', 'THE WORKER\'S OWN REPORT, a claim to check against the files, and the only evidence for criteria about what the report says:', b.report)
  if (b.needs) lines.push('', b.needs, 'Inspect each selected input and the actual final outputs. Confirm incorporation, not merely existence. A missing essential or unhandled owner choice is a finding. Clearly distinguish drafts from finished outputs.')
  if (b.checklist?.length) lines.push('', 'Contextual checklist. Honour owner decisions and the intended audience:', ...b.checklist.map(c => `- ${c}`))

  if (b.agentPlan?.trim()) {
    lines.push(
      '',
      'The plan the agent set out with, in its own words. Check the work against it: anything planned and missing, and anything built that was never in the plan, is worth a finding. The plan is not a standard of its own; the criteria above are.',
      b.agentPlan.trim()
    )
  }
  if (b.plan?.trim()) {
    lines.push(
      'Where this job sits in the project, from the roadmap Damon keeps. Context only; preserve the owner criteria and agreed contents above. Work that contradicts what is being built around it is a finding:',
      b.plan.trim(),
      ''
    )
  }

  if (b.managerAsked?.length) {
    lines.push(
      'WHAT THE MANAGER ASKED WHEN IT SENT THIS JOB BACK, oldest first. This is part of the job: a change one of these asked for is in scope, even where an earlier job criterion said to change nothing else. It never lowers an owner standard; where the two conflict, the owner standard wins and that is a finding:',
      ...b.managerAsked.map((m) => `- ${m}`),
      ''
    )
  }
  if (b.revision && previousObjections.length > 0) {
    lines.push(
      '',
      `THIS IS ROUND ${b.round}. You, or a reviewer before you, refused earlier rounds for the objections listed at the end. Check those FIRST, one by one, and say for each whether it is dealt with. Then look only at what the changes introduced. Do not re-review what was already fine; keep this short.`,
      ''
    )
  }
  if (b.artifacts.length > 0) {
    lines.push('The files this job changed, from Damon\'s own record of what happened rather than from anything the worker said:')
    const roleOf = new Map((b.roles ?? []).map((r) => [r.file, r.role] as const))
    for (const a of b.artifacts) lines.push(roleOf.has(a.file) ? `- ${a.file} (${a.how}; ${ROLE_WORDS[roleOf.get(a.file)!]})` : `- ${a.file} (${a.how})`)
    lines.push('', 'Open them and read them. Run whatever the criteria describe running.')
    if (b.roles?.length) lines.push('', SEVERITY_BY_ROLE)
    const users = usedByBlock(b.usedBy ?? [], 'reviewer')
    if (users) lines.push('', users)

    const ui = (b.sighting?.kind === 'seen' || b.sighting?.kind === 'out-of-reach') && b.sighting.surface === 'document' ? [] : interfaceFiles(b.artifacts.map((a) => a.file))
    if (ui.length > 0) {
      lines.push(
        '',
        b.skillsTool
          ? 'This job changed the interface, so run the interface checks on it before you decide anything. These are the owner\'s skills: read each with the skills tool (action "read", ids web-design-guidelines and impeccable) and apply it:'
          : 'This job changed the interface, so run the interface checks on it before you decide anything. These are installed skills; use the Skill tool:',
        `- web-design-guidelines, accessibility, keyboard operation, form behaviour, animation, performance.`,
        `- impeccable, its detection pass, for interface patterns that read as machine-made.`,
        '',
        `Run them against these files and nothing else: ${ui.join(', ')}.`,
        '',
        'WHAT THEY FLAG IS FINDINGS, not suggestions to pass on. A control nobody can reach with a keyboard, or text nobody can read, fails the work whether or not the criteria mention it, the owner cannot write "must be usable" on every job and should not have to.',
        'If one of them is NOT INSTALLED on this machine, say so plainly in your reasons. Do not pass work because a check you were told to run was missing: silently skipping the guard is worse than not having one.'
      )
    }
  } else {
    lines.push(
      'Damon has no record of this job changing a single file. If the criteria required something to be built, that is your finding.'
    )
  }

  const sighting: Sighting = b.sighting ?? {
    kind: 'out-of-reach',
    why: 'Damon did not look at this one.'
  }
  const canViewPictures = b.tools ? b.tools.has('view_picture') : !!b.pictureTool
  if (sighting && sighting.kind === 'seen' && sighting.shots.length > 0) {
    const anyFromOwner = sighting.shots.some((s) => s.by === 'owner')
    const judging =
      sighting.surface === 'document'
        ? [
            'Look at it as the person it is for would, on paper. Judge what you can see, not what the markup implies:',
            '- Does it read as designed, or as a default page with text poured in? Hierarchy, alignment, whitespace, one typeface family used with a clear size scale.',
            '- Does the eye land on the right thing first (the name, the title, the answer)?',
            '- Is anything cramped, orphaned at the top of a page, clipped, or running off the edge?',
            '- Is the length appropriate to the audience, purpose and owner choices?',
            '- Can the reader judge every number, name and term on the page, or act on it? A figure with no comparison, a tool name they would not know, a claim with no consequence for them, is a finding.',
            '- Does what is on the page match what the owner actually asked for?'
          ]
        : b.careful
          ? [b.careful]
          : [
              'Look at them. Judge what you can see, not what the code implies you would see:',
              '- Is the main action obvious, or does it have to be hunted for?',
              '- Does it hold together at phone width?',
              '- Is any text unreadable against what is behind it?',
              '- Is anything clipped, overlapping, or running off the edge?',
              '- Does what is on screen match what the owner actually asked for?'
            ]
    lines.push(
      '',
      `Pictures of the finished thing, taken ${sighting.how}:`,
      ...sighting.shots.map((s) => `- ${s.file} (${s.what})${s.by === 'owner' ? ', supplied by the owner, not taken by Damon' : ''}`),
      ...(canViewPictures ? ['Open each picture with view_picture, its path as listed, before you judge how it looks. A picture you have not opened is not evidence.'] : []),
      '',
      ...judging,
      '',
      'A blank or empty picture means it did not render at all. That is a finding, not something to pass over.'
    )
    if (sighting.checks && sighting.checks.length > 0) {
      lines.push('', 'Damon also measured the page:', ...sighting.checks.map((c) => `- ${c}`))
    }
    if (anyFromOwner) {
      lines.push(
        'Some of these came from the owner rather than from Damon, because Damon cannot see them itself. Treat them as what he actually saw.'
      )
    }
  } else if (sighting.kind === 'out-of-reach' && sighting.lookYourself && sighting.surface === 'document') {
    lines.push(
      '',
      `PRINT IT YOURSELF AND LOOK. ${sighting.why}`,
      'For each HTML page in the draft: read it whole with read_review_file, pass its text to look_at_my_page, and look at the picture of the first page that comes back, with the page count and fonts beside it. Judge what you can see, not what the markup implies:',
      '- Does it read as designed, or as a default page with text poured in? Hierarchy, alignment, whitespace, one typeface family used with a clear size scale.',
      '- Does the eye land on the right thing first (the name, the title, the answer)?',
      '- Is anything cramped, orphaned at the top of a page, clipped, or running off the edge?',
      'If look_at_my_page gave you no picture, say plainly in your verdict that nobody saw the page and judge only what its facts show.'
    )
  } else if (sighting.kind === 'out-of-reach' && sighting.lookYourself) {
    lines.push(
      '',
      `LOOK AT IT YOURSELF. ${sighting.why}`,
      ...(b.careful
        ? ['Call look_at_screens (with the places the project names, or none for all of them), then open every picture it lists with your Read tool before you judge anything about how it looks.', b.careful]
        : [
            'Call look_at_screens (with the places the project names, or none for all of them), then open every picture it lists with your Read tool before you judge anything about how it looks. Judge what you can see, not what the code implies you would see:',
            '- Is the main action obvious, or does it have to be hunted for?',
            '- Does it hold together at phone width?',
            '- Is any text unreadable against what is behind it?',
            '- Is anything clipped, overlapping, or running off the edge?',
            '- Does what is on screen match what the owner actually asked for?'
          ]),
      'A blank picture, or one that shows an error instead of the screen, is a finding. If you have no look_at_screens tool or it could not take the pictures, say plainly in your verdict that nobody looked and why; do not write a verdict that reads as though you had seen it.'
    )
  } else if (sighting && sighting.kind !== 'nothing-to-see' && sawNothing(sighting)) {
    const why = sighting.kind === 'seen' ? 'Damon said it looked but came back with no pictures.' : sighting.why
    lines.push(
      '',
      `NOBODY LOOKED AT THIS. ${why}`,
      '',
      'You are judging the code without having seen the result. That is worth doing and it is not the same thing, so SAY SO in your verdict: state plainly that this was not looked at and why. Do not write a verdict that reads as though you had seen it.'
    )
  }

  if (previousObjections.length > 0) {
    lines.push(
      '',
      `This is round ${b.round}. You already objected to this work. Check whether each point below was actually dealt with, not whether the worker says it was:`,
      ...previousObjections.map((o) => `- ${o}`)
    )
  }
  if (clockStopped) lines.push('', CLOCK_RETRY_LINE)

  lines.push(
    '',
    'End your reply with exactly this, and nothing after it:',
    `${VERDICT_BLOCK} pass    (or: ${VERDICT_BLOCK} fail)`,
    `${OBJECTIONS_BLOCK}`,
    '- one line per thing that is wrong, naming the file and what is wrong with it',
    '',
    ...(b.judged?.length ? [OBJECTION_TAGGING, CRITERIA_CONFLICT_MARKING, ''] : []),
    'Write "OBJECTIONS: none" when it passes. An objection has to be something the worker can act on: "the server accepts a negative price, in api/checkout.ts" is one, "could be more robust" is not. If you are not sure, fail it and say why: passing something you have doubts about is the one outcome nobody can recover from.'
  )
  return lines.join('\n')
}

export interface ReviewVerdict {
  satisfied: boolean
  objections: string[]
  answered: boolean
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const verdict = new RegExp(`^[ \\t]*[*_]{0,2}${VERDICT_BLOCK}[*_]{0,2}[ \t]*[*_]{0,2}(\\w+)`, 'im').exec(text ?? '')
  if (!verdict) {
    return {
      satisfied: false,
      answered: false,
      objections: ['The reviewer never gave a verdict, so this has not actually been reviewed.']
    }
  }
  const passed = /^pass(ed)?$/i.test(verdict[1]!.trim()) && [...(text ?? '').matchAll(/^[ \t]*[*_]{0,2}VERDICT:/gm)].length === 1

  const objections: string[] = []
  const block = new RegExp(`^[ \\t]*[*_]{0,2}${OBJECTIONS_BLOCK}[*_]{0,2}[ \t]*[*_]{0,2}(.*)$`, 'im').exec(text)
  if (block) {
    const tail = (block[1] + '\n' + text.slice(block.index + block[0].length)).trim()
    if (!/^none\b/i.test(tail)) {
      for (const raw of tail.split('\n')) {
        const line = raw.trim().replace(/^[-•*]\s*/, '')
        if (line.length < 4) continue
        if (new RegExp(`^[*_]{0,2}(${VERDICT_BLOCK}|${OBJECTIONS_BLOCK})`, 'i').test(line)) break
        objections.push(line.slice(0, 400))
        if (objections.length >= 8) break
      }
    }
  }

  if (!passed && objections.length === 0) {
    objections.push('The reviewer failed this and did not say what was wrong with it.')
  }
  if (passed && !block) objections.push('The reviewer omitted its objections block.')
  return { satisfied: passed && objections.length === 0, answered: true, objections }
}

export interface ReviewRecord {
  disputed?: string
  knownFault?: true
  at: string
  satisfied: boolean
  rounds: number
  standing: 'review' | 'second-opinion'
  why: string
  reviewerModel: string
  reviewerWhy?: string
  objection?: string
  depth: ReviewDepth
  overruledWhy?: string
  decidedBy?: import('./landing-words').DecidedBy
  sighting?: Sighting
  ran?: boolean
  refusals?: number
  infra?: { cls: string; count: number; ownerAgain?: number; carded?: number }
  criteria?: CriterionResult[]
  criteriaConflict?: string[]
  accepted?: { how: AcceptedHow; with?: string }
  processOnly?: boolean
}

function criteriaWords(criteria: CriterionResult[] | undefined, satisfied: boolean): string {
  if (!criteria?.length) return ''
  const met = criteria.filter((c) => c.status === 'pass').length
  if (satisfied) return ` It met ${met} of ${criteria.length} criteria.`
  const open = criteria.filter((c) => c.status !== 'pass')
  if (!open.length) return ` All ${criteria.length} of its criteria were met; what is still open is the objection below, which the criteria do not cover.`
  const withWords = open.find((c) => c.observed.trim())
  if (!withWords) return ` It met ${met} of ${criteria.length} criteria; ${open.length} ${open.length === 1 ? 'is' : 'are'} still open.`
  const first = plainForOwner(withWords.observed, 200, { most: 1 }).replace(/[\s.…]+$/, '')
  return ` It met ${met} of ${criteria.length} criteria. Still open: ${first}${open.length > 1 ? `, and ${open.length - 1} more` : ''}.`
}

export function arrivalOf(input: {
  title: string
  satisfied: boolean
  rounds: number
  lastObjection?: string
  criteria?: CriterionResult[]
  ran?: boolean
}): Arrival {
  const met = criteriaWords(input.criteria, input.satisfied)
  if (input.satisfied) {
    return {
      kind: 'passed',
      line: `"${input.title}" was checked by its reviewer and passed${input.rounds > 1 ? ` after ${input.rounds} goes` : ''}.${met}`
    }
  }
  const objection = (input.lastObjection ?? '').trim()
  if (input.ran === false) {
    return {
      kind: 'unresolved',
      line: `"${input.title}" could not be checked: ${objection.replace(/^The reviewer could not be run(?: to a usable verdict)?: /, '') || 'the reviewer did not run.'} Nobody has read it yet; Damon reads it before it is signed off.`,
      objection: objection || 'The reviewer did not run.'
    }
  }
  const line =
    input.rounds > 1
      ? `"${input.title}" went back ${input.rounds} times and the reviewer is still not satisfied.`
      : `"${input.title}" was checked and the reviewer is not satisfied.`
  return {
    kind: 'unresolved',
    line: `${line}${met} It is in front of you anyway, because sitting on it would be worse, but read it before you accept it.`,
    objection: objection || 'The reviewer did not say what was still wrong.'
  }
}

export function acceptedLine(task: { id: string; title: string; label?: string; review?: { accepted?: ReviewRecord['accepted']; decidedBy?: DecidedBy; overruledWhy?: string } }): { chat: string } | null {
  const review = task.review
  if (!review || review.decidedBy === 'owner') return null
  const how = acceptedHow(review)
  if (!how) return null
  const other = review.accepted?.with ?? (review.accepted ? undefined : /"([^"]+)"/.exec(review.overruledWhy ?? '')?.[1])
  const name = plainName(task.label ?? task.title, 80)
  const named = other ? `“${plainName(other, 120)}”` : 'its follow-up'
  const head = keptWords(review.decidedBy, name, how)
  if (how === 'criteria') return { chat: `${head}: its reviewer found the work correct, and its only objection was that two of the job's own criteria could not both be met, which is Damon's to settle, not the team's.` }
  if (how === 'follow-up') return { chat: `${head}: the reviewer's only objections were about process or wording, so ${named} deals with them. Nothing waits on it.` }
  return { chat: `${head}, with a known fault: ${other ? `its fix ${named}` : 'its fix'} is already lined up. Work that builds on it waits until the fix passes its own review. If it has not within a day, it comes to you.` }
}
