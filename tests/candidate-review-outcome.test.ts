import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateStore, captureCandidateTargets } from '../src/main/lib/candidate-store'
import { CandidateReviewStore } from '../src/main/lib/candidate-review'
import { ExecutionPolicyStore } from '../src/main/lib/execution-policy'
import { currentWorkerBasisSha256 } from '../src/main/lib/protected-work-basis'
import { candidateReviewBrief, candidateReviewOutcome, latestCandidateFor } from '../src/main/lib/candidate-review-outcome'
import type { ExecutionPolicyRecord } from '../src/shared/execution-policy'
import type { IsolatedRequest, IsolatedResult } from '../src/main/lib/isolated-worker'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'damon-review-outcome-')); dirs.push(dir)
  const root = join(dir, 'project'), state = join(dir, 'private')
  mkdirSync(root); mkdirSync(state); writeFileSync(join(root, 'source.txt'), 'approved source')
  writeFileSync(join(state, 'tasks.json'), JSON.stringify([{ id: 'task-1', agentId: 'worker-1', title: 'Write the report', instructions: 'Use the source', acceptance: 'Totals agree', reads: ['source.txt'], writes: ['report.txt', 'notes.txt'], status: 'review', round: 1, feedback: [], createdAt: 'x', updatedAt: 'x' }]))
  const capabilities = ['worker.run', 'candidate.review'] as ExecutionPolicyRecord['capabilities']
  const policy: ExecutionPolicyRecord = { version: 1, projectId: 'personal', projectRoot: root, revision: 1, updatedAt: new Date().toISOString(), enabled: true, contextApproved: true, providers: ['claude'], capabilities, inputs: [{ path: 'source.txt', sha256: 'a'.repeat(64) }] }
  new ExecutionPolicyStore(state, 'personal').save({ expectedRevision: 0, enabled: true, contextApproved: true, providers: ['claude'], capabilities: [...capabilities], inputs: [] }, root, [state])
  const request: IsolatedRequest = { command: 'node', args: ['-e', 'synthetic'], inputs: [], outputs: ['report.txt'], timeoutSeconds: 1 }
  const candidates = new CandidateStore(state, 'personal', root)
  const reviews = new CandidateReviewStore(state, 'personal', root)
  let clock = 0
  const capture = (text: string, taskId = 'task-1', path = 'report.txt') => {
    const result: IsolatedResult = { operationId: randomUUID(), image: 'node@sha256:' + 'a'.repeat(64), dockerExitCode: 0, evidence: 'local-isolated-process', note: 'synthetic', result: { commandExitCode: 0, commandFailed: false, stdout: '', stderr: '', outputs: [{ path, content: Buffer.from(text).toString('base64') }] } }
    const scope = { taskId, definitionSha256: 'a'.repeat(64), reads: ['source.txt'], writes: ['report.txt', 'notes.txt'], readOnly: false }
    clock += 1
    const own = { ...request, outputs: [path] }
    return candidates.capture(policy, 'worker-1', own, captureCandidateTargets(policy, own.outputs), result, scope)
  }
  return { state, root, candidates, reviews, capture }
}

it('the draft to review is the newest candidate captured for the task, and none for another task', () => {
  const f = fixture()
  const older = f.capture('first draft'), newer = f.capture('second draft')
  expect(latestCandidateFor(f.candidates, 'task-1')?.id).toBe(newer.id)
  expect(older.id).not.toBe(newer.id)
  expect(latestCandidateFor(f.candidates, 'task-2')).toBeUndefined()
})

it('the draft is every record of the job, newest version per file, carried by the newest record', () => {
  const f = fixture()
  f.capture('report v1')
  const notes = f.capture('the notes', 'task-1', 'notes.txt')
  const report = f.capture('report v2')
  const draft = latestCandidateFor(f.candidates, 'task-1')!
  expect(draft.id).toBe(report.id)
  expect(draft.files.map(file => file.path)).toEqual(['report.txt', 'notes.txt'])
  expect(draft.files.map(file => file.status === 'available' ? file.content : '')).toEqual(['report v2', 'the notes'])
  expect(notes.files).toHaveLength(1)
  expect(candidateReviewBrief(draft)).toContain('notes.txt (available)')
})

it('a reviewer that recorded nothing has not reviewed; a recorded "meets" satisfies; "does-not-meet" carries the findings', () => {
  const f = fixture()
  const candidate = f.capture('the report')
  const none = candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:task-1')
  expect(none).toMatchObject({ answered: false, satisfied: false })
  expect(none.objections[0]).toMatch(/no verdict/i)
  const basis = currentWorkerBasisSha256(f.state, 'task-1')
  f.reviews.record({ id: randomUUID(), candidateId: candidate.id, candidateFingerprint: candidate.fingerprint, taskId: 'task-1', reviewerId: 'reviewer:task-1', producerId: 'worker-1', workBasisSha256: basis, policyRevision: 1, observed: [{ path: 'report.txt', sha256: candidate.files[0]!.sha256 }], findings: [{ severity: 'blocking', statement: 'The total on line 3 is wrong.', evidence: 'report.txt line 3 says 12; the source says 21.' }], verdict: 'does-not-meet', summary: 'One total is wrong.' })
  const failed = candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:task-1')
  expect(failed).toMatchObject({ answered: true, satisfied: false })
  expect(failed.objections.join(' ')).toMatch(/line 3 is wrong/)
  f.reviews.record({ id: randomUUID(), candidateId: candidate.id, candidateFingerprint: candidate.fingerprint, taskId: 'task-1', reviewerId: 'reviewer:task-1', producerId: 'worker-1', workBasisSha256: basis, policyRevision: 1, observed: [{ path: 'report.txt', sha256: candidate.files[0]!.sha256 }], findings: [], verdict: 'meets', summary: 'Totals agree.' })
  expect(candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:task-1')).toMatchObject({ answered: true, satisfied: true, objections: [] })
  expect(candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:other').answered).toBe(false)
  f.reviews.record({ id: randomUUID(), candidateId: candidate.id, candidateFingerprint: candidate.fingerprint, taskId: 'task-1', reviewerId: 'reviewer:stale', producerId: 'worker-1', workBasisSha256: 'f'.repeat(64), policyRevision: 1, observed: [{ path: 'report.txt', sha256: candidate.files[0]!.sha256 }], findings: [], verdict: 'meets', summary: 'Totals agree.' })
  const stale = candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:stale')
  expect(stale).toMatchObject({ answered: true, satisfied: false, stale: true })
  expect(stale.objections.join(' ')).toMatch(/no longer describes the current draft/)
})

it('the brief tells the reviewer where the draft is and how a verdict is recorded', () => {
  const f = fixture()
  const candidate = f.capture('the report')
  const brief = candidateReviewBrief(candidate)
  for (const tool of ['list_review_files', 'read_review_file', 'submit_review']) expect(brief).toContain(tool)
  expect(brief).toContain('report.txt')
  expect(brief).toMatch(/not on disk|not in the project folder/i)
})

it('a "meets" with a note on a design preference is satisfied with no objections', () => {
  const f = fixture()
  const candidate = f.capture('the report')
  const basis = currentWorkerBasisSha256(f.state, 'task-1')
  f.reviews.record({ id: randomUUID(), candidateId: candidate.id, candidateFingerprint: candidate.fingerprint, taskId: 'task-1', reviewerId: 'reviewer:task-1', producerId: 'worker-1', workBasisSha256: basis, policyRevision: 1, observed: [{ path: 'report.txt', sha256: candidate.files[0]!.sha256 }], findings: [{ severity: 'note', statement: 'The heading weight could be lighter.', evidence: 'report.txt line 1' }], verdict: 'meets', summary: 'Totals agree.' })
  expect(candidateReviewOutcome(f.reviews, candidate.id, 'reviewer:task-1')).toMatchObject({ answered: true, satisfied: true, objections: [] })
})
