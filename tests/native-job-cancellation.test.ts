import { beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const fake = vi.hoisted(() => ({ child: null as any, spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: (...args: any[]) => fake.spawn(...args), execFile: vi.fn(), execFileSync: vi.fn() }))
import { spawnNativeJob } from '../src/main/lib/providers/native-job-process'

beforeEach(() => { fake.spawn.mockReset() })
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'native-job-cancel-')), helperPath = join(cwd, 'synthetic.exe')
  const bytes = 'SYNTHETIC HELPER NEVER EXECUTED'; writeFileSync(helperPath, bytes)
  const registry = { assertReadyForNativeExecution: vi.fn(), add: vi.fn(), forget: vi.fn() }
  const child = Object.assign(new EventEmitter(), {
    pid: 991234, stdin: Object.assign(new EventEmitter(), { write: vi.fn() }), stderr: new EventEmitter(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true })
  })
  fake.child = child; fake.spawn.mockReturnValue(child)
  const options = { helperPath, helperSha256: createHash('sha256').update(bytes).digest('hex'), executable: helperPath, executableSha256: createHash('sha256').update(bytes).digest('hex'), args: [], cwd, env: {}, owner: { projectId: 'personal', agentId: 'worker' } }
  const ready = () => {
    const file = fake.spawn.mock.calls[0][1][0]
    const { nonce } = JSON.parse(readFileSync(file, 'utf8'))
    child.stderr.emit('data', Buffer.from(`DAMON_JOB_READY ${nonce}\r\n`))
  }
  return { options, registry, child, ready }
}

it.skipIf(process.platform !== 'win32')('aborting before the helper handshake sends no native admission acknowledgement', async () => {
  const { options, registry, child, ready } = fixture(), stop = new AbortController()
  const pending = spawnNativeJob({ ...options, signal: stop.signal }, registry as never)
  stop.abort(); ready()
  await expect(pending).rejects.toThrow()
  expect(child.stdin.write).not.toHaveBeenCalled()
  expect(child.kill).toHaveBeenCalled()
  expect(registry.forget).toHaveBeenCalledWith(child.pid)
})

it.skipIf(process.platform !== 'win32')('aborting an admitted job kills its lifetime helper and removes its recovery record on close', async () => {
  const { options, registry, child, ready } = fixture(), stop = new AbortController()
  const pending = spawnNativeJob({ ...options, signal: stop.signal }, registry as never)
  ready(); expect(await pending).toBe(child)
  expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'personal', agentId: 'worker' }))
  expect(child.stdin.write).toHaveBeenCalledTimes(1)
  stop.abort(); await Promise.resolve()
  expect(child.kill).toHaveBeenCalledTimes(1)
  expect(registry.forget).toHaveBeenCalledWith(child.pid)
  const file = fake.spawn.mock.calls[0][1][0]
  expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('native-job-closed')
})

it.skipIf(process.platform !== 'win32')('registration failure handles a late spawn error and scrubs the unadmitted descriptor', async () => {
  const { options, registry, child } = fixture()
  registry.add.mockImplementation(() => { throw Error('synthetic persistence failure') })
  await expect(spawnNativeJob(options, registry as never)).rejects.toThrow('persistence')
  expect(() => child.emit('error', Error('synthetic late spawn failure'))).not.toThrow()
  expect(child.stdin.write).not.toHaveBeenCalled()
  await Promise.resolve()
  const file = fake.spawn.mock.calls[0][1][0]
  expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('native-job-closed')
})

it.skipIf(process.platform !== 'win32')('a helper that exits without its pipes closing is forgotten on exit', async () => {
  const { options, registry, child, ready } = fixture()
  const pending = spawnNativeJob(options, registry as never)
  ready(); expect(await pending).toBe(child)
  child.emit('exit', 0)
  expect(registry.forget).toHaveBeenCalledWith(child.pid)
})
