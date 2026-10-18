import { expect, test } from 'vitest'
import { noteRunning, startFreezeWatch } from '../src/main/lib/freeze-watch'

test('a stall over the threshold is recorded with what started during it; a short one is not', async () => {
  const lines: string[] = []
  const stop = startFreezeWatch({ thresholdMs: 300, tickMs: 50, append: (l) => lines.push(l) })
  try {
    await new Promise((r) => setTimeout(r, 120))
    noteRunning('write:tasks.json')
    const until = performance.now() + 600
    while (performance.now() < until) {}
    await new Promise((r) => setTimeout(r, 150))
    noteRunning('ipc:yourTurn:list')
    await new Promise((r) => setTimeout(r, 150))
  } finally { stop() }
  expect(lines).toHaveLength(1)
  const rec = JSON.parse(lines[0]!) as { ms: number; during: string[]; at: string }
  expect(rec.ms).toBeGreaterThanOrEqual(300)
  expect(rec.during).toContain('write:tasks.json')
  expect(rec.during).not.toContain('ipc:yourTurn:list')
})
