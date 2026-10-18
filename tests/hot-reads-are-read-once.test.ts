import { afterEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertExecutionRoot, ExecutionPolicyStore } from '../src/main/lib/execution-policy'
import { CandidateStore, captureCandidateTargets } from '../src/main/lib/candidate-store'
import { globToRegExp } from '../src/shared/scope'
import type { ExecutionPolicyRecord } from '../src/shared/execution-policy'
import type { IsolatedRequest, IsolatedResult } from '../src/main/lib/isolated-worker'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'damon-hot-')); dirs.push(d); return d }

test('a glob is built once and shared', () => {
  expect(globToRegExp('src/**/a.ts')).toBe(globToRegExp('src/**/a.ts'))
  expect(globToRegExp('src/**/a.ts').test('src/a.ts')).toBe(true)
  expect(globToRegExp('src/*.ts').test('src/x/y.ts')).toBe(false)
})

test('the policy is read once per change, each caller gets its own copy, and a save is seen at once', () => {
  const dir = temp(), root = join(dir, 'project'), state = join(dir, 'private')
  mkdirSync(root); mkdirSync(state)
  const store = new ExecutionPolicyStore(state, 'personal')
  store.save({ expectedRevision: 0, enabled: true, contextApproved: true, providers: ['claude'], capabilities: ['worker.run'], inputs: [], folder: true, excluded: [] } as never, root, [])
  const a = store.read()!, b = store.read()!
  expect(a).toEqual(b)
  expect(a).not.toBe(b)
  a.providers.push('openai' as never)
  expect(store.read()!.providers).toEqual(['claude'])
  store.save({ expectedRevision: 1, enabled: true, contextApproved: true, providers: ['claude', 'openai'], capabilities: ['worker.run'], inputs: [], folder: true, excluded: [] } as never, root, [])
  expect(store.read()!.revision).toBe(2)
  expect(store.read()!.providers).toEqual(['claude', 'openai'])
})

test('a folder check that passed is trusted briefly; a refusal is never kept', () => {
  const dir = temp(), root = join(dir, 'project'), other = join(dir, 'project', 'inner')
  mkdirSync(root); mkdirSync(other)
  expect(() => assertExecutionRoot(root, [other])).toThrow(/overlaps/)
  expect(() => assertExecutionRoot(root, [other])).toThrow(/overlaps/)
  const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere)
  expect(assertExecutionRoot(root, [elsewhere])).toBe(assertExecutionRoot(root, [elsewhere]))
})

test('the draft history is read once per change, and a new draft is seen at once', () => {
  const dir = temp(), root = join(dir, 'project'), state = join(dir, 'private')
  mkdirSync(root); mkdirSync(state); writeFileSync(join(root, 'source.txt'), 'approved source')
  const sha = (v: string) => createHash('sha256').update(v).digest('hex')
  const policy: ExecutionPolicyRecord = { version: 1, projectId: 'personal', projectRoot: root, revision: 1, updatedAt: new Date().toISOString(), enabled: true, contextApproved: true, providers: ['claude'], capabilities: ['worker.run'], inputs: [{ path: 'source.txt', sha256: sha('approved source') }] }
  const request: IsolatedRequest = { command: 'node', args: ['-e', 'x'], inputs: policy.inputs, outputs: ['report.txt'], timeoutSeconds: 1 }
  const result = (text: string): IsolatedResult => ({ operationId: randomUUID(), image: 'node@sha256:' + 'a'.repeat(64), dockerExitCode: 0, evidence: 'local-isolated-process', note: 'n', result: { commandExitCode: 0, commandFailed: false, stdout: '', stderr: '', outputs: [{ path: 'report.txt', content: Buffer.from(text).toString('base64') }] } })
  const store = new CandidateStore(state, 'personal', root)
  const targets = captureCandidateTargets(policy, request.outputs)
  store.capture(policy, 'worker', request, targets, result('first'))
  const one = store.read(), two = store.read()
  expect(two).toEqual(one)
  expect(two).not.toBe(one)
  one.push({} as never)
  expect(store.read()).toHaveLength(1)
  store.capture(policy, 'worker', request, targets, result('second'))
  expect(store.read()).toHaveLength(2)
  const file = join(state, 'candidate-files.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('second', 'secomd'))
  utimesSync(file, new Date(), new Date(Date.now() + 5000))
  expect(() => store.read()).toThrow(/damaged/)
})
