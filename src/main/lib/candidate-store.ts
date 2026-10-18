// Holds a worker's output as a candidate: a draft kept outside the project folder, with
// the hash each target file had before, so applying it later can detect a conflict.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { z } from 'zod'
import { candidateRecord, candidateTarget, type CandidateRecord, type CandidateSummary, type CandidateTarget, type CandidatePreview } from '../../shared/candidates'
import type { ExecutionPolicyRecord } from '../../shared/execution-policy'
import { isolatedRequest, workerPath, type IsolatedRequest, type IsolatedResult } from './isolated-worker'
import { ExecutionPolicyStore, approvedAt, approvedGrant, checkApprovedInput } from './execution-policy'
import { resolveInside } from './file-browser'
import { readFile } from 'node:fs/promises'
import { requireReviewedText, requireReviewedTextInSlices } from './protected-context'
import { readHistoryData, readHistoryDataAsync, writeHistoryData } from './durable-history'
import { bookTextInTurns, nextTurn, parseBookInTurns } from './history-warm'
import type { NativeTaskScope } from '../../shared/native-task-scope'
import { requireTaskInput, requireTaskOutputs, validateNativeTaskScope } from './protected-task-scope'
import { currentWorkerBasisSha256 } from './protected-work-basis'
import { isRenderedView, viewNotATarget } from '../../shared/rendered-views'
import { SMALL_FIX_CALLER } from '../../shared/small-fix'

const LIMIT = 32 * 1024 * 1024
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fingerprint = ({ at: _at, fingerprint: _fingerprint, ...body }: CandidateRecord): string => hash(JSON.stringify(body))
const summary = ({ id, callerId, at, commandFailed, commandExitCode, fingerprint, evidence, files }: CandidateRecord): CandidateSummary => ({
  id, callerId, at, commandFailed, commandExitCode, fingerprint, evidence,
  files: files.map(file => { if (file.status === 'unavailable') return file; const { content: _content, ...metadata } = file; return metadata })
})
const database = z.object({ version: z.literal(1), projectId: z.string(), records: z.array(candidateRecord) }).strict()
const envelope = z.object({
  commandExitCode: z.union([z.number().int(), z.string().max(100), z.null()]), commandFailed: z.boolean(),
  stdout: z.string().max(1048576), stderr: z.string().max(1048576),
  outputs: z.array(z.union([
    z.object({ path: z.string(), content: z.string().max(1398104) }).strict(),
    z.object({ path: z.string(), error: z.literal('Requested output unavailable or refused.') }).strict()
  ])).max(100)
}).strict()

export function candidatePath(path: string): string {
  workerPath(path)
  if (path.length > 500 || path.split('/').some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error('Candidate paths cannot use Windows aliases or device names.')
  if (path.split('/').some(part => /^(?:\.env(?:\..*)?|\.git|\.damon|\.ssh|\.aws|\.azure|\.codex|\.claude|\.npmrc|\.netrc|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))) throw Error('A candidate cannot target credentials or private configuration.')
  return path
}
function distinct(paths: string[]): void {
  paths.forEach(candidatePath)
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw Error('Candidate paths must be distinct on Windows.')
}
function textBytes(content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > 1048576 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw Error('Only UTF-8 text candidates up to 1 MB per file are supported.')
  requireReviewedText(content)
  return bytes
}

export function captureCandidateTargets(policy: ExecutionPolicyRecord, outputs: string[]): CandidateTarget[] {
  distinct(outputs)
  const view = outputs.find(isRenderedView)
  if (view) throw Error(viewNotATarget(view))
  return outputs.map(path => {
    const target = resolveInside(policy.projectRoot, path)
    if (!target) throw Error('A candidate target uses a link or escapes the project.')
    if (!existsSync(target)) return { path, beforeSha256: null }
    const grant = approvedGrant(policy, path)
    if (!grant) throw Error('Review the existing output file version before preparing its replacement.')
    checkApprovedInput(policy.projectRoot, grant)
    return { path, beforeSha256: grant.sha256 }
  })
}

const readCache = new Map<string, { key: string; records: CandidateRecord[] }>()
export class CandidateStore {
  constructor(private stateDir: string, private projectId: string, private projectRoot: string, private now = () => new Date().toISOString()) {}
  private file(): string {
    const target = resolveInside(this.stateDir, 'candidate-files.json')
    if (!target || existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).size > LIMIT)) throw Error('Candidate history needs recovery.')
    return target
  }
  read(): CandidateRecord[] {
    const file = this.file()
    if (!existsSync(file)) return []
    const st = lstatSync(file), key = `${this.projectId}:${st.size}:${st.mtimeMs}`
    const known = readCache.get(file)
    if (known && known.key === key) return [...known.records]
    try {
      const raw = readFileSync(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) throw Error('limit')
      const data = database.parse(readHistoryData(file, raw, LIMIT))
      if (data.projectId !== this.projectId || new Set(data.records.map(record => record.id)).size !== data.records.length) throw Error('identity')
      for (const record of data.records) {
        if (record.projectId !== this.projectId || fingerprint(record) !== record.fingerprint) throw Error('identity')
        distinct(record.files.map(file => file.path))
        for (const file of record.files) if (file.status === 'available' && hash(textBytes(file.content)) !== file.sha256) throw Error('bytes')
      }
      requireReviewedText(JSON.stringify(data))
      readCache.set(file, { key, records: data.records })
      return [...data.records]
    } catch { throw Error('Candidate history is damaged or unsupported. Its original contents were preserved.') }
  }
  private wrote(records: CandidateRecord[]): void {
    const file = this.file()
    try { const st = lstatSync(file); readCache.set(file, { key: `${this.projectId}:${st.size}:${st.mtimeMs}`, records }) } catch { readCache.delete(file) }
  }
  async warm(): Promise<void> {
    const file = this.file()
    if (!existsSync(file)) return
    const before = lstatSync(file), key = `${this.projectId}:${before.size}:${before.mtimeMs}`
    if (readCache.get(file)?.key === key) return
    try {
      const raw = await readFile(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) return
      const data = await parseBookInTurns(await readHistoryDataAsync(file, raw, LIMIT), candidateRecord)
      if (data.projectId !== this.projectId || new Set(data.records.map(record => record.id)).size !== data.records.length) return
      for (let i = 0; i < data.records.length; i++) {
        const record = data.records[i]!
        if (record.projectId !== this.projectId || fingerprint(record) !== record.fingerprint) return
        distinct(record.files.map(file => file.path))
        for (const file of record.files) if (file.status === 'available' && hash(textBytes(file.content)) !== file.sha256) return
        if ((i + 1) % 10 === 0) await nextTurn()
      }
      await requireReviewedTextInSlices(await bookTextInTurns(data))
      const after = lstatSync(file)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
      readCache.set(file, { key, records: data.records })
    } catch {}
  }
  assertRoom(): void {
    const records = this.read()
    writeHistoryData(this.file(), { version: 1, projectId: this.projectId, records }, 100, LIMIT, { recordsNeverChange: true })
    this.wrote(records)
  }
  forTask(taskId: string): CandidateSummary[] {
    return this.read().filter(record => record.taskScope?.taskId === taskId).map(summary)
  }
  hasAvailableFile(taskId: string, claimed: string): boolean {
    const tidied = claimed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').toLowerCase()
    if (!tidied) return false
    return this.read().some(record => record.taskScope?.taskId === taskId && record.files.some(file => file.status === 'available' && file.path.replace(/\\/g, '/').toLowerCase() === tidied))
  }
  draftText(taskId: string, path: string): string | undefined {
    const tidy = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').toLowerCase()
    const want = tidy(path)
    if (!want) return undefined
    let text: string | undefined
    for (const record of this.read()) {
      if (record.taskScope?.taskId !== taskId) continue
      for (const file of record.files) if (file.status === 'available' && tidy(file.path) === want) text = file.content
    }
    return text
  }
  list(): CandidateSummary[] {
    return this.read().map(summary)
  }
  inspect(id: string, path: string): CandidatePreview {
    const record = this.read().find(item => item.id === id), file = record?.files.find(file => file.path === path)
    if (!record || !file) throw Error('That generated draft is unavailable. Refresh its list.')
    const issues: string[] = []
    if (record.taskScope?.workBasisSha256) try {
      if (currentWorkerBasisSha256(this.stateDir, record.taskScope.taskId) !== record.taskScope.workBasisSha256) throw Error('changed')
    } catch { issues.push('Task requirements, owner input or critical project records changed or are unavailable. This draft needs a fresh review against the current work.') }
    if (record.commandFailed) issues.push('The generating command failed. This draft may be incomplete.')
    if (record.files.some(file => file.status === 'unavailable')) issues.push('The operation did not return every requested file.')
    let sameRoot = false
    try { sameRoot = realpathSync(this.projectRoot) === record.projectRoot } catch {}
    if (!sameRoot) issues.push('The project folder changed or is unavailable. Its original file basis cannot be confirmed.')
    else {
      for (const input of record.inputs) try { checkApprovedInput(this.projectRoot, input) } catch { issues.push(`Input changed or unavailable: ${input.path}`) }
      for (const output of record.files) try {
        const target = resolveInside(this.projectRoot, output.path)
        if (!target) throw Error('unsafe')
        if (output.beforeSha256 === null) { if (existsSync(target)) throw Error('new file now exists') }
        else checkApprovedInput(this.projectRoot, { path: output.path, sha256: output.beforeSha256 })
      } catch { issues.push(`Original target changed or unavailable: ${output.path}`) }
    }
    try {
      const policy = new ExecutionPolicyStore(this.stateDir, this.projectId).read()
      if (!policy?.enabled || !policy.contextApproved || !new ExecutionPolicyStore(this.stateDir, this.projectId).onlyWidenedSince(record.policyRevision) || policy.projectRoot !== record.projectRoot || !(policy.capabilities.includes('worker.run') || (record.image === 'local-copy' && policy.capabilities.includes('worker.copy')))) throw Error('changed')
    } catch { issues.push('Project execution permissions changed or are unavailable. A new review is required before further work.') }
    return { candidate: summary(record), file, issues }
  }
  captureCopy(policy: ExecutionPolicyRecord, callerId: string, id: string, changed: { path: string; bytes: Buffer }[], note: { failed: boolean; exit: string | null; seconds: number }, assignedScope?: NativeTaskScope, leftOut?: { path: string; reason: string }[]): CandidateRecord {
    const taskScope = assignedScope ? validateNativeTaskScope(assignedScope) : undefined
    const copyAllowed = policy.capabilities.includes('worker.copy') || (callerId === SMALL_FIX_CALLER && policy.capabilities.includes('candidate.apply'))
    if (policy.projectId !== this.projectId || policy.projectRoot !== realpathSync(this.projectRoot) || !policy.enabled || !copyAllowed) throw Error('Candidate capture is outside the approved project scope.')
    const outputs = changed.map(file => file.path)
    distinct(outputs); requireTaskOutputs(taskScope, outputs)
    const targets = captureCandidateTargets(policy, outputs)
    let total = 0
    const files = changed.map((file, index) => {
      const target = targets[index]!
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes) } catch { return { ...target, status: 'unavailable' as const, reason: 'Requested output unavailable or refused.' as const } }
      let same = false
      try { same = file.bytes.equals(textBytes(content)) } catch { same = false }
      if (!same) return { ...target, status: 'unavailable' as const, reason: 'Requested output unavailable or refused.' as const }
      if (total + file.bytes.length > 4194304) { leftOut?.push({ path: file.path, reason: 'over the 4 MB draft limit' }); return { ...target, status: 'unavailable' as const, reason: 'Requested output unavailable or refused.' as const } }
      try { requireReviewedText(JSON.stringify(content)) } catch { leftOut?.push({ path: file.path, reason: 'it looks like it holds a secret or a key' }); return { ...target, status: 'unavailable' as const, reason: 'Requested output unavailable or refused.' as const } }
      total += file.bytes.length
      return { ...target, status: 'available' as const, sha256: hash(file.bytes), content }
    })
    let record = candidateRecord.parse({ version: 1, id, projectId: this.projectId, projectRoot: policy.projectRoot, callerId, policyRevision: policy.revision, at: this.now(), image: 'local-copy',
      request: { command: 'work-in-a-copy', args: [], timeoutSeconds: Math.max(1, Math.min(3600, Math.round(note.seconds))) }, inputs: [],
      commandFailed: note.failed, commandExitCode: note.exit, files, evidence: 'untrusted-local-copy-candidate', fingerprint: '0'.repeat(64), ...(taskScope ? { taskScope } : {}) })
    record = { ...record, fingerprint: fingerprint(record) }
    requireReviewedText(JSON.stringify(record))
    const next = [...this.read(), record]
    writeHistoryData(this.file(), { version: 1, projectId: this.projectId, records: next }, 100, LIMIT, { recordsNeverChange: true })
    this.wrote(next)
    return record
  }
  capture(policy: ExecutionPolicyRecord, callerId: string, requestValue: IsolatedRequest, targetsValue: CandidateTarget[], result: IsolatedResult, assignedScope?: NativeTaskScope): CandidateRecord {
    const request = isolatedRequest.parse(requestValue), targets = z.array(candidateTarget).max(100).parse(targetsValue)
    const taskScope = assignedScope ? validateNativeTaskScope(assignedScope) : undefined
    request.inputs.forEach(input => requireTaskInput(taskScope, input.path)); requireTaskOutputs(taskScope, request.outputs)
    if (policy.projectId !== this.projectId || policy.projectRoot !== realpathSync(this.projectRoot) || !policy.enabled || !policy.capabilities.includes('worker.run')) throw Error('Candidate capture is outside the approved project scope.')
    if (result.dockerExitCode !== 0 || result.evidence !== 'local-isolated-process') throw Error('Candidate capture requires completed local worker cleanup.')
    distinct(request.outputs)
    if (JSON.stringify(targets.map(target => target.path)) !== JSON.stringify(request.outputs)) throw Error('Candidate target basis does not match the requested outputs.')
    for (const target of targets) if (target.beforeSha256 !== null && !approvedAt(policy, target.path, target.beforeSha256)) throw Error('Candidate replacement lacks an approved original version.')
    for (const input of request.inputs) if (!input.sha256 || !approvedAt(policy, input.path, input.sha256)) throw Error('Candidate input was not approved.')
    const output = envelope.parse(result.result)
    if (JSON.stringify(output.outputs.map(file => file.path)) !== JSON.stringify(request.outputs)) throw Error('Worker returned missing, undeclared or reordered output identities.')
    if (!output.commandFailed && output.commandExitCode !== 0) throw Error('Worker completion fields conflict.')
    requireReviewedText(output.stdout); requireReviewedText(output.stderr)
    let total = 0
    const files = output.outputs.map((file, index) => {
      const target = targets[index]!
      if ('error' in file) return { ...target, status: 'unavailable' as const, reason: file.error }
      const bytes = Buffer.from(file.content, 'base64')
      if (bytes.toString('base64') !== file.content) throw Error('Worker output encoding is not canonical.')
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (!bytes.equals(textBytes(content))) throw Error('Worker text bytes changed during decoding.')
      total += bytes.length
      if (total > 4194304) throw Error('Candidate output exceeds the 4 MB budget.')
      return { ...target, status: 'available' as const, sha256: hash(bytes), content }
    })
    let record = candidateRecord.parse({ version: 1, id: result.operationId, projectId: this.projectId, projectRoot: policy.projectRoot, callerId, policyRevision: policy.revision, at: this.now(), image: result.image,
      request: { command: request.command, args: request.args, timeoutSeconds: request.timeoutSeconds }, inputs: request.inputs,
      commandFailed: output.commandFailed, commandExitCode: output.commandExitCode, files, evidence: 'untrusted-isolated-candidate', fingerprint: '0'.repeat(64), ...(taskScope ? { taskScope } : {}) })
    record = { ...record, fingerprint: fingerprint(record) }
    requireReviewedText(JSON.stringify(record))
    const records = this.read(), previous = records.find(item => item.id === record.id)
    if (previous) { if (previous.fingerprint !== record.fingerprint) throw Error('This worker operation already has different candidate evidence.'); return previous }
    const data = { version: 1, projectId: this.projectId, records: [...records, record] }
    writeHistoryData(this.file(), data, 100, LIMIT, { recordsNeverChange: true })
    this.wrote(data.records)
    return record
  }
}
