import { z } from 'zod'

export const executionIdentity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/)
export const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_INPUT_TOTAL_BYTES = 256 * 1024 * 1024

export const executionCapabilities = ['overview.read', 'files.read', 'worker.run', 'planning.write', 'team.plan', 'task.assign', 'candidate.review', 'candidate.apply', 'web.read', 'browser.read', 'browser.fill', 'worker.copy', 'browser.send'] as const
export type ExecutionCapability = (typeof executionCapabilities)[number]
export const ownerSwitchedCapabilities: readonly ExecutionCapability[] = ['browser.send']
export const defaultCapabilities: readonly ExecutionCapability[] = executionCapabilities.filter(c => !ownerSwitchedCapabilities.includes(c))
export const approvedExecutionInput = z.object({
  path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
export const executionPolicyInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(), contextApproved: z.boolean(),
  providers: z.array(z.enum(['claude', 'openai'])).max(2),
  capabilities: z.array(z.enum(executionCapabilities)).max(executionCapabilities.length),
  inputs: z.array(approvedExecutionInput).max(1000),
  folder: z.boolean().optional(),
  excluded: z.array(z.string().min(1).max(500)).max(200).optional()
}).strict()
export const executionPolicyRecord = executionPolicyInput.omit({ expectedRevision: true }).extend({
  version: z.literal(1), projectId: executionIdentity, projectRoot: z.string().min(1).max(2000),
  revision: z.number().int().positive(), updatedAt: z.string().datetime()
}).strict()
export type ExecutionPolicyInput = z.infer<typeof executionPolicyInput>
export type ExecutionPolicyRecord = z.infer<typeof executionPolicyRecord>
