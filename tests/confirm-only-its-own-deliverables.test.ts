import { expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkNeedsStore } from '../src/main/lib/work-needs-store'

test('source: reviewSnapshot takes the job’s own deliverables', async () => {
  const src = (await import('node:fs')).readFileSync(join(process.cwd(), 'src/main/lib/work-needs-store.ts'), 'utf8')
  const body = src.slice(src.indexOf('  reviewSnapshot('), src.indexOf('  confirmReview('))
  expect(body).toContain('return this.forOwnDeliverables(task).map(')
  expect(body).not.toContain('this.forTask(task)')
})
test('forOwnDeliverables leaves out a neighbour plan that only shares a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'damon-own-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/money.rs'), 'fn x() {}')
  const store = new WorkNeedsStore(mkdtempSync(join(tmpdir(), 'damon-own-state-')), root) as unknown as {
    list(): { id: string; taskIds: string[]; outputs: string[] }[]
    forOwnDeliverables(t: { id: string; writes?: string[]; deliverableIds?: string[] }): { id: string }[]
    forTask(t: { id: string; writes?: string[]; deliverableIds?: string[] }): { id: string }[]
  }
  const plans = [{ id: 'MONEY_FIGURES', taskIds: [], outputs: ['src/money.rs'], needs: [] }, { id: 'piece1-money-figures', taskIds: [], outputs: ['src/money.rs'], needs: [] }]
  store.list = () => plans as never
  const job = { id: 'stepB', writes: ['src/money.rs'], deliverableIds: ['MONEY_FIGURES'] }
  expect(store.forTask(job).map(p => p.id)).toEqual(['MONEY_FIGURES', 'piece1-money-figures'])
  expect(store.forOwnDeliverables(job).map(p => p.id)).toEqual(['MONEY_FIGURES'])
})
