import { z } from 'zod'
import { operationId } from './operations'

const note = z.string().trim().max(4000)
const label = z.string().trim().max(160)
const ids = z.array(operationId).max(100).refine(value => new Set(value).size === value.length, 'References must be distinct.')
export const deliveryScope = z.object({
  purpose: z.enum(['personal', 'client']),
  client: z.object({ id: operationId, name: label.min(1), businessOwner: label }).strict().nullable(),
  outcome: note, baseline: note, acceptance: note, nonGoals: note,
  approach: z.enum(['undecided', 'deterministic', 'ai-assisted', 'mixed']), approachReason: note,
  operatingOwner: label,
  support: z.object({ arrangement: z.enum(['personal', 'handover-only', 'maintained', 'licensed-product', 'undecided']), rights: note, hostingOwner: label, billingOwner: label, window: note, urgentResponse: note, recovery: note, retention: note, exit: note }).strict(),
  integration: z.object({ applicability: z.enum(['undecided', 'none', 'required']), rationale: note, sources: note, mapping: note, exceptions: note }).strict(),
  monitoring: z.object({ applicability: z.enum(['undecided', 'none', 'required']), rationale: note, coverage: note, reportingOwner: label, offlineStorage: note }).strict(),
  planIds: ids, resourceIds: ids, artifactIds: ids
}).strict().superRefine((value, ctx) => {
  if (value.purpose === 'personal' && value.client !== null) ctx.addIssue({ code: 'custom', message: 'Personal projects do not have a fictional client.' })
  if (value.purpose === 'client' && !value.client) ctx.addIssue({ code: 'custom', message: 'Client work needs a client identity.' })
  if (value.purpose === 'client' && value.support.arrangement === 'personal') ctx.addIssue({ code: 'custom', message: 'Choose the client support arrangement.' })
})
export type DeliveryScope = z.infer<typeof deliveryScope>
export const deliveryStage = z.enum(['discovery', 'building', 'review', 'release-pending'])
export type DeliveryStage = z.infer<typeof deliveryStage>
export const deliverySave = z.object({ operationId, expectedRevision: z.number().int().nonnegative(), reason: note.min(1), scope: deliveryScope }).strict()
export type DeliverySave = z.infer<typeof deliverySave>
export const deliveryAdvance = z.object({ operationId, expectedRevision: z.number().int().nonnegative(), stage: deliveryStage, basis: z.string().regex(/^[a-f0-9]{64}$/), reason: note.min(1) }).strict()
export type DeliveryAdvance = z.infer<typeof deliveryAdvance>
export interface DeliveryIssue { code: string; detail: string; target: 'overview' | 'yours' | 'files' | 'fleet' }
export interface DeliverySnapshot {
  projectId: string; revision: number; scope: DeliveryScope | null;
  stage: DeliveryStage; basis: string; basisChanged: boolean;
  buildIssues: DeliveryIssue[]; reviewIssues: DeliveryIssue[];
  history: { revision: number; at: string; stage: DeliveryStage; reason: string }[]
  historyTotal: number
  available: { plans: { id: string; label: string }[]; resources: { id: string; label: string }[]; artifacts: { id: string; label: string }[] }
}
export const DELIVERY_STAGE_LABEL: Record<DeliveryStage, string> = { discovery: 'Discovery', building: 'Building', review: 'Review', 'release-pending': 'Awaiting release checks' }
export function blankDeliveryScope(): DeliveryScope {
  return { purpose: 'personal', client: null, outcome: '', baseline: '', acceptance: '', nonGoals: '', approach: 'undecided', approachReason: '', operatingOwner: '',
    support: { arrangement: 'personal', rights: '', hostingOwner: '', billingOwner: '', window: '', urgentResponse: '', recovery: '', retention: '', exit: '' },
    integration: { applicability: 'undecided', rationale: '', sources: '', mapping: '', exceptions: '' },
    monitoring: { applicability: 'undecided', rationale: '', coverage: '', reportingOwner: '', offlineStorage: '' }, planIds: [], resourceIds: [], artifactIds: [] }
}
