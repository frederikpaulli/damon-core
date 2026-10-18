// Broker tools for the manager on the protected route: assign work, approve or send back,
// hand to the owner, close questions. Each is checked against the seat's capabilities.
import { z } from 'zod'
import { WRITE_BRAIN_DESCRIPTION, writeBrainInput, type WriteBrainInput } from './brain-tool'
import { schemaWords } from '../../shared/schema-words'
import { BrokerRefusal, type BrokerTool } from './scoped-tool-broker'
import { describeRoute } from '../../shared/gate-route'
import type { ExecutionPolicyRecord } from '../../shared/execution-policy'
import type { TaskInfo } from '../../shared/types'
import type { TeamPlanNode } from './team-plan-store'
import { taskOperationId, type TaskOperationOutcome } from '../../shared/task-operations'
import { TaskOperationStore, payloadFingerprint } from './task-operations'
import { admitTask, type TaskAdmissionRules } from './task-admission'
import { requireReviewedText } from './protected-context'
import { assignmentSchema } from '../../shared/assignment'
import { validateNativeTaskScope } from './protected-task-scope'
import { draftFilesLeftOut } from '../../shared/step-up'
import { afterDropSentence, matchesScope, openOnSameFiles, scopeIsMeaningless, unlandedSentence } from '../../shared/scope'
import { heldByCheck, REVIEW_HELD } from '../../shared/verification'
import { approvedGrant, checkApprovedInput } from './execution-policy'
import { workerPath } from './isolated-worker'
import { MAX_SKILLS_PER_JOB, SCREEN_SKILL, TRIGGERS, founderReads, skillRef } from '../../shared/skill-policy'
import { DESIGN_SKILLS } from '../../shared/visual-review'
import { screenSkillJob } from '../../shared/screen-job'
import { LEAD_HAS_NO_SEAT, briefToolsMissing, seatTools } from '../../shared/seat-tools'
import { providerForModel } from '../../shared/models'
import { moduleDeclarationRefusal, quoteOutputRefusal } from '../../shared/assign-contradictions'
import { describeRepeat, type Repeat, type Schedule } from '../../shared/schedule'
import { screenStageRefusal, stageCriteria } from '../../shared/screens-first'
import { DEFAULT_FEATURE_SESSIONS } from '../../shared/feature-job'
import type { LeanSwitch } from '../../shared/lean'
import { ownerMoment } from '../../shared/owner-moment'
import { CutLinesStore } from './cut-lines-store'

export interface SkillLookup {
  find(id: string): { id: string; name: string; source: string; needs: string[]; sha256: string; on: boolean; off?: string } | undefined
  skillText(id: string): string | undefined
  treeOf?(id: string): string | undefined
  jobFilesOf?(id: string): { reads: readonly string[]; writes: readonly string[] } | undefined
}

const outcomeOf = (task: TaskInfo): TaskOperationOutcome => ({ taskId: task.id, agentId: task.agentId, title: task.title.slice(0, 1000), status: task.status })

const ROSTER_LIMIT = 60
const TASK_LIMIT = 40

export interface ProtectedCoordinationAccess {
  rules: TaskAdmissionRules
  roster(): { id: string; name: string; role?: string; kind?: string; parentId?: string; model: string }[]
  tasks(): TaskInfo[]
  findByOperation(operationId: string): TaskInfo | undefined
  assign(input: {
    operationId: string; agentId: string; title: string; label: string; instructions: string; acceptance: string
    writes: string[]; waitsFor?: string[]; connections?: string[]
    deliverableIds?: string[]; finalizes?: boolean; reads?: string[]; intent?: TaskInfo['intent']; assignment?: TaskInfo['assignment']; route?: TaskInfo['route']
    brain?: string; steppedUpFrom?: string; fixes?: string
    narrowedBecause?: string
    continuesFrom?: string
    skills?: { id: string; sha256: string; tree?: string }[]
    stage?: 'screen' | 'wire'
    piece?: string
    feature?: TaskInfo['feature']
    lane?: TaskInfo['lane']
  }): { error: string } | TaskInfo
  lookConfig?(): import('../../shared/look-config').LookConfig | null
  codeContext?(): import('../../shared/change-class').CodeContext
  stepUp?(fromTaskId: string, agentId: string): { brain: string } | { error: string }
  proposeTeam?(input: { map: string; plan: (Omit<TeamPlanNode, 'model'> & { model?: string })[]; standards: string[]; whyWholeTeam?: string }): { error: string } | { planId: string; count: number }
  requestRevision?(taskId: string, feedback: string, addReads?: string[]): { error: string } | TaskInfo
  projectFile?(path: string): boolean
  projectText?(path: string): string | null
  checksAllowed?(): boolean
  continued?(taskId: string): { title: string; writes: string[]; draftFiles: string[] } | null
  approveTask?(taskId: string, despite?: string, knownFault?: boolean): { error: string } | TaskInfo
  cancelReview?(taskId: string, then: 'drop' | 'back' | 'approve', ownerWords: string): { error: string } | { title: string; status: string }
  ownerSaid?(quote: string): boolean
  say?(text: string): void
  landsApprovedDraft?(fromTaskId: string, job: { writes: string[]; deliverableIds?: string[] }): boolean
  handToOwner?(input: z.infer<typeof handoffInput>): string
  closeOwnerQuestion?(id: string, answer: string, replacedBy?: string, moot?: boolean, notNeeded?: boolean): string
  dropTask?(taskId: string, why: string): { error: string } | { title: string; status: string; unlanded?: string[] }
  amend?(taskId: string, change: { waitFor?: string[]; replacePrerequisite?: { producerId: string; files: string[]; reason: string }; addReads?: string[]; fixes?: string; criteria?: { id: string; text?: string }[]; resumeWhy?: string }): { error: string } | TaskInfo
  reviewDeliverable?(id: string): Promise<string>
  candidates?(taskId: string): {
    taskId: string
    drafts: { candidateId: string; at: string; files: { path: string; status: string }[]; reviews: { reviewerId: string; verdict: string; usable: boolean; issues: string[]; summary: string }[]; applied: 'yes' | 'no' | 'partly' }[]
    note: string
  }
  critique?(id?: string): string
  readDraft?(candidateId: string, path: string, from?: number): { candidateId: string; path: string; status: string; content?: string; from?: number; totalChars?: number; nextFrom?: number; issues: string[] }
  coverage?: { schemas(): unknown; list(): unknown; record(input: unknown): unknown }
  brainWrite?(input: WriteBrainInput): string
  brainRead?(section?: 'map' | 'decisions' | 'glossary'): string
  proposeCheck?(input: { name: string; command: string; timeout_sec: number; why: string }): string
  schedules?(): { list(): Schedule[]; add(text: string, repeat: Repeat): Schedule }
}

const handoffInput = z.object({
  title: z.string().trim().min(1).max(120), what: z.string().trim().min(1).max(1200),
  kind: z.enum(['decide', 'check', 'send', 'submit', 'login']),
  taskId: z.string().min(1).max(200).optional(),
  file: z.string().min(1).max(500).optional(), files: z.array(z.string().min(1).max(500)).max(100).optional(),
  url: z.string().url().max(2000).optional(), text: z.string().max(20000).optional(),
  to: z.object({ name: z.string().min(1).max(200), contact: z.string().max(2000).optional() }).strict().optional(),
  sendBack: z.string().max(4000).optional(), opens: z.enum(['accounts', 'connections', 'chat']).optional()
}).strict()

const coverageAction = z.object({
  action: z.enum(['schemas', 'list', 'record']),
  input: z.record(z.string(), z.unknown()).optional()
}).strict()

const revisionInput = z.object({
  task_id: z.string().min(1).max(200),
  feedback: z.string().min(1).max(8000).describe('Concrete, actionable points the worker will redo the job against. It is kept as a lesson for that worker, so say what is wrong and what would be right.'),
  add_reads: z.array(z.string().min(1).max(500)).max(20).optional().describe('Project files the worker could not open last round and needs this round, exact project-relative paths. Widening only; nothing is removed.')
}).strict()

const proposeInput = z.object({
  map: z.string().min(1).max(20000).describe('The written breakdown of the work the team size follows from.'),
  why_whole_team: z.string().max(2000).optional().describe('Required when this project already has a team: one line saying why the WHOLE chart must be rebuilt.'),
  plan: z.array(z.object({
    name: z.string().min(1).max(120),
    role: z.string().min(1).max(4000).describe('The full brief: what this person covers, and why they earn a place.'),
    label: z.string().min(1).max(200).describe('A few plain words for the owner to read on the chart.'),
    model: z.string().min(1).max(100).optional().describe('Leave it out for the brain the owner chose for that seat.'),
    modelWhy: z.string().max(500).optional(),
    kind: z.enum(['agent', 'submanager']),
    parent: z.string().min(1).max(120).optional()
  }).strict()).min(1).max(12),
  standards: z.array(z.string().min(1).max(2000)).min(1).max(40).describe('What EVERY job on this project must meet, one per entry, in the owner\'s plain words. Approved once, with the chart.')
}).strict()

const assignInput = z.object({
  operation_id: taskOperationId.describe('A fresh UUID you mint for THIS assignment. Send the identical call with the identical id to retry safely after a lost reply: you get the original receipt back, not a second job.'),
  agent_id: z.string().min(1).max(200),
  title: z.string().min(1).max(1000),
  label: z.string().min(1).max(200).describe('A few plain words for the owner to read in a list.'),
  instructions: z.string().min(1).max(20000),
  acceptance_criteria: z.array(z.string().min(1).max(2000)).min(1).max(40).describe('Only what is specific to THIS job. The owner’s approved standards are attached by Damon and may not be reworded.'),
  writes: z.array(z.string().min(1).max(500)).min(1).max(60).describe('The smallest areas this job may change. "**" is refused.'),
  reads: z.array(z.string().min(1).max(500)).max(100).describe('Exact project-relative input files. Use [] if there are none.'),
  deliverable_ids: z.array(z.string().min(1).max(100)).max(30).optional().describe('Required for a large job (more than one output file, or full-depth stakes). A one-file job may leave it out.'),
  finalizes_deliverables: z.boolean().optional(),
  waits_for: z.array(z.string().min(1).max(200)).max(40).optional(),
  fixes: z.string().min(1).max(200).optional().describe('The id of a kept job with a known fault that this job fixes, or of a job in review its reviewer refused, before you approve that one with known_fault. The original fault becomes one of its criteria, and its reviewer checks it; a fix for a job not yet approved waits for it.'),
  step_up_from: z.string().min(1).max(200).optional().describe('The id of a job by the same person that hit the revision cap. This job then runs one brain above theirs (within the owner’s ceiling). Once per job; the owner sees it in the chat.'),
  continues_from: z.string().min(1).max(200).optional().describe('The id of a job, live, closed or dropped, whose draft this job continues: its latest draft is laid over this job\'s copy and its last send-back goes into the brief. For a job given again after a drop; a step-up continues on its own. It must share a file with this job\'s writes.'),
  narrow_writes: z.string().min(10).max(1000).optional().describe('Only with continues_from or step_up_from: why this job may leave out files of the earlier job\'s draft. Without it, writes must cover every file of that draft, or nothing is assigned.'),
  connections: z.array(z.string().min(1).max(120)).max(30).optional().describe('Not used on this route yet: the owner\'s connections do not reach the team. Leave it out.'),
  intent: z.object({
    outcome: z.string().min(1).max(4000),
    assumptions: z.array(z.string().max(2000)).max(30),
    scenarios: z.array(z.object({ id: z.string().min(1).max(80), when: z.string().min(1).max(2000), expected: z.string().min(1).max(2000), check: z.string().min(1).max(2000) })).min(1).max(30)
  }).optional(),
  assignment: assignmentSchema.optional().describe('Bounded responsibility for this one job: responsibility (coordinate | research | produce | operate | review), specialities (may be []), reason, stopWhen, maxTurns.'),
  skills: z.array(z.string().min(1).max(200)).max(MAX_SKILLS_PER_JOB).optional().describe('Up to three skill ids from the skills tool that fit this job, for example "founder:pricing-strategy". The worker reads them first and its reviewer is told which. A founder skill adds its founder/ files to reads and writes. Leave it out for a job no skill fits.'),
  stage: z.enum(['screen', 'wire']).optional().describe('"screen": build this piece\'s screen on sample data only (screen files, damon-look.json and its sample-data script); it gets a careful look and builds no backend. "wire": connect a finished screen to the real data; it waits for its screen job. Leave it out for work with no screen.'),
  piece: z.string().min(1).max(80).optional().describe('The roadmap piece this job builds, in a few plain words; every job of one piece names it the same way.'),
  size: z.enum(['feature']).optional().describe('"feature": one person builds a whole piece (a screen, a feature) in one long run of sessions, saving checkpoints, reviewed once when finished by two reviewers side by side (code and checks; how it looks). Only on a project whose jobs work in a copy. Needs checkpoints. About 20 changed files at most.'),
  checkpoints: z.array(z.string().min(1).max(200)).min(2).max(8).optional().describe('For a feature job: its 2 to 8 steps, in the order they are built, in plain words.'),
  lane: z.enum(['small']).optional().describe('"small": a small mechanical fix. It lands with no reviewer only when the host can show in code that the change is mechanical; anything else is read by its reviewer as usual.')
}).strict()

export function protectedCoordinationTools(options: {
  projectId: string; callerId: string; stateDir: string; policy: ExecutionPolicyRecord
  access: ProtectedCoordinationAccess
  current(): void
  skills?: SkillLookup
  lean?: (key: LeanSwitch) => boolean
  screenJob?: (t: { title: string; instructions?: string; acceptance?: string; writes: readonly string[] }) => boolean
}): BrokerTool[] {
  const operations = new TaskOperationStore(options.stateDir, options.projectId)
  const guarded = (name: string, description: string, schema: z.ZodType, run: (input: any) => unknown): BrokerTool => ({ name, description, schema, execute: async (input, context) => {
    context.signal.throwIfAborted()
    if (context.projectId !== options.projectId || context.callerId !== options.callerId) throw Error('Coordination request is outside the caller scope.')
    try { options.current() } catch (e) { throw new BrokerRefusal(e instanceof Error ? e.message : String(e)) }
    let value: unknown
    try { value = schema.parse(input) } catch (e) { throw new BrokerRefusal(`The request does not have the shape this tool takes: ${schemaWords(e).slice(0, 1500)}`) }
    requireReviewedText(JSON.stringify(value))
    let result: unknown
    try { result = run(value); if (result instanceof Promise) result = await result } catch (e) { if (e instanceof BrokerRefusal) throw e; throw new BrokerRefusal(e instanceof Error ? e.message : String(e)) }
    requireReviewedText(JSON.stringify(result)); return result
  } })

  const tools: BrokerTool[] = []
  const seatOf = (agentId: string) => {
    const person = options.access.roster().find(r => r.id === agentId)
    return seatTools({ seat: 'worker', provider: person && providerForModel(person.model) === 'openai' ? 'openai' : 'claude', capabilities: options.policy.capabilities, copy: options.policy.capabilities.includes('worker.copy'), wired: { checks: options.access.checksAllowed?.() ?? false, checkpoints: options.lean?.('checkpoints') ?? true } })
  }
  if (options.policy.capabilities.includes('team.plan') && options.access.brainWrite) tools.push(guarded(
    'write_brain', WRITE_BRAIN_DESCRIPTION, writeBrainInput,
    (input: WriteBrainInput) => options.access.brainWrite!(input)
  ))
  if (options.policy.capabilities.includes('team.plan') && options.access.proposeCheck) tools.push(guarded(
    'propose_project_check',
    'Propose ONE command that proves this project works (for example "npm test" or "cargo test --release"), so reviewers and Damon\'s final check can run it in a throwaway copy of the project. It is allowed at once (the owner has said reviewers may run tests without asking him) and never runs in his real folder. Propose one for every project that has tests, as soon as you know the command. Give it a short name, the exact command line, a time limit in seconds (10 to 900) and one sentence on what it proves.',
    z.object({ name: z.string().trim().min(1).max(40), command: z.string().trim().min(1).max(300), timeout_sec: z.number().int().min(10).max(900), why: z.string().trim().min(1).max(400) }).strict(),
    (input: { name: string; command: string; timeout_sec: number; why: string }) => options.access.proposeCheck!(input)
  ))
  if (options.policy.capabilities.includes('team.plan') && options.access.schedules) {
    tools.push(guarded(
      'add_automation',
      'Set up work that should happen again and again on a clock, without anyone asking. Use it the moment the owner says something should happen regularly ("every morning", "each Friday", "keep an eye on"). Never promise to remember it yourself: you do not run between turns, and this does while Damon is open.',
      z.object({ what: z.string().trim().min(1).max(2000), every: z.enum(['day', 'week', 'hours']), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional().describe('For day or week: 24-hour clock in the owner\'s timezone, for example "08:00".'), weekday: z.number().int().min(0).max(6).optional(), every_hours: z.number().int().min(1).max(24).optional() }).strict(),
      (input: { what: string; every: 'day' | 'week' | 'hours'; time?: string; weekday?: number; every_hours?: number }) => {
        const repeat: Repeat = input.every === 'hours' ? { kind: 'hours', everyHours: input.every_hours ?? 6 } : input.every === 'week' ? { kind: 'weekly', time: input.time ?? '09:00', weekday: input.weekday ?? 1 } : { kind: 'daily', time: input.time ?? '09:00' }
        const saved = options.access.schedules!().add(input.what, repeat)
        return `Set up: "${saved.text}". ${describeRepeat(saved.repeat)}, starting ${ownerMoment(saved.nextAt)}. It shows in the owner's Fleet tab under Automations, where he can pause or remove it. Tell him in one plain sentence that it is set up and when it first runs.`
      }
    ))
    tools.push(guarded(
      'list_automations',
      'What this project already does on a clock. Check before adding one, so the same thing is not set up twice.',
      z.object({}).strict(),
      () => options.access.schedules!().list().map(s => ({ id: s.id, what: s.text, when: describeRepeat(s.repeat), next: ownerMoment(s.nextAt), paused: Boolean(s.paused) }))
    ))
  }
  if (options.policy.capabilities.includes('team.plan') && options.access.brainRead) tools.push(guarded(
    'read_brain',
    'The shared project brain in full: the map, the current decisions and the glossary, or one section. A record; this changes nothing.',
    z.object({ section: z.enum(['map', 'decisions', 'glossary']).optional() }).strict(),
    (input: { section?: 'map' | 'decisions' | 'glossary' }) => options.access.brainRead!(input.section)
  ))
  if (options.policy.capabilities.includes('team.plan')) tools.push(guarded(
    'get_task',
    'The status, round, review verdict, feedback and latest report of one job on this project. A record, not approval or verified output. This changes nothing.',
    z.object({ task_id: z.string().min(1).max(200) }).strict(),
    input => {
      const task = options.access.tasks().find(t => t.id === input.task_id)
      if (!task) throw Error('That task does not belong to this project.')
      return {
        id: task.id, agentId: task.agentId, title: task.title, label: task.label, status: task.status, round: task.round,
        waitsFor: task.needs ?? [], reads: task.reads ?? [], writes: task.writes ?? [],
        review: task.review ? { satisfied: task.review.satisfied, rounds: task.review.rounds, disputed: Boolean(task.review.disputed), why: String(task.review.why ?? '').slice(0, 4000), objection: task.review.objection ? String(task.review.objection).slice(0, 2000) : null } : null,
        feedback: (task.feedback ?? []).slice(-3).map(f => String(typeof f === 'string' ? f : (f as { text?: string }).text ?? '').slice(0, 2000)),
        result: String(task.result ?? '').slice(0, 6000),
        damonCheck: task.verification?.findings?.length ? { findings: task.verification.findings.map(f => f.text), overruled: task.verification.overruledWhy ?? null } : null,
        notes: task.processNotes ?? [],
        escalation: task.escalation ?? null, waitingFor: heldByCheck(task) ? REVIEW_HELD : task.waitingFor ?? null
      }
    }
  ))
  if (options.policy.capabilities.includes('team.plan')) tools.push(guarded(
    'list_team',
    'Read the team the owner already approved and the work it currently holds. These are records, not approval, progress or verified output. This creates nobody and changes nothing.',
    z.object({}).strict(),
    () => {
      const roster = options.access.roster(), tasks = options.access.tasks()
      const open = tasks.filter(task => !['approved', 'failed'].includes(task.status))
      return {
        team: roster.slice(0, ROSTER_LIMIT).map(({ id, name, role, kind, parentId, model }) => ({ id, name, role, kind, parentId, model })),
        teamOmitted: Math.max(0, roster.length - ROSTER_LIMIT),
        work: open.slice(0, TASK_LIMIT).map(task => ({ id: task.id, agentId: task.agentId, title: task.title, status: task.status, round: task.round, waitsFor: task.needs ?? [], ...(heldByCheck(task) ? { reviewHeldForYou: true } : {}) })),
        workOmitted: Math.max(0, open.length - TASK_LIMIT),
        finished: tasks.length - open.length,
        note: 'Omitted entries exist and are not visible here. A status is what the engine recorded, not an independent review.'
      }
    }
  ))

  if (options.policy.capabilities.includes('team.plan') && options.access.proposeTeam) tools.push(guarded(
    'propose_team',
    'Show the owner the team you want to build, and WAIT. This creates nobody: it puts the org chart in front of the owner, who approves it, asks for bigger or smaller, or writes their own. Do not call assign_work for anyone until list_team shows them. Nothing here is progress or approval.',
    proposeInput,
    input => {
      const value = input as z.infer<typeof proposeInput>
      if (value.plan.some(person => person.kind === 'submanager')) throw Error('Nothing was proposed. A team on this route has no group leads: a lead would have no tools to lead with. Put everyone on the chart as kind "agent", reporting to you.')
      const result = options.access.proposeTeam!({ map: value.map, plan: value.plan, standards: value.standards, ...(value.why_whole_team ? { whyWholeTeam: value.why_whole_team } : {}) })
      if ('error' in result) throw Error(result.error)
      return { ...result, note: 'Recorded as a proposal. It creates nobody and waits for the owner; list_team will show the people once they have decided.' }
    }
  ))

  if (options.policy.capabilities.includes('task.assign') && options.access.coverage) tools.push(guarded(
    'project_coverage',
    'Establish what this project needs before final work is assigned: use action "schemas" to read the record shape, "list" to see current coverage, then "record" with an exact owner quote, all eight concern areas and current evidence. A concern is not an agent. assign_work refuses final work whose outputs have no coverage, so record it first and reuse it for small changes.',
    coverageAction,
    value => {
      const cov = options.access.coverage!
      if (value.action === 'schemas') return cov.schemas()
      if (value.action === 'list') return cov.list()
      return cov.record(value.input ?? {})
    }
  ))
  if (options.policy.capabilities.includes('task.assign')) tools.push(guarded(
    'assign_work',
    'Assign one job to a person already on the approved team. Returns as soon as the job is durably created; you are not waiting for it to finish. Retry with the SAME operation_id and the same arguments after a lost reply and you get the original receipt, never a second job.',
    assignInput,
    raw => {
      const value = { ...(raw as z.infer<typeof assignInput>), writes: (raw as z.infer<typeof assignInput>).writes.map(area => /^[^*]+\/$/.test(area) ? area + '**' : area) }
      if (options.access.roster().find(person => person.id === value.agent_id)?.kind === 'submanager') throw Error(LEAD_HAS_NO_SEAT)
      const inACopy = options.policy.capabilities.includes('worker.copy')
      if (inACopy && options.access.projectFile) value.reads = value.reads.filter(path => options.access.projectFile!(path))
      if (inACopy) {
        const person = options.access.roster().find(r => r.id === value.agent_id)
        if (person && /^(openai|gpt|gemini)/i.test(person.model)) throw Error(`Nothing was assigned: on this project a job works in a throwaway copy of the folder, and that runs on a Claude brain for now. ${person.name} thinks with ${person.model}. Give the job to a teammate on a Claude brain, or change ${person.name}'s brain first.`)
      }
      let named: { id: string; sha256: string; tree?: string }[] | undefined
      const asked = [...new Set((value.skills ?? []).map(s => s.trim()))]
      const screenJob = (options.screenJob ?? screenSkillJob)({ title: value.title, instructions: value.instructions, acceptance: (value.acceptance_criteria ?? []).join('\n'), writes: value.writes })
      const screenSkill = screenJob ? options.skills?.find(SCREEN_SKILL) : undefined
      const wantScreen = !!screenSkill?.on && !asked.includes(SCREEN_SKILL)
      let swapped: string | undefined
      let leftOut: string | undefined
      if (wantScreen && asked.length >= MAX_SKILLS_PER_JOB) {
        const family = new Set<string>([...TRIGGERS.design, ...DESIGN_SKILLS])
        const design = asked.map((id, i) => (family.has(id) ? i : -1)).filter(i => i >= 0).pop()
        const last = asked.length - 1
        if (design !== undefined) swapped = asked.splice(design, 1)[0]
        else if (/^(?:founder|document-skills):/.test(asked[last]!)) leftOut = asked[last]
        else swapped = asked.splice(last, 1)[0]
      }
      const addScreen = wantScreen && !leftOut
      const ids = addScreen ? [...asked, SCREEN_SKILL] : asked
      if (ids.length) {
        if (!options.skills) throw Error('Nothing was assigned: the team\'s skills are not available on this route, so a job cannot name one. Leave skills out.')
        named = []
        for (const id of ids) {
          const entry = options.skills.find(id)
          if (!entry) throw Error(`Nothing was assigned: there is no skill "${id}" on this computer. skills list shows what there is.`)
          if (!entry.on) throw Error(`Nothing was assigned: the skill ${id} is off. ${entry.off ?? ''}`.trim())
          const tree = options.skills.treeOf?.(id)
          named.push({ id, sha256: entry.sha256, ...(tree ? { tree } : {}) })
          const own = options.skills.jobFilesOf?.(id)
          if (own) {
            value.reads = [...value.reads, ...own.reads.filter(path => !value.reads.includes(path) && !!options.access.projectFile?.(path))]
            value.writes = [...value.writes, ...own.writes.filter(path => !matchesScope(value.writes, path))]
          }
          if (entry.source !== 'founder') continue
          const reads = founderReads(options.skills.skillText(id) ?? '').filter(path => !value.reads.includes(path) && !!options.access.projectFile?.(path))
          const writes = [`founder/${entry.name}.md`, 'founder/facts.md'].filter(path => !matchesScope(value.writes, path))
          value.reads = [...value.reads, ...reads]
          value.writes = [...value.writes, ...writes]
        }
      }
      if (value.narrow_writes && !value.continues_from && !value.step_up_from) throw Error('Nothing was assigned: narrow_writes is only for a job that continues another (continues_from or step_up_from). Leave it out.')
      const engineWidens = value.fixes ? ((options.access.tasks().find(t => t.id === value.fixes)?.knownFault?.heldFiles ?? []) as string[]).filter(p => !matchesScope(value.writes, p)) : []
      if (value.stage && (options.lean?.('screensFirst') ?? true)) {
        const look = options.access.lookConfig?.() ?? null
        if (value.stage === 'screen') {
          const refusal = screenStageRefusal(value.writes, options.access.codeContext?.() ?? {}, look)
          if (refusal) throw Error(refusal)
        }
        if (value.stage === 'wire' && !value.waits_for?.length) throw Error('Nothing was assigned: A wire stage waits for its screen stage: name that job in waits_for.')
        value.acceptance_criteria = stageCriteria(value.stage, value.acceptance_criteria, look)
      }
      if (value.size === 'feature' && !(options.lean?.('featureJobs') ?? true)) throw Error('Nothing was assigned: feature jobs are switched off. Give the work as ordinary jobs.')
      if (value.size === 'feature') {
        if (!inACopy) throw Error('Nothing was assigned: A feature job works in a copy, and this project\'s jobs do not. Give the work as ordinary jobs.')
        if (!value.checkpoints?.length) throw Error('Nothing was assigned: a feature job needs checkpoints: its 2 to 8 steps in order.')
        if (value.fixes) throw Error('Nothing was assigned: A fix is an ordinary job, never a feature job.')
        if (!(options.lean?.('checkpoints') ?? true)) throw Error('Nothing was assigned: feature jobs need checkpoints, which are switched off. Give the work as ordinary jobs.')
      }
      if (!scopeIsMeaningless(value.writes)) try {
        const brainReads = value.reads.filter(path => /^brain\//i.test(path.trim()))
        if (brainReads.length) throw Error(`Nothing was assigned: ${brainReads.join(', ')} is not a project file. The brain's decisions, facts and map are handed to every worker in its brief automatically; leave them out of reads and do not copy them into the instructions.`)
        const text = `${value.instructions}\n${(value.acceptance_criteria ?? []).join('\n')}`
        const named = [...new Set([...text.matchAll(/(?:^|[\s"'`(\[])((?:[\w][\w .-]*\/)+[\w][\w .-]*\.(?:md|json|txt|html?|pdf|csv|ya?ml|docx|xlsx))(?=[\s"'`)\],.;:]|$)/g)].map(m => m[1]!.trim()))]
        const unreadable = inACopy ? [] : named.filter(path => options.access.projectFile?.(path) && !value.reads.includes(path) && !matchesScope(value.writes, path))
        if (unreadable.length) throw Error(`Nothing was assigned: the brief names ${unreadable.join(', ')}, which exist in the project, but reads does not include them and writes does not cover them, so the worker could not open them. Add them to reads, or leave them out of the brief.`)
        validateNativeTaskScope({ taskId: 'pending', reads: value.reads, writes: value.writes, readOnly: false, definitionSha256: '0'.repeat(64) })
      } catch (e) {
        throw Error(`Nothing was assigned: the write or read paths would be refused when the worker starts. ${e instanceof Error ? e.message : String(e)} Use exact project-relative file paths for reads and folder areas like "drafts/x/**" for writes.`)
      }
      const fingerprint = payloadFingerprint({
        agentId: value.agent_id, title: value.title, label: value.label, instructions: value.instructions,
        acceptanceCriteria: value.acceptance_criteria, writes: value.writes, reads: value.reads,
        deliverableIds: value.deliverable_ids, finalizes: value.finalizes_deliverables,
        waitsFor: value.waits_for, connections: value.connections,
        intent: value.intent, assignment: value.assignment,
        ...(value.step_up_from ? { stepUpFrom: value.step_up_from } : {}),
        ...(value.continues_from ? { continuesFrom: value.continues_from } : {}),
        ...(value.fixes ? { fixes: value.fixes } : {}),
        ...(value.narrow_writes ? { narrowWrites: value.narrow_writes } : {}),
        ...(named ? { skills: named.map(s => s.id) } : {}),
        ...(value.stage ? { stage: value.stage } : {}),
        ...(value.piece ? { piece: value.piece } : {}),
        ...(value.size ? { size: value.size } : {}),
        ...(value.checkpoints ? { checkpoints: value.checkpoints } : {}),
        ...(value.lane ? { lane: value.lane } : {})
      })
      const found = operations.lookup(value.operation_id, options.callerId, fingerprint)
      if (found.state === 'created') return { ...found.receipt, replay: true, note: 'This exact operation was already assigned. Nothing new was created.' }
      if (found.state === 'reserved') {
        const existing = options.access.findByOperation(value.operation_id)
        if (existing) {
          const receipt = operations.complete(value.operation_id, options.callerId, outcomeOf(existing)).receipt!
          return { ...receipt, replay: true, note: 'This operation had already created its job; its receipt was reconciled. Nothing new was created.' }
        }
      }
      const carriedFrom = value.step_up_from ?? value.continues_from
      let notCarried: string[] = []
      if (carriedFrom && options.access.continued) {
        const before = options.access.continued(carriedFrom)
        const left = before ? draftFilesLeftOut(value.writes, before.draftFiles) : []
        if (left.length && !value.narrow_writes) throw Error(`Nothing was assigned: the earlier draft of "${before!.title}" also changed ${left.join(', ')}. Add them to writes so this job carries them, or set narrow_writes with why this job leaves them out.`)
        notCarried = left.filter(f => !engineWidens.includes(f))
      }
      const person = options.access.roster().find(r => r.id === value.agent_id)
      const workerSeat = seatOf(value.agent_id)
      const seatCanRun = ['Bash', 'run_isolated', 'run_project_check'].some(t => workerSeat.all.has(t)), seatName = person?.name ?? 'this person'
      const contradiction = moduleDeclarationRefusal({ writes: value.writes, alsoCovered: engineWidens, criteria: value.acceptance_criteria, exists: (p: string) => !!options.access.projectFile?.(p), text: (p: string) => options.access.projectText?.(p) ?? null, seatCanRun, seatName })
        ?? quoteOutputRefusal({ writes: value.writes, criteria: value.acceptance_criteria, exists: () => false, seatCanRun, seatName })
      if (contradiction) throw Error(contradiction)
      const missingTools = [...new Set([value.instructions, ...value.acceptance_criteria].flatMap(t => briefToolsMissing(t, workerSeat.all)))]
      if (missingTools.length) throw Error(`Nothing was assigned: the brief tells ${seatName} to use ${missingTools.join(', ')}, which this worker does not have. ${workerSeat.all.has('Write') ? 'In a copy this worker writes files with its own Write and Edit tools inside its writes, and Damon takes them as the draft when the turn ends.' : workerSeat.all.has('run_isolated') ? 'This worker produces its files through the outputs of its isolated runs, and Damon takes them as the draft.' : 'This worker cannot produce files at all; give the job to a worker who can.'} Name only tools this worker holds, or leave tool names out.`)
      const admitted = admitTask({
        agentId: value.agent_id, title: value.title, instructions: value.instructions,
        acceptanceCriteria: value.acceptance_criteria, writes: value.writes, engineWidens,
        deliverableIds: value.deliverable_ids, finalizesDeliverables: value.finalizes_deliverables,
        reads: value.reads, intent: value.intent as TaskInfo['intent'], assignment: value.assignment as TaskInfo['assignment'],
        ...(value.continues_from && !value.step_up_from && options.access.landsApprovedDraft?.(value.continues_from, { writes: value.writes, ...(value.deliverable_ids ? { deliverableIds: value.deliverable_ids } : {}) }) ? { landsApprovedDraft: true } : {})
      }, options.access.rules)
      if ('error' in admitted) throw Error(admitted.error)
      let stepped: { brain: string } | undefined
      if (value.step_up_from) {
        if (!options.access.stepUp) throw Error('Nothing was assigned: a step up is not available on this route.')
        const answer = options.access.stepUp(value.step_up_from, value.agent_id)
        if ('error' in answer) throw Error(`Nothing was assigned: ${answer.error}`)
        stepped = answer
      }
      operations.reserve(value.operation_id, options.callerId, 'assign', fingerprint)
      const out = options.access.assign({
        operationId: value.operation_id, agentId: value.agent_id, title: value.title, label: value.label,
        instructions: value.instructions, acceptance: admitted.acceptance, writes: value.writes,
        waitsFor: value.waits_for, connections: value.connections,
        deliverableIds: value.deliverable_ids, finalizes: value.finalizes_deliverables, reads: value.reads,
        intent: value.intent as TaskInfo['intent'], assignment: value.assignment as TaskInfo['assignment'], route: admitted.route,
        ...(stepped ? { brain: stepped.brain, steppedUpFrom: value.step_up_from } : {}),
        ...(value.continues_from ? { continuesFrom: value.continues_from } : {}),
        ...(value.narrow_writes && notCarried.length ? { narrowedBecause: value.narrow_writes } : {}),
        ...(value.fixes ? { fixes: value.fixes } : {}),
        ...(named ? { skills: named } : {}),
        ...(value.stage ? { stage: value.stage } : {}),
        ...(value.piece ? { piece: value.piece } : {}),
        ...(value.size === 'feature' && value.checkpoints ? { feature: { checkpoints: 0, sessions: 0, sessionsTotal: 0, maxSessions: DEFAULT_FEATURE_SESSIONS, startedAt: new Date().toISOString(), steps: value.checkpoints } } : {}),
        ...(value.lane ? { lane: value.lane } : {})
      })
      if ('error' in out) throw Error(out.error)
      const receipt = operations.complete(value.operation_id, options.callerId, outcomeOf(out)).receipt!
      const sameFiles = openOnSameFiles(options.access.tasks(), out.id, value.writes)
      const alsoOpen = sameFiles.length ? ` Still open on the same files: ${sameFiles.map(t => `"${t.title}" (id ${t.id}, ${t.status})`).join('; ')}. If this job replaces one of them, drop that one now; if not, make one wait for the other.` : ''
      const screenNote = leftOut ? ` This job changes screens, but ${SCREEN_SKILL} was left out: three skills are named, none is a design skill, and the last (${leftOut}) is one the job relies on.` : addScreen ? ` Damon named ${SCREEN_SKILL} because this job changes screens${swapped ? `, in place of ${swapped} (three skills at most)` : ''}; its reviewer checks the screens against it.` : screenJob && !screenSkill?.on ? ` This job changes screens, but ${SCREEN_SKILL} is not available here, so it runs without it.` : ''
      const skillsNote = named ? ` Skills named: ${named.map(skillRef).join(', ')}; the worker reads them first and its reviewer is told which it used.` : ''
      const carryNote = (notCarried.length ? { notCarried, notCarriedNote: 'These files of the earlier draft are outside this job\'s writes and will not be carried.' } : {}) as Record<string, unknown>
      if (engineWidens.length) Object.assign(carryNote, { engineWidens, engineWidensNote: 'The held draft of the job this one fixes changed these files; the engine adds them to this fix\'s writes when it starts.' })
      return { ...receipt, ...carryNote, replay: false, obligations: admitted.obligations, gates: describeRoute(admitted.route), note: 'Durably created. The report arrives in this conversation when the job finishes; a status is not acceptance or review.' + alsoOpen + skillsNote + screenNote }
    }
  ))

  if (options.policy.capabilities.includes('task.assign') && options.access.requestRevision) tools.push(guarded(
    'request_revision',
    'Send a job that is in review (or failed, or handed back) back to its worker with concrete feedback, up to the revision cap. The worker redoes the job with your feedback; the report arrives here when it finishes. This approves nothing.',
    revisionInput,
    input => {
      const value = input as z.infer<typeof revisionInput>
      const sentBack = options.access.tasks().find(task => task.id === value.task_id)
      const sentBackSeat = sentBack ? seatOf(sentBack.agentId) : null
      const sendBackTools = sentBackSeat ? briefToolsMissing(value.feedback, sentBackSeat.all) : []
      if (sendBackTools.length) throw Error(`Not sent back: the feedback tells the worker to use ${sendBackTools.join(', ')}, which this worker does not have. Say what to change in the work instead; ${sentBackSeat!.all.has('Write') ? 'in a copy this worker writes with its own Write and Edit tools' : sentBackSeat!.all.has('run_isolated') ? 'this worker produces its files through the outputs of its isolated runs' : 'this worker cannot produce files at all, so the job should go to a worker who can'}.`)
      const out = options.access.requestRevision!(value.task_id, value.feedback, value.add_reads)
      if ('error' in out) throw Error(out.error)
      return { taskId: out.id, status: out.status, round: out.round, note: 'Sent back. The worker will redo the job with this feedback; nothing is approved, and the next report is still a status, not acceptance.' }
    }
  ))
  if (options.policy.capabilities.includes('planning.write') && options.access.handToOwner) tools.push(guarded(
    'hand_to_owner', 'Put a concrete question or next action on the owner\'s list, the way a manager puts a decision to the CEO: for a decide card, `what` states the question, the options and your recommendation, one line each, so the owner can answer in a word. This never sends, submits, signs in, or applies files. Any named file must be an exact reviewed input. Include taskId so the owner can send work back.', handoffInput,
    input => {
      const value = input as z.infer<typeof handoffInput>
      if (value.taskId && !options.access.tasks().some(task => task.id === value.taskId)) throw Error('That task does not belong to this project.')
      if (value.kind === 'send' && !value.to) throw Error('Name the recipient before handing over a message.')
      for (const path of [...(value.files ?? []), ...(value.file ? [value.file] : [])]) {
        workerPath(path)
        const grant = approvedGrant(options.policy, path)
        if (!grant) throw Error(`The owner must review ${path} as an input before it can be included in an action. You can ask for that review with a check card without attaching the file.`)
        checkApprovedInput(options.policy.projectRoot, grant)
      }
      return { note: options.access.handToOwner!(value) }
    }
  ))
  if (options.policy.capabilities.includes('planning.write') && options.access.handToOwner) {
    tools.push(guarded(
      'record_cut_line',
      'Record a line the owner took out of something that goes out (a line of a report, a sentence of a letter), exactly as it stood, one whole line, only because he asked. Quote his exact words from the chat in owner_words. Damon\'s own checks then find it in any later draft that puts it back, and he is told in the chat. Give file when he cut it from one file.',
      z.object({ line: z.string().trim().min(4).max(300), owner_words: z.string().trim().min(20).max(500).describe('His exact words from the chat, at least 20 characters.'), file: z.string().min(1).max(500).optional() }).strict(),
      (input: { line: string; owner_words: string; file?: string }) => {
        if (!options.access.ownerSaid?.(input.owner_words)) throw Error('Not recorded: those words are not in any message of the owner. A line is recorded as cut only on his own words.')
        new CutLinesStore(options.stateDir).add(input.line, input.file)
        options.access.say?.(`Damon will now flag "${input.line}" if it comes back in anything that goes out, because you cut it.`)
        return { note: `Recorded, and he is told in the chat. Damon's checks will find "${input.line}" if a later draft puts it back.` }
      }
    ))
    tools.push(guarded(
      'list_cut_lines',
      'The lines the owner cut, which Damon\'s own checks find if a draft puts one back. A record; this changes nothing.',
      z.object({}).strict(),
      () => new CutLinesStore(options.stateDir).list()
    ))
    tools.push(guarded(
      'remove_cut_line',
      'Take a line off the owner\'s cut list, when it was recorded by mistake or he wants it back. Give the line exactly as list_cut_lines shows it and one plain reason. He is told in the chat.',
      z.object({ line: z.string().trim().min(4).max(300), why: z.string().trim().min(5).max(500) }).strict(),
      (input: { line: string; why: string }) => {
        if (!new CutLinesStore(options.stateDir).remove(input.line)) throw Error('Not removed: that line is not on the cut list. Use list_cut_lines.')
        options.access.say?.(`Damon no longer flags "${input.line}". Reason: ${input.why}`)
        return { note: 'Removed, and he is told in the chat.' }
      }
    ))
  }
  if (options.policy.capabilities.includes('planning.write') && options.access.closeOwnerQuestion) tools.push(guarded(
    'close_owner_question', 'Close a question card on the owner\'s list once the owner has answered it in the chat, quoting the answer. Or, when you have put a newer card on his list that asks the same question, close the old one with replaced_by set to the new card\'s id (answer: one line on why the old one is out of date). The one exception to the next sentence: when you have raised a newer Send or Submit card for the SAME outgoing package (the same package folder and recipient), close the old Send or Submit card with replaced_by set to the new card\'s id; it is recorded as replaced, never as sent or done, and is refused if no newer open card for that package exists. Otherwise only a plain question the team asked; a Submit, Send, critic, standard or record card is the owner\'s own to close, and a question he has not answered stays unless a newer card replaces it.',
    z.object({ id: z.string().min(1).max(100), answer: z.string().min(1).max(500), replaced_by: z.string().min(1).max(100).optional().describe('the id of the newer card that takes this one place. On a Send or Submit card this closes the old card as replaced (never as sent or done) and is refused unless a newer open Send or Submit card for the same package exists.'), moot: z.boolean().optional().describe('true: close a critic question that no longer needs his answer because every job it was about has been dropped; answer says why in one line. He is told. Otherwise it stays his.'), not_needed: z.boolean().optional().describe('true: close an errand you put on his list (a Check card with no file, such as "Start Docker Desktop" or "tell me when the files are sent") that is no longer needed; answer says why in one line. It is recorded as not needed, never as done, and he is told. Never use it to mark something as having happened.') }).strict(),
    input => { const { id, answer, replaced_by, moot, not_needed } = input as { id: string; answer: string; replaced_by?: string; moot?: boolean; not_needed?: boolean }; return { note: options.access.closeOwnerQuestion!(id, answer, replaced_by, moot, not_needed) } }
  ))
  if (options.policy.capabilities.includes('task.assign') && options.policy.capabilities.includes('candidate.review') && options.access.approveTask) tools.push(guarded(
    'approve_task', 'Sign off a task only after its checks. A disputed reviewer verdict goes to the owner. This never applies a candidate, releases work or performs an external action.',
    z.object({ task_id: z.string().min(1).max(200), despite: z.string().trim().min(1).max(4000).optional(), known_fault: z.boolean().optional().describe('With despite: the reviewer found a real fault you want kept now and fixed by a follow-up job (assign it with fixes). Everything that builds on this job waits until that fix passes its own review. If the fix is already assigned (fixes set to this job), Damon accepts this now under the owner’s standing rule and he is told, not asked; a job that hands in a deliverable still goes to him.') }).strict(),
    input => {
      if (!options.access.tasks().some(task => task.id === input.task_id)) throw Error('That task does not belong to this project.')
      const out = options.access.approveTask!(input.task_id, input.despite, input.known_fault)
      if ('error' in out) throw Error(out.error)
      return { taskId: out.id, status: out.status }
    }
  ))
  if (options.policy.capabilities.includes('task.assign') && options.policy.capabilities.includes('candidate.review') && options.access.cancelReview) tools.push(guarded(
    'cancel_review',
    'Stop the independent review of a job while it is running, only because the owner asked, then drop the job, send it back to its worker, or approve it. Quote his exact words from the chat in owner_words. The reviewer is stopped, its seat comes back, and its late verdict is thrown away.',
    z.object({ task_id: z.string().min(1).max(200), then: z.enum(['drop', 'back', 'approve']), owner_words: z.string().trim().min(20).max(500).describe('His exact words from the chat, at least 20 characters: a shorter quote proves nothing (the same rule record_owner_choice uses).') }).strict(),
    input => {
      const value = input as { task_id: string; then: 'drop' | 'back' | 'approve'; owner_words: string }
      if (!options.access.tasks().some(task => task.id === value.task_id)) throw Error('That task does not belong to this project.')
      if (!options.access.ownerSaid?.(value.owner_words)) throw Error('Those words are not in any message of the owner.')
      const out = options.access.cancelReview!(value.task_id, value.then, value.owner_words)
      if ('error' in out) throw Error(out.error)
      return { taskId: value.task_id, title: out.title, status: out.status }
    }
  ))
  if (options.policy.capabilities.includes('task.assign') && options.policy.capabilities.includes('candidate.review') && options.access.reviewDeliverable) tools.push(guarded(
    'review_deliverable',
    'Start the independent review of a deliverable record whose needs are settled: a reviewer opens the finished outputs against the recorded needs and sources. Returns at once; the verdict reaches you as a note when it lands, in a few minutes. Call it once per deliverable. It signs nothing off and applies nothing.',
    z.object({ deliverable_id: z.string().min(1).max(200) }).strict(),
    input => options.access.reviewDeliverable!(input.deliverable_id)
  ))
  if (options.policy.capabilities.includes('task.assign') && options.access.dropTask) tools.push(guarded(
    'drop_task',
    'Close a job that has not started, one that failed or was escalated, or one finished and waiting for a look, with the reason. It goes to the archive with its brief and cost. A closed job’s draft is thrown away: its edits reach the project folder only through approval, never by closing, and the reply names any it changed that the folder does not hold. Jobs waiting for it KEEP waiting (a closed job produced nothing); the reply names them so you can amend them. A running job cannot be dropped from here.',
    z.object({ task_id: z.string().min(1).max(200), why: z.string().trim().min(1).max(2000) }).strict(),
    input => {
      if (!options.access.tasks().some(task => task.id === input.task_id)) throw Error('That task does not belong to this project.')
      const out = options.access.dropTask!(input.task_id, input.why)
      if ('error' in out) throw Error(out.error)
      return { taskId: input.task_id, title: out.title, was: out.status, note: 'Archived with the reason. ' + afterDropSentence(options.access.tasks(), input.task_id) + unlandedSentence(out.unlanded ?? []) }
    }
  ))
  if (options.policy.capabilities.includes('task.assign') && options.access.amend) tools.push(guarded(
    'amend_task',
    'Change a job that has not started: add jobs it must wait for (wait_for), replace a dropped prerequisite with reviewed files that satisfy it (replace_prerequisite), widen its reads (add_reads), or make it the fix of a known fault (fixes). On a job Damon parked because its plan said it cannot meet a criterion (the note names the ids), change or drop those job criteria (criteria) or keep them and say how the worker can meet them (resume_why). Widening only, apart from that; nothing is removed, and a running or finished job cannot be changed from here. Damon approves the added files as inputs at their versions on disk.',
    z.object({
      task_id: z.string().min(1).max(200),
      wait_for: z.array(z.string().min(1).max(200)).max(20).optional().describe('Ids of jobs this one must wait for, in addition to what it already waits for.'),
      replace_prerequisite: z.object({ producer_id: z.string().min(1).max(200), files: z.array(z.string().min(1).max(500)).min(1).max(20), reason: z.string().trim().min(1).max(2000) }).strict().optional().describe('A prerequisite job that was dropped, and the reviewed project files that stand in for its output.'),
      add_reads: z.array(z.string().min(1).max(500)).max(20).optional().describe('Project files the job must be able to open, exact project-relative paths.'),
      fixes: z.string().min(1).max(200).optional().describe('Make this queued job the fix of that job’s known fault (or of its reviewer’s refusal): the fault becomes one of its criteria, and it waits for that job if it is not approved yet.'),
      criteria: z.array(z.object({ id: z.string().regex(/^j\d{1,2}$/), text: z.string().max(2000).optional() }).strict()).max(40).optional().describe('Change (text) or drop (no text) job criteria of a job that has not started or that Damon parked. Owner standards cannot be changed.'),
      resume_why: z.string().min(10).max(500).optional().describe('A parked job keeps its criteria: say how the worker can meet them.')
    }).strict(),
    input => {
      const value = input as { task_id: string; wait_for?: string[]; replace_prerequisite?: { producer_id: string; files: string[]; reason: string }; add_reads?: string[]; fixes?: string; criteria?: { id: string; text?: string }[]; resume_why?: string }
      if (!options.access.tasks().some(task => task.id === value.task_id)) throw Error('That task does not belong to this project.')
      if (!value.wait_for?.length && !value.replace_prerequisite && !value.add_reads?.length && !value.fixes && !value.criteria?.length && !value.resume_why) throw Error('Say what to change: wait_for, replace_prerequisite, add_reads, fixes, criteria or resume_why.')
      const out = options.access.amend!(value.task_id, {
        waitFor: value.wait_for,
        replacePrerequisite: value.replace_prerequisite ? { producerId: value.replace_prerequisite.producer_id, files: value.replace_prerequisite.files, reason: value.replace_prerequisite.reason } : undefined,
        addReads: value.add_reads,
        ...(value.fixes ? { fixes: value.fixes } : {}),
        ...(value.criteria ? { criteria: value.criteria } : {}),
        ...(value.resume_why ? { resumeWhy: value.resume_why } : {})
      })
      if ('error' in out) throw Error(out.error)
      return { taskId: out.id, title: out.title, status: out.status, waitsFor: out.needs ?? [], reads: out.reads ?? [], note: 'Changed on the durable record. This approves nothing and starts nothing; the job starts when what it waits for is approved.' }
    }
  ))
  if (options.policy.capabilities.includes('candidate.review') && options.access.candidates) tools.push(guarded(
    'candidates_for_task',
    'The drafts a task produced, held privately by Damon, with each independent review recorded on them and whether the reviewed draft has been put into the project folder. Files listed here are NOT in the folder until "applied" says so. A draft is never re-requested because it is not on disk; it waits for its review and its landing.',
    z.object({ task_id: z.string().min(1).max(200) }).strict(),
    input => {
      if (!options.access.tasks().some(task => task.id === input.task_id) && !options.access.findByOperation(input.task_id)) throw Error('That task does not belong to this project.')
      return options.access.candidates!(input.task_id)
    }
  ))
  if (options.policy.capabilities.includes('candidate.review') && options.access.readDraft) tools.push(guarded(
    'read_draft_file',
    'Read one file of a draft a task produced, held privately by Damon (candidate ids come from candidates_for_task). The bytes of the draft, not of the project folder. A long file comes in pages: start at from=0 and continue with nextFrom until it is absent. Records, not approval; this applies nothing.',
    z.object({ candidate_id: z.string().min(1).max(200), path: z.string().min(1).max(500), from: z.number().int().min(0).max(10_000_000).optional() }).strict(),
    input => options.access.readDraft!(input.candidate_id, input.path, input.from)
  ))
  if (options.policy.capabilities.includes('candidate.review') && options.access.critique) tools.push(guarded(
    'run_workflow_critique', 'List outstanding workflow checks, or request the bounded check for one existing obligation. A started check is not a passing verdict. Its result arrives separately.',
    z.object({ id: z.string().min(1).max(200).optional() }).strict(), input => ({ note: options.access.critique!(input.id) })
  ))
  return tools
}
