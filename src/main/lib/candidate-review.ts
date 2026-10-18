// Records the reviewer's verdict on a candidate and whether it still stands against the
// current requirements and files.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { candidateReviewRecord, type CandidateReviewRecord } from '../../shared/candidate-review'
import { resolveInside } from './file-browser'
import { requireReviewedText, requireReviewedTextInSlices } from './protected-context'
import { readHistoryData, readHistoryDataAsync, writeHistoryData } from './durable-history'
import { bookTextInTurns, parseBookInTurns } from './history-warm'
import { CandidateStore } from './candidate-store'
import { ExecutionPolicyStore } from './execution-policy'
import { currentWorkerBasisSha256 } from './protected-work-basis'
import { isSmallFixTask } from '../../shared/small-fix'

const LIMIT = 8 * 1024 * 1024
const database = z.object({ version: z.literal(1), projectId: z.string(), records: z.array(candidateReviewRecord) }).strict()

export interface ReviewStanding {
  record: CandidateReviewRecord
  usable: boolean
  issues: string[]
}

const reviewCache = new Map<string, { key: string; records: CandidateReviewRecord[] }>()
const fileKey = (projectId: string, s: import('node:fs').Stats): string => `${projectId}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`

export class CandidateReviewStore {
  constructor(private stateDir: string, private projectId: string, private projectRoot: string, private now = () => new Date().toISOString()) {}
  private file(): string {
    const target = resolveInside(this.stateDir, 'candidate-reviews.json')
    if (!target || existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || lstatSync(target).size > LIMIT)) throw Error('Candidate reviews need recovery.')
    return target
  }
  read(): CandidateReviewRecord[] {
    const file = this.file()
    if (!existsSync(file)) return []
    const key = fileKey(this.projectId, lstatSync(file)), known = reviewCache.get(file)
    if (known && known.key === key) return structuredClone(known.records)
    try {
      const raw = readFileSync(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) throw Error('limit')
      const data = database.parse(readHistoryData(file, raw, LIMIT))
      if (data.projectId !== this.projectId || new Set(data.records.map(record => record.id)).size !== data.records.length) throw Error('identity')
      for (const record of data.records) {
        if (record.projectId !== this.projectId) throw Error('identity')
        if (record.reviewerId === record.producerId) throw Error('independence')
      }
      requireReviewedText(JSON.stringify(data))
      reviewCache.set(file, { key, records: data.records })
      return structuredClone(data.records)
    } catch { throw Error('Candidate reviews are damaged or unsupported. Their original contents were preserved.') }
  }
  async warm(): Promise<void> {
    const file = this.file()
    if (!existsSync(file)) return
    const key = fileKey(this.projectId, lstatSync(file))
    if (reviewCache.get(file)?.key === key) return
    try {
      const raw = await readFile(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) return
      const data = await parseBookInTurns(await readHistoryDataAsync(file, raw, LIMIT), candidateReviewRecord)
      if (data.projectId !== this.projectId || new Set(data.records.map(record => record.id)).size !== data.records.length) return
      for (const record of data.records) if (record.projectId !== this.projectId || record.reviewerId === record.producerId) return
      await requireReviewedTextInSlices(await bookTextInTurns(data))
      if (fileKey(this.projectId, lstatSync(file)) !== key) return
      reviewCache.set(file, { key, records: data.records })
    } catch {}
  }
  forCandidate(candidateId: string): CandidateReviewRecord[] {
    return this.read().filter(record => record.candidateId === candidateId)
  }

  standing(record: CandidateReviewRecord): ReviewStanding {
    const issues: string[] = []
    let candidate
    try { candidate = new CandidateStore(this.stateDir, this.projectId, this.projectRoot).read().find(item => item.id === record.candidateId) }
    catch { issues.push('The generated drafts need recovery, so this review cannot be checked against them.') }
    if (candidate === undefined && !issues.length) issues.push('The reviewed draft is no longer stored.')
    else if (candidate && candidate.fingerprint !== record.candidateFingerprint) issues.push('The draft changed after this review. A changed draft needs a fresh review.')
    if (candidate) {
      const available = candidate.files.filter(file => file.status === 'available')
      for (const file of available) {
        const seen = record.observed.find(item => item.path === file.path)
        if (!seen) issues.push(`This review never read ${file.path}.`)
        else if (file.status === 'available' && seen.sha256 !== file.sha256) issues.push(`${file.path} changed after it was read.`)
      }
    }
    if (!record.workBasisSha256) issues.push('This review is not bound to a task basis, so nothing shows which requirements and owner answers it was made under.')
    else {
      try {
        if (currentWorkerBasisSha256(this.stateDir, record.taskId, isSmallFixTask(record.taskId)) !== record.workBasisSha256) issues.push('Requirements, owner answers or critical findings changed after this review.')
      } catch { issues.push('The task basis this review was made against is unavailable or needs recovery.') }
    }
    try {
      const store = new ExecutionPolicyStore(this.stateDir, this.projectId)
      if (!store.onlyWidenedSince(record.policyRevision)) issues.push('Project execution permissions changed after this review.')
    } catch { issues.push('Project execution permissions are unavailable.') }
    return { record, usable: issues.length === 0, issues }
  }

  record(value: Omit<CandidateReviewRecord, 'version' | 'projectId' | 'at' | 'evidence' | 'authorises'>): CandidateReviewRecord {
    if (value.reviewerId === value.producerId) throw Error('A draft cannot be reviewed by the agent that produced it. Assign a different reviewer.')
    const record = candidateReviewRecord.parse({ ...value, version: 1, projectId: this.projectId, at: this.now(), evidence: 'independent-candidate-review', authorises: 'nothing' })
    requireReviewedText(JSON.stringify(record))
    const records = this.read(), previous = records.find(item => item.id === record.id)
    if (previous) {
      const { at: _at, ...settled } = previous, { at: _now, ...incoming } = record
      if (JSON.stringify(settled) !== JSON.stringify(incoming)) throw Error('This review run already recorded a different verdict. Its original record stands.')
      return previous
    }
    const data = { version: 1, projectId: this.projectId, records: [...records, record] }
    writeHistoryData(this.file(), data, 500, LIMIT)
    reviewCache.delete(this.file())
    return record
  }
}
