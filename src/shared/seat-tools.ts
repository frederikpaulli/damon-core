// The tool list for each seat (manager, worker, reviewer, read-only).
import { COPY_TOOLS, NATIVE_WEB_TOOLS, PROGRAM_TOOL_NAMES } from './native-tools'

export interface SeatWiring {
  skills: boolean; browser: boolean; renderPage: boolean; lookAtScreens: boolean
  requestConnection: boolean; coordination: boolean
  checks: boolean
  ownerSaid: boolean
  schedules: boolean; automations: boolean
  pictures: boolean
  managerLeads: boolean
  checkpoints: boolean
}
const PRODUCTION: SeatWiring = { skills: true, browser: true, renderPage: true, lookAtScreens: true, requestConnection: true, coordination: true, checks: false, ownerSaid: true, schedules: true, automations: true, pictures: true, managerLeads: true, checkpoints: true }

export interface SeatShape {
  seat: 'coordinator' | 'worker'
  provider: 'claude' | 'openai'
  capabilities: readonly string[]
  root?: boolean
  readOnly?: boolean
  reviewing?: boolean
  reviewer?: boolean
  critic?: boolean
  copy?: boolean
  draftReads?: boolean
  noScreens?: boolean
  filling?: boolean
  sending?: boolean
  wired?: Partial<SeatWiring>
}
export interface SeatTools { broker: string[]; native: string[]; all: ReadonlySet<string> }

export const FORM_TOOLS = ['form_open', 'form_fields', 'form_fill', 'form_options', 'form_attach', 'form_press', 'form_screenshot'] as const
export const SEND_TOOLS = ['thread_open', 'thread_type', 'thread_send', 'thread_screenshot'] as const
export const REVIEW_TOOLS = ['compare_to_project', 'list_review_files', 'read_review_file', 'submit_review'] as const
const PLANNING = ['list_deliverables', 'record_deliverable', 'retire_need', 'retire_deliverable', 'supply_need']
const TEAM_PLAN = ['write_brain', 'propose_project_check', 'read_brain', 'get_task', 'list_team', 'propose_team']
const TASK_ASSIGN = ['project_coverage', 'assign_work', 'request_revision', 'drop_task', 'amend_task']
const OWNER_LIST = ['hand_to_owner', 'close_owner_question', 'record_cut_line', 'list_cut_lines', 'remove_cut_line']
const SIGN_OFF = ['approve_task', 'review_deliverable', 'cancel_review']
const DRAFTS = ['candidates_for_task', 'read_draft_file', 'run_workflow_critique']

export const PROTECTED_BROKER_TOOLS: readonly string[] = [...new Set([
  ...PLANNING, 'record_owner_choice', 'request_connection', ...TEAM_PLAN, ...TASK_ASSIGN, ...OWNER_LIST, ...SIGN_OFF, ...DRAFTS,
  ...REVIEW_TOOLS, ...FORM_TOOLS, ...SEND_TOOLS, 'read_in_full', 'skills', 'scoreboard', 'browse_page', 'project_overview',
  'look_at_my_page', 'look_at_screens', 'run_project_check',
  'read_project_file', 'view_picture', 'run_isolated', 'web_fetch', 'web_search',
  'add_automation', 'list_automations', 'find_automation', 'read_automation', 'save_checkpoint', 'small_fix', 'propose_fact'
])]

export const LEAD_HAS_NO_SEAT = 'A group lead has no seat on this route: only the manager coordinates, and everyone else is a worker. Give the work to the people directly.'


export function seatTools(shape: SeatShape): SeatTools {
  const caps = new Set(shape.capabilities), has = (c: string): boolean => caps.has(c)
  const w: SeatWiring = { ...PRODUCTION, ...shape.wired }
  const broker: string[] = [], native: string[] = []
  const out = (): SeatTools => ({ broker, native, all: new Set([...broker, ...native]) })
  if (shape.filling) { if (has('browser.fill')) broker.push(...FORM_TOOLS); return out() }
  if (shape.sending) { if (has('browser.send')) broker.push(...SEND_TOOLS); return out() }
  if (shape.seat === 'coordinator' && !shape.root) return out()
  const coordinator = shape.seat === 'coordinator', root = coordinator && !!shape.root
  const copy = !!shape.copy && shape.provider === 'claude'
  if (root && has('planning.write')) broker.push(...PLANNING, ...(w.ownerSaid ? ['record_owner_choice'] : []), ...(w.requestConnection ? ['request_connection'] : []))
  if (root && w.coordination) {
    if (has('team.plan')) broker.push(...TEAM_PLAN)
    if (has('team.plan') && w.schedules) broker.push('add_automation', 'list_automations')
    if (has('task.assign')) broker.push(...TASK_ASSIGN)
    if (has('planning.write')) broker.push(...OWNER_LIST)
    if (has('task.assign') && has('candidate.review')) broker.push(...SIGN_OFF)
    if (has('candidate.review')) broker.push(...DRAFTS)
    if (has('candidate.review')) broker.push('propose_fact')
    if (has('candidate.apply')) broker.push('small_fix')
  }
  if (shape.reviewing && has('candidate.review')) broker.push(...REVIEW_TOOLS)
  if (!coordinator && shape.reviewer && !shape.critic && !shape.reviewing && shape.draftReads) broker.push('read_draft_file')
  if (coordinator) broker.push('read_in_full')
  if (w.skills) broker.push('skills')
  if (w.automations && (root || (!coordinator && !shape.readOnly))) broker.push('find_automation', 'read_automation')
  if (coordinator) broker.push('scoreboard')
  if (has('browser.read') && w.browser) broker.push('browse_page')
  if (has('overview.read')) broker.push('project_overview')
  if ((!coordinator || root) && w.renderPage) broker.push('look_at_my_page')
  if (!coordinator && copy && w.lookAtScreens && !shape.noScreens) broker.push('look_at_screens')
  if (!coordinator && copy && !shape.reviewing && !shape.readOnly && w.checkpoints) broker.push('save_checkpoint')
  if (!coordinator && (shape.reviewing || shape.reviewer || (copy && !shape.readOnly)) && w.checks) broker.push('run_project_check')
  if (has('files.read')) broker.push('read_project_file')
  if (has('files.read') && w.pictures) broker.push('view_picture')
  if (has('worker.run') && !copy) broker.push('run_isolated')
  if (shape.provider === 'openai' && has('web.read') && !shape.critic) {
    broker.push('web_fetch', 'web_search')
  }
  if (shape.provider === 'claude' && !shape.critic) {
    if (copy) native.push(...COPY_TOOLS)
    if (has('web.read')) native.push(...NATIVE_WEB_TOOLS)
  }
  return out()
}

const UNAMBIGUOUS = ['WebFetch', 'WebSearch', 'MultiEdit', 'TodoWrite', 'NotebookEdit', 'Bash', 'Glob', 'Grep']
const AMBIGUOUS = ['Read', 'Write', 'Edit', 'Skill', 'Task']
export function toolNamesIn(text: string, parameters: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  const prefixed = /\bmcp__[A-Za-z0-9_]+/g
  for (const m of text.matchAll(prefixed)) out.add(m[0].replace(/^mcp__damon_broker__/, ''))
  for (const m of text.replace(prefixed, ' ').matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) if (!parameters.has(m[0])) out.add(m[0])
  const unambiguous = new RegExp(`\\b(?:${UNAMBIGUOUS.join('|')})\\b`)
  for (const name of UNAMBIGUOUS) if (new RegExp(`\\b${name}\\b`).test(text)) out.add(name)
  for (const name of AMBIGUOUS) {
    if (new RegExp(`\\b${name}\\s+(?:tool|tools|call|calls)\\b`).test(text)) out.add(name)
    for (const group of text.matchAll(/\(([^()]{0,240})\)/g)) if (new RegExp(`\\b${name}\\b`).test(group[1]!) && unambiguous.test(group[1]!)) out.add(name)
  }
  for (const name of ['skills', 'scoreboard']) if (new RegExp(`\\b${name} tool\\b`).test(text)) out.add(name)
  return [...out].sort()
}

export function untrueToolNames(text: string, tools: ReadonlySet<string>, parameters: ReadonlySet<string>, mayName: readonly string[] = []): string[] {
  return toolNamesIn(text, parameters).filter(name => !tools.has(name) && !mayName.includes(name))
}

const KNOWN_TOOLS: ReadonlySet<string> = new Set([...PROTECTED_BROKER_TOOLS, ...PROGRAM_TOOL_NAMES])
export function briefToolsMissing(text: string, tools: ReadonlySet<string>): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  const asTool = (name: string, s: string): boolean => {
    const verbs = /^[A-Z]/.test(name) ? 'use|call|via|through|using|with' : 'use|call|run|via|through|using|with'
    const re = new RegExp('\\b(?:' + verbs + ')\\s+(?:the\\s+)?\\`?' + name + '\\b(?!\\s+(?:script|scripts|file|files|command|commands|output|binary)\\b)', 'gi')
    for (const m of s.matchAll(re)) {
      const before = s.slice(0, m.index), clause = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(':')) + 1)
      if (!/\b(?:don't|dont|do not|never|avoid|not|instead of)\b/i.test(clause)) return true
    }
    return false
  }
  return toolNamesIn(text, new Set()).filter(name => KNOWN_TOOLS.has(name) && !tools.has(name) && sentences.some(s =>
    s.includes(name) && !/\b(reviewer|critic|Damon)\b/i.test(s) && asTool(name, s)))
}
