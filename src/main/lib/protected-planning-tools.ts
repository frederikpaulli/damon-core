import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { schemaWords } from '../../shared/schema-words'
import { BrokerRefusal, type BrokerTool } from './scoped-tool-broker'
import type { ExecutionPolicyRecord } from '../../shared/execution-policy'
import { WorkNeedsStore } from './work-needs-store'
import { ACTIVE_PLAN_CAP, ARCHIVE_NEAR_CAP } from './work-needs-archive'
import { requireReviewedText } from './protected-context'
import { approvedGrant, checkApprovedInput } from './execution-policy'
import { workerPath } from './isolated-worker'
import { toolAnswer } from '../../shared/connection-requests'

const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)
const revision = z.number().int().nonnegative()
const need = z.object({ id, title: z.string().min(1).max(160), why: z.string().min(1).max(3000), importance: z.enum(['required', 'recommended', 'optional']), input: z.enum(['file', 'answer', 'content']), owner: z.boolean(), sources: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict()
const plan = z.object({ expectedRevision: revision, id, title: z.string().min(1).max(160), context: z.string().min(1).max(3000), outputs: z.array(z.string().min(1).max(500)).max(30), needs: z.array(need).min(1).max(40) }).strict()
const supply = z.object({ expectedRevision: revision, deliverable_id: id, need_id: id, file: z.string().min(1).max(500).optional(), answer: z.string().min(1).max(8000).optional(), evidence: z.string().min(1).max(4000) }).strict()
const connect = z.object({ provider: z.string().trim().min(1).max(120), purpose: z.string().trim().min(1).max(400) }).strict()
const choice = z.object({ deliverable_id: id, need_id: id, quote: z.string().trim().min(8).max(4000), action: z.enum(['answer', 'omit']) }).strict()

export type RequestConnection = (input: { provider: string; purpose: string }) => { id: string; needs: string[]; note: string }

export function protectedPlanningTools(options: {
  projectId: string; callerId: string; stateDir: string; policy: ExecutionPolicyRecord
  current(): void
  changed(): void
  requestConnection?: RequestConnection
  ownerSaid?(quote: string): boolean
  archiveClosed?(): void
}): BrokerTool[] {
  const REQUIREMENTS_FILE_LIMIT_BYTES = 1024 * 1024
  const store = new WorkNeedsStore(options.stateDir, options.policy.projectRoot)
  const read = () => {
    const file = join(options.stateDir, 'work-needs.json')
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REQUIREMENTS_FILE_LIMIT_BYTES) throw Error('Requirements need a bounded recovery review: work-needs.json is over ' + Math.round(REQUIREMENTS_FILE_LIMIT_BYTES / 1024) + ' KB.')
      requireReviewedText(readFileSync(file, 'utf8'))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (options.archiveClosed && store.unarchived().length >= ARCHIVE_NEAR_CAP) { try { options.archiveClosed() } catch {} }
    const plans = store.list()
    if (store.unarchived().length > ACTIVE_PLAN_CAP || plans.some(item => !Number.isSafeInteger(item.revision) || !Array.isArray(item.needs) || item.needs.length > 100 || !Array.isArray(item.outputs))) throw Error('Requirements need recovery before protected editing.')
    return plans
  }
  const boundedWrite = (input: unknown): void => {
    requireReviewedText(JSON.stringify(input))
    read()
    if (Buffer.byteLength(JSON.stringify(store.unarchived())) + Buffer.byteLength(JSON.stringify(input)) * 2 + 32768 > REQUIREMENTS_FILE_LIMIT_BYTES) throw Error('Requirement history is near its limit. Preserve it and review archival before adding more.')
  }
  const guarded = (name: string, description: string, schema: z.ZodType, run: (input: any) => unknown): BrokerTool => ({ name, description, schema, execute: async (input, context) => {
    context.signal.throwIfAborted()
    if (context.projectId !== options.projectId || context.callerId !== options.callerId) throw Error('Planning request is outside the caller scope.')
    try { options.current() } catch (e) { throw new BrokerRefusal(e instanceof Error ? e.message : String(e)) }
    let value: unknown
    try { value = schema.parse(input) } catch (e) { throw new BrokerRefusal(`The request does not have the shape this tool takes: ${schemaWords(e).slice(0, 1500)}`) }
    requireReviewedText(JSON.stringify(value))
    let result: unknown
    try { result = run(value); if (result instanceof Promise) result = await result } catch (e) { if (e instanceof BrokerRefusal) throw e; throw new BrokerRefusal(e instanceof Error ? e.message : String(e)) }
    requireReviewedText(JSON.stringify(result)); return result
  } })
  const staleRevision = (plans: { id: string; revision: number }[], at: { id: string; revision: number }, quoted: number, need?: { id: string; title: string; why: string; input: string; importance: string }): string =>
    `Requirements changed: "${at.id}" is at revision ${at.revision} now; you quoted ${quoted}.` +
    (need ? ` The need "${need.id}" now reads: ${JSON.stringify({ title: need.title, why: need.why, input: need.input, importance: need.importance })}. If your evidence still answers it, supply it again with expectedRevision ${at.revision}.` : ` Read it with list_deliverables with from=${plans.findIndex(p => p.id === at.id)} before editing, and quote expectedRevision ${at.revision}.`) +
    (need ? ` The whole record is on list_deliverables with from=${plans.findIndex(p => p.id === at.id)}.` : '')
  const changed = (): string => {
    try { options.changed(); return 'Requirements saved. Your turn derives outstanding owner inputs from these records.' }
    catch { return 'Requirements saved. The Your turn view needs to be reopened to reconcile its derived cards.' }
  }
  return [
    guarded('list_deliverables', 'Read this project’s existing requirements and owner choices, a page at a time: start with from=0 (or leave it out) and pass nextFrom back as from until there is none. These are records, not approval or verified output. No file content is read.', z.object({ from: z.number().int().min(0).optional() }).strict(), (input: { from?: number }) => pageOfPlans(read(), input.from ?? 0)),
    guarded('record_deliverable', 'Record or refine a deliverable and its required/recommended/optional needs. Use expectedRevision 0 for a new ID, otherwise the current revision. Missing entries never delete old needs. This writes planning records only.', plan, input => {
      const { expectedRevision, ...definition } = input as z.infer<typeof plan>
      for (const output of definition.outputs) workerPath(output)
      const previous = read().find(item => item.id === definition.id)
      for (const value of definition.needs) {
        const old = previous?.needs.find(item => item.id === value.id)
        if (old?.owner && !value.owner || old?.importance === 'required' && value.importance !== 'required') throw Error('A protected planning edit cannot remove an owner input requirement or downgrade a required need.')
      }
      const definitions = previous?.needs.filter(item => !item.retired).map(({ id, title, why, importance, input, owner, sources }) => ({ id, title, why, importance, input, owner, sources }))
      if (previous && JSON.stringify({ id: previous.id, title: previous.title, context: previous.context, outputs: previous.outputs, needs: definitions }) === JSON.stringify(definition)) return { plan: previous, note: 'This exact definition is already saved.' }
      if ((previous?.revision ?? 0) !== expectedRevision) throw Error(previous ? staleRevision(read(), previous, expectedRevision) : `Requirements changed: "${definition.id}" does not exist yet; use expectedRevision 0 for a new ID.`)
      if (!previous && store.unarchived().length >= ACTIVE_PLAN_CAP) throw Error('The project requirement limit has been reached.')
      boundedWrite(input)
      const saved = store.record(definition, options.callerId)
      return { plan: saved, note: changed() }
    }),
    guarded('retire_need', 'Retire an obsolete need after a genuine scope change or a decision that answered it, explaining why it no longer applies. History stays. You cannot retire or replace an owner decision.', z.object({ deliverable_id: z.string().min(1).max(200), need_id: z.string().min(1).max(200), reason: z.string().trim().min(15).max(2000) }).strict(), input => {
      const value = input as { deliverable_id: string; need_id: string; reason: string }, current = read().find(item => item.id === value.deliverable_id), need = current?.needs.find(item => item.id === value.need_id)
      if (!current || !need) throw Error('That requirement is unavailable.')
      if (need.retired) throw Error(`That need was already retired: ${need.retired}. If the whole deliverable no longer applies, use retire_deliverable.`)
      if (need.ownerDecision) throw Error('An owner decision cannot be retired; ask the owner through Your turn.')
      boundedWrite(input)
      const saved = store.retire(current.id, need.id, value.reason, options.callerId)
      return { plan: saved, note: changed() }
    }),
    guarded('retire_deliverable', 'Retire a whole deliverable that a decision made obsolete (for example an output the owner chose not to have built). Its history stays; it stops blocking checks and cards. Not for a deliverable with an owner decision still standing.', z.object({ deliverable_id: z.string().min(1).max(200), reason: z.string().trim().min(15).max(2000) }).strict(), input => {
      const value = input as { deliverable_id: string; reason: string }
      boundedWrite(input)
      const saved = store.retireDeliverable(value.deliverable_id, value.reason, options.callerId)
      return { plan: saved, note: changed() }
    }),
    guarded('supply_need', 'Record inspected evidence for a non-owner need. File evidence must be an exact reviewed input version. This cannot answer an owner-only question, approve output or declare independent review.', supply, input => {
      const value = input as z.infer<typeof supply>, current = read().find(item => item.id === value.deliverable_id), need = current?.needs.find(item => item.id === value.need_id)
      if (!current || !need || need.retired) throw Error('That requirement is unavailable.')
      if (need.owner || need.ownerDecision) throw Error('Only the owner may answer this need through Your turn.')
      if (!value.file && !value.answer) throw Error('Supply actual evidence, not only a statement that evidence exists.')
      let evidence: { file?: string; hash?: string; answer?: string; explanation: string } = { ...(value.answer ? { answer: value.answer } : {}), explanation: value.evidence }
      if (value.file) {
        const grant = approvedGrant(options.policy, value.file)
        if (!grant) throw Error('This file was not approved for model access.')
        checkApprovedInput(options.policy.projectRoot, grant)
        evidence = { ...evidence, file: grant.path, hash: grant.sha256 }
      }
      if (JSON.stringify(need.answer) === JSON.stringify(evidence) && !need.issue) return { plan: current, note: 'This evidence is already saved.' }
      const unchangedSince = value.expectedRevision < current.revision && typeof need.planRevision === 'number' && need.planRevision <= value.expectedRevision
      if (current.revision !== value.expectedRevision && !unchangedSince) throw Error(staleRevision(read(), current, value.expectedRevision, need))
      boundedWrite(input)
      const saved = store.supply(current.id, need.id, evidence, options.callerId)
      const moved = unchangedSince ? `The deliverable had moved from revision ${value.expectedRevision} to ${current.revision}, but this need had not changed since the revision you quoted, so it was saved. ` : ''
      return { plan: saved, revision: saved.revision, note: `${moved}${changed()} The deliverable's revision is now ${saved.revision}; quote it as expectedRevision in your next supply_need on it.` }
    }),
    ...(options.ownerSaid ? [guarded('record_owner_choice', 'Record an answer or an optional omission the owner ALREADY gave in the chat, so he is not asked twice. Quote his exact words; the quote must be in one of his messages. Never for a guess or your recommendation; a required need cannot be omitted; a spending approval is never recorded here.', choice, input => {
      const value = input as z.infer<typeof choice>
      if (value.deliverable_id.startsWith('creative-approval-')) throw Error('A spending decision is answered on his list, never recorded from the chat.')
      if (!options.ownerSaid!(value.quote)) throw Error('Those words are not in any message of the owner. Ask him on his list instead.')
      const current = read().find(item => item.id === value.deliverable_id), need = current?.needs.find(item => item.id === value.need_id)
      if (!current || !need || need.retired) throw Error('That requirement is unavailable.')
      boundedWrite(input)
      const saved = store.reply(current.id, need.id, { action: value.action, value: value.quote, revision: need.revision })
      return { plan: saved, note: changed() }
    })] : []),
    ...(options.requestConnection ? [guarded('request_connection', 'Ask the owner to connect an outside service (a shop, analytics, an ads account, a research tool) that a figure on the Overview or a piece of work needs. On this route the programs in Connections do not reach the team yet, so asking for one of them puts no card on the owner\'s list, and the answer says why. Name the service as the owner would and say in one line what it is for; the owner reads that line. The answer tells you what the owner has to do. Nothing is connected until they do it: never report a figure from a service that is not connected, and never ask the owner to paste a key or password into the chat.', connect, input => {
      if (!options.policy.capabilities.includes('planning.write')) throw Error('Asking for a connection needs the planning.write capability.')
      return toolAnswer(options.requestConnection!(input as z.infer<typeof connect>))
    })] : [])
  ]
}

const PLANS_PAGE_BYTES = 60 * 1024
export function pageOfPlans(plans: unknown[], from: number): { plans: unknown[]; total: number; from: number; nextFrom?: number; note: string } {
  const out: unknown[] = []
  let used = 0
  let i = Math.min(Math.max(0, from), plans.length)
  for (; i < plans.length; i += 1) {
    const cost = Buffer.byteLength(JSON.stringify(plans[i]))
    if (out.length > 0 && used + cost > PLANS_PAGE_BYTES) break
    out.push(plans[i]); used += cost
  }
  return { plans: out, total: plans.length, from, ...(i < plans.length ? { nextFrom: i } : {}), note: 'Use existing IDs and current revisions. Owner inputs are answered in Your turn; a model cannot approve or omit them.' + (i < plans.length ? ' More plans follow: call again with from=nextFrom.' : '') }
}
