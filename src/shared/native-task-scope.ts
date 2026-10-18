import { z } from 'zod'
import { approvedExecutionInput, executionIdentity } from './execution-policy'

export const nativeTaskScope = z.object({
  taskId: executionIdentity, definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reads: z.array(z.string().min(1).max(500)).max(100), writes: z.array(z.string().min(1).max(500)).max(100),
  readOnly: z.boolean(),
  workBasisSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inputVersions: z.array(approvedExecutionInput).max(100).optional(),
  carryFrom: executionIdentity.optional()
}).strict()
export type NativeTaskScope = z.infer<typeof nativeTaskScope>
