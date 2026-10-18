import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { taskOperationRecord, taskOperationOutcome, type TaskOperationRecord, type TaskOperationOutcome, type TaskOperationReceipt } from '../../shared/task-operations'
import { resolveInside } from './file-browser'
import { requireReviewedText } from './protected-context'
import { readHistoryData, writeHistoryData } from './durable-history'

const LIMIT = 4 * 1024 * 1024
const database = z.object({ version: z.literal(1), projectId: z.string(), records: z.array(taskOperationRecord) }).strict()

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}
export const payloadFingerprint = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')

export type OperationLookup =
  | { state: 'created'; record: TaskOperationRecord; receipt: TaskOperationReceipt }
  | { state: 'reserved'; record: TaskOperationRecord }
  | { state: 'new' }

export class TaskOperationStore {
  constructor(private stateDir: string, private projectId: string, private now = () => new Date().toISOString()) {}
  private file(): string {
    const target = resolveInside(this.stateDir, 'task-operations.json')
    if (!target || existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || lstatSync(target).size > LIMIT)) throw Error('Assignment receipts need recovery.')
    return target
  }
  read(): TaskOperationRecord[] {
    const file = this.file()
    if (!existsSync(file)) return []
    try {
      const raw = readFileSync(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) throw Error('limit')
      const data = database.parse(readHistoryData(file, raw, LIMIT))
      if (data.projectId !== this.projectId || new Set(data.records.map(record => record.id)).size !== data.records.length) throw Error('identity')
      for (const record of data.records) {
        if (record.projectId !== this.projectId) throw Error('identity')
        if (record.state === 'created' && !record.receipt) throw Error('receipt')
        if (record.state === 'reserved' && record.receipt) throw Error('receipt')
      }
      requireReviewedText(JSON.stringify(data))
      return data.records
    } catch { throw Error('Assignment receipts are damaged or unsupported. Their original contents were preserved. Reconcile them before assigning again.') }
  }
  lookup(id: string, callerId: string, fingerprint: string): OperationLookup {
    const record = this.read().find(item => item.id === id)
    if (!record) return { state: 'new' }
    if (record.callerId !== callerId) throw Error('That operation identity belongs to another caller.')
    if (record.fingerprint !== fingerprint) throw Error('That operation identity was already used for a different request. Use a new identity, or repeat the original request exactly.')
    if (record.state === 'created') return { state: 'created', record, receipt: record.receipt! }
    return { state: 'reserved', record }
  }
  reserve(id: string, callerId: string, kind: 'assign', fingerprint: string): TaskOperationRecord {
    const records = this.read(), existing = records.find(item => item.id === id)
    if (existing) {
      if (existing.callerId !== callerId || existing.fingerprint !== fingerprint || existing.kind !== kind) throw Error('That operation identity was already used for a different request.')
      if (existing.state === 'created') throw Error('That operation identity is already complete.')
      return existing
    }
    const record = taskOperationRecord.parse({ version: 1, id, projectId: this.projectId, callerId, kind, fingerprint, state: 'reserved', reservedAt: this.now() })
    const data = { version: 1, projectId: this.projectId, records: [...records, record] }
    writeHistoryData(this.file(), data, 500, LIMIT)
    return record
  }
  complete(id: string, callerId: string, outcomeValue: TaskOperationOutcome): TaskOperationRecord {
    const outcome = taskOperationOutcome.parse(outcomeValue)
    const records = this.read(), existing = records.find(item => item.id === id)
    if (!existing || existing.callerId !== callerId) throw Error('That operation identity is unavailable.')
    if (existing.state === 'created') {
      const { at: _at, ...recorded } = existing.receipt!
      if (JSON.stringify(canonical(recorded)) !== JSON.stringify(canonical(outcome))) throw Error('That operation identity already recorded a different result.')
      return existing
    }
    const record = taskOperationRecord.parse({ ...existing, state: 'created', receipt: { ...outcome, at: this.now() } })
    writeHistoryData(this.file(), { version: 1, projectId: this.projectId, records: records.map(item => item.id === id ? record : item) }, 500, LIMIT)
    return record
  }
}

export function findTaskByOperation<T extends { operationId?: string }>(live: readonly T[], archiveFile: string, operationId: string): T | undefined {
  const found = live.find(task => task.operationId === operationId)
  if (found) return found
  let raw: string
  try { raw = readFileSync(archiveFile, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw Error('The finished-work archive could not be read, so it cannot be proved that this operation created no job. Reconcile it before assigning again.')
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { const task = JSON.parse(line) as T; if (task.operationId === operationId) return task } catch {}
  }
  return undefined
}
