import { z } from 'zod'

export const taskOperationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const taskOperationKinds = ['assign'] as const

export const taskOperationOutcome = z.object({
  taskId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  title: z.string().min(1).max(1000),
  status: z.string().min(1).max(40)
}).strict()
export const taskOperationReceipt = taskOperationOutcome.extend({ at: z.string().datetime() }).strict()

export const taskOperationRecord = z.object({
  version: z.literal(1),
  id: taskOperationId,
  projectId: z.string().min(1).max(200),
  callerId: z.string().min(1).max(200),
  kind: z.enum(taskOperationKinds),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['reserved', 'created']),
  reservedAt: z.string().datetime(),
  receipt: taskOperationReceipt.optional()
}).strict()

export type TaskOperationRecord = z.infer<typeof taskOperationRecord>
export type TaskOperationOutcome = z.infer<typeof taskOperationOutcome>
export type TaskOperationReceipt = z.infer<typeof taskOperationReceipt>
