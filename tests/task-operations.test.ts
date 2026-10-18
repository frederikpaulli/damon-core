import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskOperationStore, canonical, findTaskByOperation, payloadFingerprint } from '../src/main/lib/task-operations'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ID = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'damon-task-operations-')); dirs.push(base)
  const state = join(base, 'private'); mkdirSync(state)
  return { state, file: join(state, 'task-operations.json'), store: new TaskOperationStore(state, 'personal') }
}
const receipt = { taskId: 'task-1', agentId: 'agent-1', title: 'Build the importer', status: 'queued' }

it('a lost reply is answered with the original receipt, not a second job', () => {
  const f = fixture(), print = payloadFingerprint({ agentId: 'agent-1', title: 'Build the importer' })
  expect(f.store.lookup(ID, 'root', print)).toEqual({ state: 'new' })
  expect(f.store.reserve(ID, 'root', 'assign', print).state).toBe('reserved')
  expect(f.store.lookup(ID, 'root', print).state).toBe('reserved')
  f.store.complete(ID, 'root', receipt)
  const replay = f.store.lookup(ID, 'root', print)
  expect(replay.state).toBe('created')
  expect(replay.state === 'created' && replay.receipt).toMatchObject(receipt)
  expect(replay.state === 'created' && Number.isFinite(Date.parse(replay.receipt.at))).toBe(true)
  expect(() => f.store.reserve(ID, 'root', 'assign', print)).toThrow(/already complete/)
})

it('the same identity cannot be reused for a different request or by another caller', () => {
  const f = fixture(), print = payloadFingerprint({ agentId: 'agent-1', title: 'Build the importer' })
  f.store.reserve(ID, 'root', 'assign', print)
  const changed = payloadFingerprint({ agentId: 'agent-1', title: 'Build something else' })
  expect(() => f.store.lookup(ID, 'root', changed)).toThrow(/different request/)
  expect(() => f.store.reserve(ID, 'root', 'assign', changed)).toThrow(/different request/)
  expect(() => f.store.lookup(ID, 'lead-2', print)).toThrow(/another caller/)
  expect(() => f.store.reserve(ID, 'lead-2', 'assign', print)).toThrow(/different request/)
  expect(() => f.store.complete(ID, 'lead-2', receipt)).toThrow(/unavailable/)
  expect(f.store.read()).toHaveLength(1)
})

it('a fingerprint ignores key order and absent fields but not meaning', () => {
  const a = payloadFingerprint({ title: 'x', agentId: 'a', writes: ['src/**'], waitsFor: undefined })
  expect(payloadFingerprint({ agentId: 'a', writes: ['src/**'], title: 'x' })).toBe(a)
  expect(payloadFingerprint({ agentId: 'a', writes: ['src/**'], title: 'x', waitsFor: undefined })).toBe(a)
  expect(payloadFingerprint({ agentId: 'a', writes: ['src/**'], title: 'X' })).not.toBe(a)
  expect(payloadFingerprint({ agentId: 'a', writes: ['tests/**', 'src/**'], title: 'x' })).not.toBe(a)
  expect(payloadFingerprint({ agentId: 'a', writes: ['src/**'], title: 'x', waitsFor: [] })).not.toBe(a)
  expect(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toEqual({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 })
})

it('one identity cannot record two different results', () => {
  const f = fixture(), print = payloadFingerprint({ title: 'x' })
  f.store.reserve(ID, 'root', 'assign', print)
  f.store.complete(ID, 'root', receipt)
  expect(f.store.complete(ID, 'root', { ...receipt })).toMatchObject({ state: 'created' })
  expect(() => f.store.complete(ID, 'root', { ...receipt, taskId: 'task-2' })).toThrow(/different result/)
  expect(() => f.store.complete(OTHER, 'root', receipt)).toThrow(/unavailable/)
})

it.each([
  ['{broken', 'unparseable'],
  ['{"version":1,"projectId":"personal","records":[],"__proto__":{"x":1}}', 'prototype key'],
  ['{"version":2,"projectId":"personal","records":[]}', 'unsupported version'],
  ['{"version":1,"projectId":"client","records":[]}', 'foreign project'],
  [`{"version":1,"projectId":"personal","records":[{"version":1,"id":"${ID}","projectId":"personal","callerId":"root","kind":"assign","fingerprint":"${'a'.repeat(64)}","state":"created","reservedAt":"2026-09-09T00:00:00.000Z"}]}`, 'created without a receipt'],
  [`{"version":1,"projectId":"personal","records":[{"version":1,"id":"${ID}","projectId":"personal","callerId":"root","kind":"assign","fingerprint":"${'a'.repeat(64)}","state":"reserved","reservedAt":"2026-09-09T00:00:00.000Z","receipt":{"taskId":"t","agentId":"a","title":"t","status":"queued","at":"2026-09-09T00:00:00.000Z"}}]}`, 'reserved carrying a receipt'],
  [`{"version":1,"projectId":"personal","records":[{"version":1,"id":"${ID}","projectId":"personal","callerId":"root","kind":"assign","fingerprint":"${'a'.repeat(64)}","state":"reserved","reservedAt":"2026-09-09T00:00:00.000Z"},{"version":1,"id":"${ID}","projectId":"personal","callerId":"root","kind":"assign","fingerprint":"${'b'.repeat(64)}","state":"reserved","reservedAt":"2026-09-09T00:00:00.000Z"}]}`, 'duplicate identity']
])('damaged receipts fail closed and are preserved (%s)', (raw, _why) => {
  const f = fixture(); writeFileSync(f.file, raw)
  const print = payloadFingerprint({ title: 'x' })
  expect(() => f.store.read()).toThrow(/damaged/)
  expect(() => f.store.lookup(ID, 'root', print)).toThrow(/damaged/)
  expect(() => f.store.reserve(ID, 'root', 'assign', print)).toThrow(/damaged/)
  expect(() => f.store.complete(ID, 'root', receipt)).toThrow(/damaged/)
  expect(readFileSync(f.file, 'utf8')).toBe(raw)
})

it('a full receipt window archives without forgetting old operations after restart', () => {
  const f = fixture()
  const records = Array.from({ length: 500 }, (_, index) => ({
    version: 1, id: `${index.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`,
    projectId: 'personal', callerId: 'root', kind: 'assign', fingerprint: 'a'.repeat(64),
    state: 'reserved', reservedAt: '2026-09-09T00:00:00.000Z'
  }))
  writeFileSync(f.file, JSON.stringify({ version: 1, projectId: 'personal', records }, null, 2))
  expect(f.store.read()).toHaveLength(500)
  expect(() => f.store.reserve(ID, 'root', 'assign', payloadFingerprint({ title: 'x' }))).not.toThrow()
  expect(f.store.lookup(records[0]!.id, 'root', 'a'.repeat(64)).state).toBe('reserved')
  expect(new TaskOperationStore(f.state, 'personal').lookup(records[0]!.id, 'root', 'a'.repeat(64)).state).toBe('reserved')
  expect(f.store.read()).toHaveLength(501)
})

it('refuses a malformed identity and an oversized book', () => {
  const f = fixture()
  expect(() => f.store.reserve('not-a-uuid', 'root', 'assign', payloadFingerprint({}))).toThrow()
  expect(() => f.store.reserve('AABBCCDD-2222-4333-8444-555555555555', 'root', 'assign', payloadFingerprint({}))).toThrow()
  writeFileSync(f.file, ' '.repeat(4 * 1024 * 1024 + 1))
  expect(() => f.store.read()).toThrow(/damaged|recovery/)
})

it('finds a job that has already been archived, so a retry cannot recreate it', () => {
  const f = fixture(), archive = join(f.state, 'tasks-done.jsonl')
  const live = [{ id: 'live-1', operationId: OTHER }]
  expect(findTaskByOperation(live, archive, ID)).toBeUndefined()
  expect(findTaskByOperation(live, archive, OTHER)).toMatchObject({ id: 'live-1' })
  writeFileSync(archive, [
    JSON.stringify({ id: 'gone-1', operationId: 'aaaaaaaa-2222-4333-8444-555555555555', dropped: 'superseded' }),
    '{ torn line',
    '',
    JSON.stringify({ id: 'gone-2', operationId: ID, status: 'approved' })
  ].join('\n') + '\n')
  expect(findTaskByOperation(live, archive, ID)).toMatchObject({ id: 'gone-2' })
  expect(findTaskByOperation(live, archive, '00000000-2222-4333-8444-555555555555')).toBeUndefined()
  expect(findTaskByOperation(live, archive, OTHER)).toMatchObject({ id: 'live-1' })
})

it('an unreadable archive is an unknown, never a proof that nothing was created', () => {
  const f = fixture()
  const archive = join(f.state, 'tasks-done.jsonl'); mkdirSync(archive)
  expect(() => findTaskByOperation([], archive, ID)).toThrow(/could not be read/)
})
