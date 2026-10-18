import { afterEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IsolatedWorker } from '../src/main/lib/isolated-worker'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

test('a settled journal is read once; a changed one is read again and still checked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-journals-')); dirs.push(dir)
  const ops = join(dir, 'isolated-operations'); mkdirSync(ops)
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of ids) writeFileSync(join(ops, `${id}.json`), JSON.stringify({ id, container: `damon-worker-${id}`, state: 'completed' }))
  const reads: string[] = []
  const worker = new IsolatedWorker({ dataDir: dir, image: 'node@sha256:' + 'a'.repeat(64), readJournal: async (p) => { reads.push(p); return readFile(p, 'utf8') } })
  await worker.recover()
  expect(reads).toHaveLength(3)
  await worker.recover()
  expect(reads).toHaveLength(3)
  const later = new Date(Date.now() + 5000)
  utimesSync(join(ops, `${ids[0]}.json`), later, later)
  await worker.recover()
  expect(reads).toHaveLength(4)
  writeFileSync(join(ops, `${ids[1]}.json`), '{ torn')
  await expect(worker.recover()).rejects.toThrow('needs recovery')
})
