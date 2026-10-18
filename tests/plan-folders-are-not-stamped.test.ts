import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkNeedsStore } from '../src/main/lib/work-needs-store'

let root: string, state: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plan-root-')); state = mkdtempSync(join(tmpdir(), 'plan-state-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }) })

test('a plan naming a folder can still be snapshotted for review', () => {
  mkdirSync(join(root, 'src-tauri', 'migrations'), { recursive: true })
  writeFileSync(join(root, 'METRICS.md'), 'yield')
  const store = new WorkNeedsStore(state, root)
  store.record({ id: 'money', title: 'Money figures', context: 'Piece 1', outputs: ['METRICS.md', 'src-tauri/migrations'], needs: [] }, 'root')
  const snap = store.reviewSnapshot({ id: 't1', writes: ['METRICS.md'], deliverableIds: ['money'] })
  expect(snap[0]!.verified!.files.map(f => f.file)).toEqual(['METRICS.md'])
})
