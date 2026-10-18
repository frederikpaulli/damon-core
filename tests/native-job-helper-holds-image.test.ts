import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const helper = join(__dirname, '..', 'out', 'native', 'Damon.NativeJob.exe')
const runnable = process.platform === 'win32' && existsSync(helper)
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function launch(): { target: string; nonce: string; child: ReturnType<typeof spawn>; ready: Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'damon-helper-')); dirs.push(dir)
  const target = join(dir, 'target.exe')
  copyFileSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'whoami.exe'), target)
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  const nonce = randomUUID(), spec = join(dir, 'spec.json')
  writeFileSync(spec, JSON.stringify({ executable: target, sha256, arguments: [], cwd: dir, ownerPid: process.pid, nonce }))
  const child = spawn(helper, [spec], { cwd: dir, windowsHide: true })
  const ready = new Promise<void>((resolve, reject) => {
    let seen = ''
    child.stderr!.on('data', (chunk: Buffer) => { seen += chunk.toString(); if (seen.includes(`DAMON_JOB_READY ${nonce}`)) resolve() })
    child.once('close', code => reject(Error(`helper closed with ${code} before handshake: ${seen}`)))
  })
  return { target, nonce, child, ready }
}

it.skipIf(!runnable)('a copied program can be opened for writing when nothing holds it — the control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'damon-helper-')); dirs.push(dir)
  const target = join(dir, 'target.exe')
  copyFileSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'whoami.exe'), target)
  closeSync(openSync(target, 'r+'))
})

it.skipIf(!runnable)('between hashing and starting, the program cannot be opened for writing', async () => {
  const { target, nonce, child, ready } = launch()
  await ready
  expect(() => closeSync(openSync(target, 'r+'))).toThrow(/EBUSY|EPERM|EACCES/)
  child.stdin!.write(nonce + '\n')
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  expect(code).toBe(0)
}, 20000)
