import { afterEach, expect, test } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterStore } from '../src/main/lib/roster-store'
import { ARCHIVE_FILE, TaskEngine, type AgentRun } from '../src/main/lib/task-engine'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const engineIn = (): { engine: TaskEngine; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-archive-')); dirs.push(dir)
  const run: AgentRun = () => new Promise(() => {})
  return { engine: new TaskEngine(dir, new RosterStore(dir), run, { onTaskUpdate: () => {}, onAgentReport: () => {} }), dir }
}
const line = (o: object): string => JSON.stringify(o) + '\n'

test('the archive answers from an index: last line first, a dropped job stays gone, a torn line is skipped', () => {
  const { engine, dir } = engineIn()
  writeFileSync(join(dir, ARCHIVE_FILE), line({ id: 'a', title: 'first', status: 'approved' }) + '{ torn\n' + line({ id: 'b', title: 'dropped', status: 'queued', dropped: 'not needed' }) + line({ id: 'a', title: 'second', status: 'approved' }))
  expect(engine.archived('a')?.title).toBe('second')
  expect(engine.archived('b')).toBeUndefined()
  expect(engine.archived('b', true)?.title).toBe('dropped')
  expect(engine.archived('nobody')).toBeUndefined()
  appendFileSync(join(dir, ARCHIVE_FILE), line({ id: 'c', title: 'later', status: 'approved' }))
  expect(engine.archived('c')?.title).toBe('later')
  expect(engine.archived('a')).not.toBe(engine.archived('a'))
})

test('hundreds of lookups in a large archive take a moment, not seconds each', () => {
  const { engine, dir } = engineIn()
  const pad = 'x'.repeat(900)
  writeFileSync(join(dir, ARCHIVE_FILE), Array.from({ length: 2000 }, (_, i) => line({ id: `job-${i}`, title: `Job ${i}`, status: 'approved', instructions: pad })).join(''))
  const start = Date.now()
  for (let i = 0; i < 500; i++) expect(engine.archived('not-archived')).toBeUndefined()
  expect(Date.now() - start).toBeLessThan(2000)
})
