import { expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IsolatedWorker } from '../src/main/lib/isolated-worker'

test('an unfinished isolated run keeps Docker running; a failed start reports false', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'damon-docker-'))
  const worker = new IsolatedWorker({ dataDir, image: 'x', dockerPath: join(dataDir, 'no-such-docker.exe') })
  expect(worker.unfinishedJournals()).toBe(0)
  mkdirSync(join(dataDir, 'isolated-operations'))
  const id = '11111111-1111-4111-8111-111111111111'
  writeFileSync(join(dataDir, 'isolated-operations', `${id}.json`), JSON.stringify({ id, container: `damon-worker-${id}`, state: 'created' }))
  expect(worker.unfinishedJournals()).toBe(1)
  expect(await worker.stopDesktop()).toBe(false)
  expect(await worker.startDesktop({ waitMs: 20, everyMs: 5 })).toBe(false)
})

test('a settled journal is read once; a journal that changes is read again', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'damon-docker-'))
  const worker = new IsolatedWorker({ dataDir, image: 'x', dockerPath: join(dataDir, 'no-such-docker.exe') })
  mkdirSync(join(dataDir, 'isolated-operations'))
  const done = '22222222-2222-4222-8222-222222222222', open = '33333333-3333-4333-8333-333333333333'
  const path = (id: string) => join(dataDir, 'isolated-operations', `${id}.json`)
  writeFileSync(path(done), JSON.stringify({ id: done, container: `damon-worker-${done}`, state: 'completed' }))
  expect(worker.unfinishedJournals()).toBe(0)
  const before = statSync(path(done))
  writeFileSync(path(done), JSON.stringify({ id: done, container: `damon-worker-${done}`, state: 'completeX' }))
  utimesSync(path(done), before.atime, before.mtime)
  expect(worker.unfinishedJournals()).toBe(1)
  writeFileSync(path(open), JSON.stringify({ id: open, container: `damon-worker-${open}`, state: 'created' }))
  expect(worker.unfinishedJournals()).toBe(2)
})
