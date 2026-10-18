import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectedProjectContext, readShortenedText } from '../src/main/lib/protected-context'
import { captureNativeWorkBasis } from '../src/main/lib/protected-work-basis'
import { readJson, writeJson, corruptCopiesOf } from '../src/main/lib/json-file'
import { agentTaskPrompt } from '../src/main/lib/agent-prompt'
import type { TaskInfo } from '../src/shared/types'

const task = (id: string, status: TaskInfo['status'] = 'approved'): TaskInfo => ({ id, agentId: 'worker', title: id,
  instructions: 'i'.repeat(1000), acceptance: 'a'.repeat(1000), result: 'r'.repeat(1000), feedback: [], reads: [], writes: ['reports/**'], needs: [],
  status, round: 1, createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' })
function world(tasks: TaskInfo[]) {
  const dir = mkdtempSync(join(tmpdir(), 'damon-audit-context-'))
  const save = () => writeJson(join(dir, 'tasks.json'), tasks)
  save(); return { dir, save }
}
describe('canonical context, independent of presentation', () => {
  it('keeps an active worker current when an unrelated task moves it out of the recent five', () => {
    const tasks = [task('active', 'working'), ...Array.from({ length: 4 }, (_, i) => task('other-' + i))]
    const w = world(tasks), guard = captureNativeWorkBasis(w.dir, { id: 'active' }).guard
    tasks.push(task('unrelated')); w.save()
    expect(guard.assertActive).not.toThrow()
    tasks[0].acceptance += ' changed'; w.save()
    expect(guard.assertActive).toThrow(/changed/)
  })
  it('detects changed requirements in a compressed completed task, but ignores its progress', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => task('task-' + i)), w = world(tasks)
    const captured = captureNativeWorkBasis(w.dir)
    const stub = JSON.parse(captured.context).stored['tasks.json'].find((row: any) => row.onlyItsName)
    expect(stub).toBeDefined()
    const changed = tasks.find(row => row.id === stub.id)!
    changed.result = 'new progress'; w.save()
    expect(captured.guard.assertQueued).not.toThrow()
    changed.acceptance = 'Different requirement'; w.save()
    expect(captured.guard.assertQueued).toThrow(/changed/)
  })
  it('retrieves both identity-tier records and omitted collections, with exact paging', () => {
    const tasks = Array.from({ length: 500 }, (_, i) => task('task-' + i)), w = world(tasks)
    const context = JSON.parse(protectedProjectContext(w.dir))
    const stub = context.stored['tasks.json'].find((row: any) => row.onlyItsName)
    expect(JSON.parse(readShortenedText(w.dir, stub.sha256).text)).toEqual(tasks.find(row => row.id === stub.id))
    const omitted = context.projection.omitted['tasks.json']
    let from = 0, text = ''
    for (;;) {
      const page = readShortenedText(w.dir, omitted.sha256, from); text += page.text
      if (page.nextFrom === undefined) break
      from = page.nextFrom
    }
    expect(JSON.parse(text)).toEqual(tasks.slice(0, omitted.omittedEntries))
  }, 30_000)
})
it('preserves distinct corruptions after recovery without duplicating identical backups', () => {
  const w = world([]), file = join(w.dir, 'data.json')
  for (const broken of ['{"first":', '{"second":']) {
    writeFileSync(file, broken)
    readJson(file, []); readJson(file, [])
    writeJson(file, [])
  }
  expect(corruptCopiesOf(file).map(path => readFileSync(path, 'utf8')).sort()).toEqual(['{"first":', '{"second":'])
})
it('carries original instructions and acceptance into a fresh revision', () => {
  const value = task('revision', 'revising')
  value.instructions = 'Use the approved figures from source A and address Acme.'
  const prompt = agentTaskPrompt(value, 'Correct the greeting')
  expect(prompt).toContain(value.instructions)
  expect(prompt).toContain(value.acceptance)
  expect(prompt).toContain('Correct the greeting')
})
