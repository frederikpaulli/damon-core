import { expect, test } from 'vitest'
import { TaskEngine } from '../src/main/lib/task-engine'
import { taskDefinition } from '../src/main/lib/protected-task-scope'
import type { TaskInfo } from '../src/shared/types'

const job = (): TaskInfo => ({
  id: 'stepB', agentId: 'a1', title: 'Money figures', instructions: 'build', status: 'working',
  reads: ['src-tauri/src/metrics/money_figures.rs'], writes: ['src-tauri/tests/money_figures.rs'],
  workBasis: { files: [{ file: 'src-tauri/src/metrics/money_figures.rs', hash: 'a'.repeat(64) }], evidence: [] }
} as unknown as TaskInfo)
const observe = (task: TaskInfo, file: string): void => {
  TaskEngine.prototype.observeInput.call({ tasks: [task], save: () => {} } as never, task.id, { file, hash: 'b'.repeat(64) })
}

test('reading a file the basis did not name leaves the definition as it was', () => {
  const task = job(), before = JSON.stringify(taskDefinition(task))
  observe(task, 'src-tauri/tests/money_figures.rs')
  observe(task, 'docs/METRICS.md')
  expect(JSON.stringify(taskDefinition(task))).toBe(before)
})
test('the reads and stamps are still kept for the next round', () => {
  const task = job()
  observe(task, 'docs/METRICS.md')
  expect(task.reads).toContain('docs/METRICS.md')
  expect(task.workBasis!.files.find(f => f.file === 'docs/METRICS.md')).toMatchObject({ hash: 'b'.repeat(64), observed: true })
})
test('a read the job already had is not marked as observed', () => {
  const task = job()
  observe(task, 'src-tauri/src/metrics/money_figures.rs')
  expect(task.observedReads).toBeUndefined()
  expect(task.workBasis!.files).toHaveLength(1)
})
test('a real change to the definition still shows', () => {
  const task = job(), before = JSON.stringify(taskDefinition(task))
  task.reads = [...task.reads!, 'docs/STOCKTAKE.md']
  expect(JSON.stringify(taskDefinition(task))).not.toBe(before)
})
