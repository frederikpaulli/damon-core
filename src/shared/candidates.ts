import { z } from 'zod'
import { approvedExecutionInput, executionIdentity } from './execution-policy'
import { nativeTaskScope } from './native-task-scope'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const candidateTarget = z.object({ path: z.string().min(1).max(500), beforeSha256: hash.nullable() }).strict()
export const candidateFile = z.discriminatedUnion('status', [
  candidateTarget.extend({ status: z.literal('available'), sha256: hash, content: z.string().max(1048576) }).strict(),
  candidateTarget.extend({ status: z.literal('unavailable'), reason: z.literal('Requested output unavailable or refused.') }).strict()
])
export const candidateRecord = z.object({
  version: z.literal(1), id: z.string().uuid(), projectId: executionIdentity, projectRoot: z.string().min(1).max(2000),
  callerId: executionIdentity, policyRevision: z.number().int().positive(), at: z.string().datetime(),
  image: z.string().regex(/^(?:node@sha256:[a-f0-9]{64}|local-copy)$/),
  request: z.object({ command: z.string().min(1).max(300), args: z.array(z.string().max(100_000)).max(80), timeoutSeconds: z.number().int().min(1).max(3600) }).strict(),
  inputs: z.array(approvedExecutionInput).max(100),
  commandFailed: z.boolean(), commandExitCode: z.union([z.number().int(), z.string().max(100), z.null()]),
  files: z.array(candidateFile).min(1).max(100), fingerprint: hash,
  evidence: z.enum(['untrusted-isolated-candidate', 'untrusted-local-copy-candidate']), taskScope: nativeTaskScope.optional()
}).strict()
export type CandidateRecord = z.infer<typeof candidateRecord>
export type CandidateTarget = z.infer<typeof candidateTarget>
export type CandidateSummary = Pick<CandidateRecord, 'id' | 'callerId' | 'at' | 'commandFailed' | 'commandExitCode' | 'fingerprint' | 'evidence'> & {
  files: Array<Omit<Extract<CandidateRecord['files'][number], { status: 'available' }>, 'content'> | Extract<CandidateRecord['files'][number], { status: 'unavailable' }>>
}
export interface CandidatePreview { candidate: CandidateSummary; file: CandidateRecord['files'][number]; issues: string[] }
