import { z } from 'zod'
import { approvedExecutionInput, executionIdentity } from './execution-policy'
import { taskOperationId } from './task-operations'

export const reviewVerdicts = ['meets', 'does-not-meet', 'cannot-tell'] as const
export const reviewSeverities = ['blocking', 'concern', 'note'] as const

export const reviewFinding = z.object({
  severity: z.enum(reviewSeverities),
  statement: z.string().min(1).max(4000),
  evidence: z.string().min(1).max(4000),
  file: z.string().min(1).max(500).optional()
}).strict()

export const candidateReviewRecord = z.object({
  version: z.literal(1),
  id: taskOperationId,
  projectId: executionIdentity,
  candidateId: z.string().min(1).max(200),
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: executionIdentity,
  reviewerId: executionIdentity,
  producerId: executionIdentity,
  workBasisSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  policyRevision: z.number().int().positive(),
  observed: z.array(approvedExecutionInput).max(100),
  findings: z.array(reviewFinding).max(60),
  verdict: z.enum(reviewVerdicts),
  summary: z.string().min(1).max(8000),
  at: z.string().datetime(),
  evidence: z.literal('independent-candidate-review'),
  authorises: z.literal('nothing')
}).strict()

export type CandidateReviewRecord = z.infer<typeof candidateReviewRecord>
export type ReviewFinding = z.infer<typeof reviewFinding>
