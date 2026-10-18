import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateStore, captureCandidateTargets } from '../src/main/lib/candidate-store'
import { CandidateReviewStore } from '../src/main/lib/candidate-review'
import { protectedReviewTools } from '../src/main/lib/protected-review-tools'
import { ExecutionPolicyStore } from '../src/main/lib/execution-policy'
import type { ExecutionPolicyRecord } from '../src/shared/execution-policy'
import type { IsolatedRequest, IsolatedResult } from '../src/main/lib/isolated-worker'
import { currentWorkerBasisSha256 } from '../src/main/lib/protected-work-basis'
import { ScopedToolBroker } from '../src/main/lib/scoped-tool-broker'
import { cosmeticIsNote, fileRole } from '../src/shared/file-role'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ID = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'

it('requires every broker-delivered page and refuses coverage from a denied reply', async () => {
  const f = fixture({ report: '"'.repeat(1024 * 1024) })
  const make = (outputBytes: number) => {
    const broker = new ScopedToolBroker({ projectId: 'personal', callerId: 'reviewer-1', sessionId: 'session' }, f.tools, { calls: 100, inputBytes: 262144, outputBytes })
    broker.beginTurn('turn')
    return (tool: string, args: unknown) => broker.dispatch({ sessionId: 'session', turnId: 'turn', callId: randomUUID(), tool, arguments: args })
  }
  const denied = make(100)
  expect((await denied('read_review_file', { path: 'report.txt' })).success).toBe(false)
  const call = make(1048576)
  const submit = () => call('submit_review', { operation_id: ID, verdict: 'meets', summary: 'Read all files', findings: [] })
  expect((await submit()).success).toBe(false)
  await call('read_review_file', { path: 'notes.txt' })
  await call('read_review_file', { path: 'report.txt', from: 1040000 })
  expect((await submit()).success).toBe(false)
  let from = 0
  for (;;) {
    const response = await call('read_review_file', { path: 'report.txt', from })
    expect(response.success).toBe(true)
    const page = JSON.parse(response.contentItems[0].text)
    if (page.nextFrom === undefined) break
    from = page.nextFrom
  }
  expect((await submit()).success).toBe(true)
  expect(f.reviews.standing(f.reviews.read()[0]).usable).toBe(true)
}, 30_000)

function fixture(over: { capabilities?: readonly string[]; callerId?: string; current?: () => void; report?: string; notesFor?: (path: string) => boolean; visualProblems?: (summary: string) => string[]; requiredChecks?: () => string[]; canRunChecks?: boolean; checksRun?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'damon-review-')); dirs.push(dir)
  const root = join(dir, 'project'), state = join(dir, 'private')
  mkdirSync(root); mkdirSync(state); writeFileSync(join(root, 'source.txt'), 'approved source')
  writeFileSync(join(state, 'tasks.json'), JSON.stringify([{ id: 'task-1', agentId: 'worker-1', title: 'Write the report', instructions: 'Use the source', acceptance: 'Totals agree', reads: ['source.txt'], writes: ['report.txt', 'notes.txt'], status: 'working', round: 1, feedback: [], createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }]))
  const capabilities = (over.capabilities ?? ['worker.run', 'candidate.review']) as ExecutionPolicyRecord['capabilities']
  const policy: ExecutionPolicyRecord = { version: 1, projectId: 'personal', projectRoot: root, revision: 1, updatedAt: new Date().toISOString(), enabled: true, contextApproved: true, providers: ['claude'], capabilities, inputs: [{ path: 'source.txt', sha256: sha('approved source') }] }
  new ExecutionPolicyStore(state, 'personal').save({ expectedRevision: 0, enabled: true, contextApproved: true, providers: ['claude'], capabilities: [...capabilities], inputs: policy.inputs }, root, [state])
  const request: IsolatedRequest = { command: 'node', args: ['-e', 'synthetic'], inputs: policy.inputs, outputs: ['report.txt', 'notes.txt'], timeoutSeconds: 1 }
  const outputs = (files: Array<{ path: string; text?: string }>) => files.map(file => file.text === undefined
    ? { path: file.path, error: 'Requested output unavailable or refused.' as const }
    : { path: file.path, content: Buffer.from(file.text).toString('base64') })
  const candidates = new CandidateStore(state, 'personal', root)
  const capture = (files: Array<{ path: string; text?: string }>, producer = 'worker-1') => {
    const result: IsolatedResult = { operationId: randomUUID(), image: 'node@sha256:' + 'a'.repeat(64), dockerExitCode: 0, evidence: 'local-isolated-process', note: 'synthetic', result: { commandExitCode: 0, commandFailed: false, stdout: '', stderr: '', outputs: outputs(files) } }
    const scope = { taskId: 'task-1', definitionSha256: 'a'.repeat(64), reads: ['source.txt'], writes: ['report.txt', 'notes.txt'], readOnly: false }
    return candidates.capture(policy, producer, request, captureCandidateTargets(policy, request.outputs), result, scope)
  }
  const candidate = capture([{ path: 'report.txt', text: over.report ?? 'the report' }, { path: 'notes.txt', text: 'the notes' }])
  const callerId = over.callerId ?? 'reviewer-1'
  const tools = protectedReviewTools({ projectId: 'personal', callerId, stateDir: state, projectRoot: root, policy, assignment: { candidateId: candidate.id, taskId: 'task-1' }, current: over.current ?? (() => {}), ...(over.notesFor ? { notesFor: over.notesFor } : {}), ...(over.visualProblems ? { visualProblems: over.visualProblems } : {}), ...(over.requiredChecks ? { requiredChecks: over.requiredChecks } : {}), ...(over.canRunChecks ? { canRunChecks: true } : {}), ...(over.checksRun ? { checksRun: over.checksRun } : {}) } as Parameters<typeof protectedReviewTools>[0])
  const context = { projectId: 'personal', callerId, sessionId: 's1', signal: new AbortController().signal, callId: 'c1', turnId: 't1' }
  const run = async (name: string, input: unknown, ctx: Partial<typeof context> = {}) => {
    const tool = tools.find(tool => tool.name === name)!
    const output = await tool.execute(input, { ...context, ...ctx })
    tool.resultAccepted?.(input, output)
    return output
  }
  const readAll = async () => { await run('read_review_file', { path: 'report.txt' }); await run('read_review_file', { path: 'notes.txt' }) }
  const submit = (over2: Record<string, unknown> = {}) => run('submit_review', { operation_id: ID, verdict: 'meets', summary: 'Both files match the criteria.', findings: [], ...over2 })
  return { dir, root, state, policy, candidate, candidates, tools, run, readAll, submit, capture, reviews: new CandidateReviewStore(state, 'personal', root) }
}

it('P3: a refusal only for a run the reviewer could make itself is refused back to it', async () => {
  const f = fixture({ canRunChecks: true }); await f.readAll()
  await expect(f.submit({ verdict: 'does-not-meet', summary: 'Not proven.', findings: [{ severity: 'blocking', statement: 'the full test suite was not re-run after the change', evidence: 'report' }] })).rejects.toThrow(/run the check yourself/)
  await expect(f.submit({ verdict: 'does-not-meet', summary: 'Wrong.', findings: [{ severity: 'blocking', statement: 'the full test suite was not re-run after the change', evidence: 'report' }, { severity: 'blocking', statement: 'Totals disagree', evidence: 'report.txt says 12, notes.txt says 9' }] })).resolves.toBeTruthy()
  const g = fixture(); await g.readAll()
  await expect(g.submit({ verdict: 'does-not-meet', summary: 'Not proven.', findings: [{ severity: 'blocking', statement: 'the full test suite was not re-run after the change', evidence: 'report' }] })).resolves.toBeTruthy()
})

it('P3 fix round 1: said once a run, never after a check has run, and "cannot-tell" stays open', async () => {
  const refusal = { verdict: 'does-not-meet', summary: 'Not proven.', findings: [{ severity: 'blocking', statement: 'the full test suite was not re-run after the change', evidence: 'report' }] }
  const f = fixture({ canRunChecks: true }); await f.readAll()
  await expect(f.submit(refusal)).rejects.toThrow(/record "cannot-tell"/)
  await expect(f.submit(refusal)).resolves.toBeTruthy()
  const g = fixture({ canRunChecks: true, checksRun: () => 1 }); await g.readAll()
  await expect(g.submit(refusal)).resolves.toBeTruthy()
})

it('a reviewer that has not opened the files cannot record a verdict', async () => {
  const f = fixture()
  await expect(f.submit()).rejects.toThrow(/Read every file.*report\.txt, notes\.txt/)
  await f.run('read_review_file', { path: 'report.txt' })
  await expect(f.submit()).rejects.toThrow(/notes\.txt/)
  expect(f.reviews.read()).toEqual([])
  await f.run('read_review_file', { path: 'notes.txt' })
  const out = await f.submit() as Record<string, unknown>
  expect(out).toMatchObject({ verdict: 'meets', filesRead: 2 })
  expect(out.note).toMatch(/authorises nothing/i)
})

it('records what was actually read, and says in the record that it authorises nothing', async () => {
  const f = fixture()
  await f.readAll()
  await f.submit({ verdict: 'does-not-meet', summary: 'The notes contradict the report.', findings: [{ severity: 'blocking', statement: 'Totals disagree', evidence: 'report.txt says 12, notes.txt says 9', file: 'notes.txt' }] })
  const [saved] = f.reviews.read()
  expect(saved).toMatchObject({ verdict: 'does-not-meet', reviewerId: 'reviewer-1', producerId: 'worker-1', taskId: 'task-1', evidence: 'independent-candidate-review', authorises: 'nothing' })
  expect(saved!.observed.map(item => item.path).sort()).toEqual(['notes.txt', 'report.txt'])
  expect(saved!.candidateFingerprint).toBe(f.candidate.fingerprint)
  expect(f.reviews.standing(saved!)).toMatchObject({ usable: true, issues: [] })
})

it('the producer cannot be its own independent reviewer', async () => {
  const f = fixture({ callerId: 'worker-1' })
  await expect(f.run('list_review_files', {})).rejects.toThrow(/produced this draft/)
  await expect(f.run('read_review_file', { path: 'report.txt' })).rejects.toThrow(/produced this draft/)
  await expect(f.submit()).rejects.toThrow(/produced this draft/)
  expect(f.reviews.read()).toEqual([])
})

it('a blocking finding contradicts a "meets" verdict', async () => {
  const f = fixture()
  await f.readAll()
  await expect(f.submit({ findings: [{ severity: 'blocking', statement: 'Missing totals', evidence: 'report.txt has no total row' }] })).rejects.toThrow(/contradict/)
  const out = await f.submit({ findings: [{ severity: 'concern', statement: 'Sparse comments', evidence: 'report.txt is terse' }] }) as Record<string, unknown>
  expect(out).toMatchObject({ verdict: 'meets' })
})

it('a draft that changes mid-review cannot be given a verdict about what was read', async () => {
  const f = fixture()
  await f.readAll()
  rmSync(join(f.state, 'candidate-files.json'))
  const replaced = f.capture([{ path: 'report.txt', text: 'a different report' }, { path: 'notes.txt', text: 'the notes' }])
  const g = fixture()
  expect(replaced.fingerprint).not.toBe(f.candidate.fingerprint)
  await g.readAll()
  const store = new CandidateStore(g.state, 'personal', g.root)
  const record = store.read()[0]!
  const reviews = new CandidateReviewStore(g.state, 'personal', g.root)
  const saved = reviews.record({ id: OTHER, candidateId: record.id, candidateFingerprint: record.fingerprint, taskId: 'task-1', reviewerId: 'reviewer-1', producerId: 'worker-1', policyRevision: 1, workBasisSha256: currentWorkerBasisSha256(g.state, 'task-1'), observed: [{ path: 'report.txt', sha256: sha('stale bytes') }, { path: 'notes.txt', sha256: sha('the notes') }], findings: [], verdict: 'meets', summary: 'read' })
  expect(reviews.standing(saved)).toMatchObject({ usable: false })
  expect(reviews.standing(saved).issues.join(' ')).toMatch(/report\.txt changed after it was read/)
})

it('a review stops standing when the draft, the requirements or the permissions move', async () => {
  const f = fixture()
  await f.readAll(); await f.submit()
  const saved = f.reviews.read()[0]!
  expect(f.reviews.standing(saved).usable).toBe(true)
  writeFileSync(join(f.state, 'user-profile.json'), JSON.stringify('A new owner requirement'))
  expect(f.reviews.standing(saved).issues.join(' ')).toMatch(/Requirements, owner answers or critical findings changed/)
  rmSync(join(f.state, 'user-profile.json'))
  new ExecutionPolicyStore(f.state, 'personal').save({ expectedRevision: 1, enabled: true, contextApproved: true, providers: ['claude'], capabilities: ['candidate.review'], inputs: f.policy.inputs }, f.root, [f.state])
  expect(f.reviews.standing(saved).issues.join(' ')).toMatch(/execution permissions changed/)
  rmSync(join(f.state, 'candidate-files.json'))
  expect(f.reviews.standing(saved).issues.join(' ')).toMatch(/no longer stored/)
})

it('a review that skipped a readable file never counts as standing, whatever its verdict', () => {
  const f = fixture()
  const record = f.candidates.read()[0]!
  const saved = f.reviews.record({ id: ID, candidateId: record.id, candidateFingerprint: record.fingerprint, taskId: 'task-1', reviewerId: 'reviewer-1', producerId: 'worker-1', policyRevision: 1, workBasisSha256: currentWorkerBasisSha256(f.state, 'task-1'), observed: [{ path: 'report.txt', sha256: record.files[0]!.status === 'available' ? record.files[0]!.sha256 : '' }], findings: [], verdict: 'meets', summary: 'Looks fine.' })
  expect(f.reviews.standing(saved)).toMatchObject({ usable: false })
  expect(f.reviews.standing(saved).issues.join(' ')).toMatch(/never read notes\.txt/)
})

it('an unavailable output stays visible and cannot be read into a pass', async () => {
  const f = fixture()
  rmSync(join(f.state, 'candidate-files.json'))
  f.capture([{ path: 'report.txt', text: 'the report' }, { path: 'notes.txt' }])
  const g = fixture()
  rmSync(join(g.state, 'candidate-files.json'))
  const partial = g.capture([{ path: 'report.txt', text: 'the report' }, { path: 'notes.txt' }])
  const tools = protectedReviewTools({ projectId: 'personal', callerId: 'reviewer-1', stateDir: g.state, projectRoot: g.root, policy: g.policy, assignment: { candidateId: partial.id, taskId: 'task-1' }, current: () => {} })
  const context = { projectId: 'personal', callerId: 'reviewer-1', sessionId: 's1', signal: new AbortController().signal, callId: 'c1', turnId: 't1' }
  const run = async (name: string, input: unknown) => {
    const tool = tools.find(tool => tool.name === name)!, output = await tool.execute(input, context)
    tool.resultAccepted?.(input, output)
    return output
  }
  const listed = await run('list_review_files', {}) as Record<string, any>
  expect(listed.files.find((file: any) => file.path === 'notes.txt')).toMatchObject({ status: 'unavailable' })
  await expect(run('read_review_file', { path: 'notes.txt' })).rejects.toThrow(/unavailable/)
  await run('read_review_file', { path: 'report.txt' })
  const out = await run('submit_review', { operation_id: ID, verdict: 'cannot-tell', summary: 'One output never arrived.', findings: [{ severity: 'blocking', statement: 'notes.txt was never produced', evidence: 'listed as unavailable' }] }) as Record<string, unknown>
  expect(out).toMatchObject({ verdict: 'cannot-tell', filesRead: 1 })
})

it('a repeated submit returns the original verdict and cannot replace it', async () => {
  const f = fixture()
  await f.readAll()
  const first = await f.submit() as Record<string, unknown>
  const again = await f.submit() as Record<string, unknown>
  expect(again.reviewId).toBe(first.reviewId)
  expect(f.reviews.read()).toHaveLength(1)
  await expect(f.submit({ verdict: 'does-not-meet', summary: 'Changed my mind.' })).rejects.toThrow(/already recorded a different verdict/)
  expect(f.reviews.read()[0]!.verdict).toBe('meets')
})

it('refuses a foreign caller, a foreign project, an aborted turn and a stale basis', async () => {
  const f = fixture()
  await expect(f.run('list_review_files', {}, { callerId: 'someone-else' })).rejects.toThrow(/outside the caller scope/)
  await expect(f.run('list_review_files', {}, { projectId: 'client' })).rejects.toThrow(/outside the caller scope/)
  await expect(f.run('list_review_files', {}, { signal: AbortSignal.abort() })).rejects.toThrow()
  const g = fixture({ current: () => { throw Error('Prepare a fresh turn before continuing.') } })
  await expect(g.run('read_review_file', { path: 'report.txt' })).rejects.toThrow(/fresh turn/)
  expect(g.reviews.read()).toEqual([])
})

it('without the capability there are no review tools at all', () => {
  expect(fixture({ capabilities: ['worker.run'] }).tools).toHaveLength(0)
  expect(fixture({ capabilities: ['worker.run', 'candidate.review'] }).tools.map(tool => tool.name)).toEqual(['compare_to_project', 'list_review_files', 'read_review_file', 'submit_review'])
})

it.each([
  ['{broken', 'unparseable'],
  ['{"version":1,"projectId":"client","records":[]}', 'foreign project'],
  [`{"version":1,"projectId":"personal","records":[{"version":1,"id":"${ID}","projectId":"personal","candidateId":"c","candidateFingerprint":"${'a'.repeat(64)}","taskId":"task-1","reviewerId":"same","producerId":"same","policyRevision":1,"observed":[],"findings":[],"verdict":"meets","summary":"s","at":"2026-09-09T00:00:00.000Z","evidence":"independent-candidate-review","authorises":"nothing"}]}`, 'a self-review']
])('damaged or self-reviewed history fails closed and is preserved (%s)', async (raw, _why) => {
  const f = fixture()
  writeFileSync(join(f.state, 'candidate-reviews.json'), raw)
  expect(() => f.reviews.read()).toThrow(/damaged|unsupported/)
  await f.readAll()
  await expect(f.submit()).rejects.toThrow(/damaged|unsupported/)
  expect(readFileSync(join(f.state, 'candidate-reviews.json'), 'utf8')).toBe(raw)
})

it('refuses a verdict when the task record is missing, rather than recording an unbound one', async () => {
  const f = fixture()
  await f.readAll()
  rmSync(join(f.state, 'tasks.json'))
  await expect(f.submit()).rejects.toThrow(/cannot be bound to its current requirements/)
  expect(f.reviews.read()).toEqual([])
})

it('an unbound legacy review never counts as standing', () => {
  const f = fixture()
  const record = f.candidates.read()[0]!
  const available = record.files.filter(file => file.status === 'available')
  const saved = f.reviews.record({ id: OTHER, candidateId: record.id, candidateFingerprint: record.fingerprint, taskId: 'task-1', reviewerId: 'reviewer-1', producerId: 'worker-1', policyRevision: 1, observed: available.map(file => ({ path: file.path, sha256: file.status === 'available' ? file.sha256 : '' })), findings: [], verdict: 'meets', summary: 'Read everything.' })
  expect(saved.workBasisSha256).toBeUndefined()
  expect(f.reviews.standing(saved)).toMatchObject({ usable: false })
  expect(f.reviews.standing(saved).issues.join(' ')).toMatch(/not bound to a task basis/)
})
it('a cosmetic-only refusal of a file that does not go out is recorded as notes', async () => {
  const internal = (p: string): boolean => p === 'notes.txt'
  const f = fixture({ notesFor: internal })
  await f.readAll()
  const cosmetic = { severity: 'blocking', statement: 'Two em dashes in the second paragraph.', evidence: 'notes.txt line 2', file: 'notes.txt' }
  await expect(f.submit({ verdict: 'does-not-meet', findings: [cosmetic] })).rejects.toThrow(/cosmetic point .* does not go out: notes\.txt/)
  await expect(f.submit({ operation_id: OTHER, verdict: 'meets', findings: [{ ...cosmetic, severity: 'note' }] })).resolves.toBeTruthy()
})

it('a cosmetic point in what goes out, a substantive point, or an owner standard still blocks', async () => {
  const internal = (p: string): boolean => p === 'notes.txt'
  const outward = fixture({ notesFor: internal })
  await outward.readAll()
  await expect(outward.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'Two em dashes in the opening.', evidence: 'report.txt line 1', file: 'report.txt' }] })).resolves.toBeTruthy()
  const wrong = fixture({ notesFor: internal })
  await wrong.readAll()
  await expect(wrong.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'The total is wrong: 41,200, not 42,100.', evidence: 'notes.txt line 3', file: 'notes.txt' }] })).resolves.toBeTruthy()
  const standard = fixture({ notesFor: internal })
  await standard.readAll()
  await expect(standard.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: '[s2] Two em dashes; the owner\'s standard is none.', evidence: 'notes.txt line 2', file: 'notes.txt' }] })).resolves.toBeTruthy()
})

it('"meets" is refused until every check the change needs has run in this review', async () => {
  let missing = ['the whole backend test suite']
  const f = fixture({ requiredChecks: () => missing })
  await f.readAll()
  await expect(f.submit()).rejects.toThrow(/Before "meets", run in this review: the whole backend test suite/)
  await expect(f.submit({ operation_id: OTHER, verdict: 'cannot-tell', summary: 'The suite would not build in the copy.' })).resolves.toBeTruthy()
  missing = []
  const g = fixture({ requiredChecks: () => missing })
  await g.readAll()
  await expect(g.submit()).resolves.toBeTruthy()
})

it('a careful look holds "meets" to its pictures and its VISUAL RESULTS', async () => {
  const f = fixture({ visualProblems: (s) => (/VISUAL RESULTS/.test(s) ? [] : ['Write a VISUAL RESULTS block.']) })
  await f.readAll()
  await expect(f.submit()).rejects.toThrow(/Before "meets", the careful look is not complete: Write a VISUAL RESULTS block/)
  await expect(f.submit({ operation_id: OTHER, summary: 'Judged. VISUAL RESULTS: []' })).resolves.toBeTruthy()
  const g = fixture({ visualProblems: () => ['Write a VISUAL RESULTS block.'] })
  await g.readAll()
  await expect(g.submit({ verdict: 'cannot-tell', summary: 'The screen would not start in the copy.' })).resolves.toBeTruthy()
})

it('without the rule wired, a cosmetic refusal is recorded as before', async () => {
  const f = fixture()
  await f.readAll()
  await expect(f.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'Two em dashes.', evidence: 'notes.txt', file: 'notes.txt' }] })).resolves.toBeTruthy()
})

it('a number in the finding, or a file the rule does not know, keeps a cosmetic point blocking', async () => {
  const internal = (p: string): boolean => p === 'notes.txt'
  const digits = fixture({ notesFor: internal })
  await digits.readAll()
  await expect(digits.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'Typo in the notice-period answer: 3 months, should be 1.', evidence: 'notes.txt line 4', file: 'notes.txt' }] })).resolves.toBeTruthy()
  const unknown = fixture({ notesFor: (p) => cosmeticIsNote(fileRole(p, { kind: 'documents' })) })
  await unknown.readAll()
  await expect(unknown.submit({ verdict: 'does-not-meet', findings: [{ severity: 'blocking', statement: 'Two em dashes in the second paragraph.', evidence: 'notes.txt line 2', file: 'notes.txt' }] })).resolves.toBeTruthy()
})
