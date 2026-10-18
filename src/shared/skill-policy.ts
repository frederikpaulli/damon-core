import { SCREEN_SEVERITY } from './visual-review'

export const SKILL_OVERLAY = `THE OWNER'S RULES COME FIRST. What follows is a skill: guidance text, read through Damon. Where it disagrees with any of these rules, the rules win.
- Damon's brief for this job, the owner's decisions and his writing voice come first. A skill that says you MUST do something does not outrank them.
- Never invent his facts, testimonials, customers, quotes or numbers. Every outside fact needs a source link next to it, or "Estimate:" with the arithmetic shown, or "Not found".
- No em dash (U+2014) and no en dash (U+2013), anywhere.
- The project's own market comes first. When it names none, the default is Denmark and the EU: prices in DKK or EUR, GDPR, Danish marketing law and the EU rules on fake reviews, not US law.
- "Ask the founder and stop" means: put your questions at the top of your report and stop. The manager puts them on the owner's list. You never ask him yourself.
- No paid APIs, no posting or sending anything, and no git.
- Reading a skill grants no tool. A step that needs a tool your seat does not have is skipped and named in your report, never faked.
END OF THE OWNER'S RULES. THE SKILL:
`

export const SUPERPOWERS_KEPT = ['systematic-debugging', 'test-driven-development', 'verification-before-completion', 'receiving-code-review'] as const

const GIT = 'Works with git branches and worktrees; a job on Damon never runs git.'
const PROCESS = 'Claude Code\'s own plan-and-checkpoint process; on Damon the manager plans and assigns the jobs.'
const SUBAGENTS = 'Starts its own subagents; on Damon the manager assigns the work with assign_work.'
const NEW_SKILLS = 'For writing new skills, not for project work.'
const APP_TOOLS = 'Drives a browser or the desktop through tools only the Claude app has; the team\'s browser is Damon\'s own.'

export const EXCLUDED: Readonly<Record<string, string>> = {
  'superpowers:brainstorming': 'A process skill that says the model MUST brainstorm with the user before any work; on Damon the manager talks to the owner and a worker never does.',
  'superpowers:using-superpowers': 'Orders the model to load skills before every reply, which would put a skill above Damon\'s brief.',
  'superpowers:writing-plans': PROCESS,
  'superpowers:executing-plans': PROCESS,
  'superpowers:subagent-driven-development': SUBAGENTS,
  'superpowers:dispatching-parallel-agents': SUBAGENTS,
  'superpowers:using-git-worktrees': GIT,
  'superpowers:finishing-a-development-branch': GIT,
  'superpowers:requesting-code-review': 'Asks a sub-agent for a review; Damon runs the independent reviewer itself.',
  'superpowers:writing-skills': NEW_SKILLS,
  'superpowers:diagnosing-superpowers': 'Diagnoses the superpowers plugin itself, not project work.',
  'document-skills:academy-guide': 'A guide to Anthropic\'s own courses, not project work.',
  'document-skills:discernment-nudge': 'Changes how the assistant talks to its user; a worker reports to the manager, not to the owner.',
  'document-skills:doc-coauthoring': 'A co-writing conversation with the user; a worker never talks to the owner.',
  'document-skills:skill-creator': NEW_SKILLS,
  'document-skills:web-artifacts-builder': 'Builds claude.ai artifacts; Damon delivers files in the project folder.',
  'document-skills:slack-gif-creator': 'Makes GIFs for Slack; nothing is posted from a job and there is no Slack connection.',
  'document-skills:template': 'An empty skill template with nothing to follow.',
  'document-skills:brand-guidelines': 'Anthropic\'s own brand colours and fonts; the owner\'s projects carry their own brand.',
  'synced:built-in-browser': APP_TOOLS,
  'synced:chrome-browser': APP_TOOLS,
  'synced:computer-use': APP_TOOLS,
  'synced:docs': 'Writes Claude Docs through a claude.ai connector this route does not have.',
  'synced:google-workspace': 'Edits Google files through a connector this route does not have.',
  'synced:morning': 'The owner\'s personal morning brief, not project work.',
  'synced:import-memory': 'Imports another assistant\'s memory into Claude, not project work.',
  'synced:learn': 'A teaching mode for the owner\'s own learning, not project work.',
  'synced:deep-research': 'Coordinates research subagents with tools this route does not have; the manager assigns research jobs instead.',
  'remove-ai-marks': 'Strips AI provenance marks from text and files. Off by default: only the owner switches it on.'
}

export function exclusionFor(id: string): string | undefined {
  if (EXCLUDED[id]) return EXCLUDED[id]
  if (id.startsWith('superpowers:') && !(SUPERPOWERS_KEPT as readonly string[]).includes(id.slice('superpowers:'.length))) return 'A superpowers process skill added after 2 October 2026 and not reviewed yet; off until it is.'
  return undefined
}

export const SOURCE_ORDER = ['personal', 'plugin', 'synced'] as const
export type SkillSource = 'founder' | 'small-business' | 'damon' | (typeof SOURCE_ORDER)[number]

export const MAX_SKILLS_PER_JOB = 3
export const SCREEN_SKILL = 'apple-design'

export type SkillNeed = 'idea' | 'market' | 'building' | 'price' | 'launch' | 'raise' | 'design' | 'documents' | 'code' | 'report' | 'money' | 'sales' | 'inbox'
export const TRIGGERS: Readonly<Record<SkillNeed, readonly string[]>> = {
  idea: ['founder:validate-idea', 'founder:product-brief', 'founder:user-interviews'],
  market: ['founder:competitor-matrix', 'founder:persona-gen', 'founder:user-interviews'],
  building: ['founder:mvp-scope', 'founder:product-brief'],
  price: ['founder:pricing-strategy', 'founder:metrics-dashboard'],
  launch: ['founder:go-to-market', 'founder:landing-page', 'founder:email-sequence'],
  raise: ['founder:pitch-deck', 'founder:fundraise-prep', 'founder:metrics-dashboard'],
  design: ['ui-ux-pro-max', 'frontend-design:frontend-design', 'impeccable', 'web-design-guidelines'],
  documents: ['document-skills:docx', 'document-skills:pdf', 'document-skills:xlsx', 'document-skills:pptx'],
  code: ['superpowers:systematic-debugging', 'superpowers:test-driven-development', 'superpowers:verification-before-completion', 'superpowers:receiving-code-review'],
  report: ['small-business:report-builder', 'small-business:monday-brief', 'small-business:business-pulse'],
  money: ['small-business:business-pulse'],
  sales: ['small-business:proposal-builder', 'small-business:lead-triage'],
  inbox: ['small-business:inbox-manager', 'small-business:speed-to-lead']
}
export function triggerMapLine(): string {
  return (Object.entries(TRIGGERS) as [SkillNeed, readonly string[]][]).map(([need, ids]) => `${need}: ${ids.join(', ')}`).join('; ') + '.'
}

const FOUNDER_WORDS: [SkillNeed, RegExp][] = [
  ['idea', /\b(?:validate (?:the |an |this |my )?(?:startup |business )?idea|startup idea|business idea|worth building|product brief)\b/i],
  ['market', /\b(?:competitors?|competitor matrix|competition|market research|personas?|customer interviews?|user interviews?)\b/i],
  ['building', /\b(?:mvp|minimum viable)\b/i],
  ['price', /\b(?:pricing (?:strategy|model|tiers?|plan)|what (?:we |they |you )?(?:should )?charge|price points?)\b/i],
  ['launch', /\b(?:go[- ]to[- ]market|launch plan|landing page copy|email sequence|onboarding emails?)\b/i],
  ['raise', /\b(?:pitch deck|fund ?rais(?:e|ing)|investor (?:update|meeting|deck)s?|seed round)\b/i]
]
export function founderHint(text: string): string {
  const needs = FOUNDER_WORDS.filter(([, words]) => words.test(text)).map(([need]) => need)
  if (!needs.length) return ''
  const ids = [...new Set(needs.map(need => TRIGGERS[need][0]!))].slice(0, MAX_SKILLS_PER_JOB)
  return `This job looks like founder work (${needs.join(', ')}). If it fits, read ${ids.join(', ')} with the skills tool before you start; the manager did not name one, so it is your judgement, and the owner's rules at the top of each read still come first.`
}

const RULES_HEADING = /^##\s+(?:Rules|Guardrails|What not to do)\s*$/i
export function skillRules(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: { heading: string; body: string }[] = []
  for (let at = 0; at < lines.length; at++) {
    if (!RULES_HEADING.test(lines[at]!)) continue
    const end = lines.findIndex((line, i) => i > at && /^##\s/.test(line))
    const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
    if (body) sections.push({ heading: lines[at]!.trim(), body })
  }
  if (!sections.length) return undefined
  const all = sections.length === 1 ? sections[0]!.body : sections.map(s => `${s.heading}\n${s.body}`).join('\n\n')
  return all.slice(0, 2000)
}

const GUIDANCE_HEADING = /^##\s+.*\b(?:rules?|guardrails|guidelines?|guidance|principles|checklist|anti-?patterns?|restraint|before deliver\w*|what not to do)\b/i
const GUIDANCE_CAP = 3000
export function skillGuidance(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const rules: { heading: string; body: string }[] = []
  const guide: { heading: string; body: string }[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    if (!/^##\s/.test(line)) continue
    const rule = RULES_HEADING.test(line)
    if (!rule && !GUIDANCE_HEADING.test(line)) continue
    const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l))
    const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
    if (body) (rule ? rules : guide).push({ heading: line.trim(), body })
  }
  if (!guide.length) return skillRules(text)
  const all = [...rules, ...guide]
  const per = Math.floor((GUIDANCE_CAP - (all.length - 1) * 2) / all.length)
  return all.map(s => {
    const room = Math.max(0, per - s.heading.length - 1)
    return `${s.heading}\n${s.body.length > room ? `${s.body.slice(0, Math.max(0, room - 1))}…` : s.body}`
  }).join('\n\n').slice(0, GUIDANCE_CAP)
}

export function wordLimitOf(text: string): number | undefined {
  const m = /\b(?:total|whole) output (?:under|below) ([\d,]+) words/i.exec(text)
  const n = m ? Number(m[1]!.replace(/,/g, '')) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function founderReads(text: string): string[] {
  const line = /^- Reads:(.*)$/m.exec(text)?.[1] ?? ''
  return [...line.matchAll(/`(founder\/[A-Za-z0-9._-]+\.md)`/g)].map(m => m[1]!)
}

export function skillRef(skill: { id: string; sha256: string }): string {
  return `${skill.id}@${skill.sha256.slice(0, 12)}`
}

export function skillsToReadFirst(skills: { id: string; sha256: string }[] | undefined): string {
  if (!skills?.length) return ''
  const founder = skills.filter(s => s.id.startsWith('founder:'))
  return [
    `SKILLS TO READ FIRST: ${skills.map(skillRef).join(', ')}. Read each with the skills tool (action "read" and its id) before you start, and follow it under the owner's rules at the top of each read, which come first. A step it asks for that needs a tool you do not have is skipped and named in your report. If a read says the skill changed since this job named it, do not look for another copy; do the job from the brief and say so.`,
    ...(skills.some(s => s.id === SCREEN_SKILL) ? [SCREEN_SEVERITY] : []),
    ...(founder.length ? [`A founder skill keeps its notes in founder/: save your output to ${founder.map(s => `founder/${s.id.slice('founder:'.length)}.md`).join(', ')}, and add any new fact the owner stated (never your estimates) to founder/facts.md; both are in your writes. Where the skill says to ask the founder and stop, put your questions at the top of your report and stop: the manager puts them on his list.`] : [])
  ].join('\n')
}

export const FOUNDER_REVIEW_CRITERIA = [
  'No customer testimonial is written as a real quote. Testimonial slots are bracketed placeholders, or described as something to collect later.',
  'No usage, result, revenue or customer number is stated as a fact about the owner\'s company unless it is in the fact ledger or the job\'s brief. Bracketed placeholders and clearly hypothetical examples are fine.',
  'A company, product or competitor that could not be found is written as "Not found", with no price, funding, founding date, customer count or feature given for it.',
  'Every outside fact (a competitor, a price, a funding round, a market size, a benchmark) has a source link beside it, or is marked "Estimate:" with the arithmetic shown, or "Not found".',
  'Where the skill needed the owner\'s input and it was missing, the report asks for it instead of presenting invented content.'
]
