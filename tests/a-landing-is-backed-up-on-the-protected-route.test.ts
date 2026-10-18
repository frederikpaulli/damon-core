import { afterEach, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

test("after a landing on the protected route the work is committed and pushed, and the repository's hooks never run", async () => {
  vi.resetModules()
  const { protectHostExecution } = await import('../src/main/lib/execution-boundary')
  const { saveWork, saveWorkQueued } = await import('../src/main/lib/git-save')
  const { protectedGitRunner, repositoryGuard } = await import('../src/main/lib/protected-git')
  const dir = mkdtempSync(join(tmpdir(), 'damon-backup-')); dirs.push(dir)
  const remote = join(dir, 'remote.git'), work = join(dir, 'work'), hooks = join(dir, 'no-hooks')
  const marker = join(dir, 'hook-ran.txt').split('\\').join('/')
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env })
  git(dir, 'init', '--bare', '-b', 'main', remote)
  git(dir, 'init', '-b', 'main', work)
  git(work, 'config', 'user.name', 'Damon Test')
  git(work, 'config', 'user.email', 'damon-test@example.com')
  git(work, 'remote', 'add', 'origin', remote)
  writeFileSync(join(work, 'README.md'), 'start\n')
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'start'); git(work, 'push', '-u', 'origin', 'main')
  for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) writeFileSync(join(work, '.git', 'hooks', name), `#!/bin/sh\necho ${name} >> "${marker}"\n`)
  writeFileSync(join(work, 'control.txt'), 'control\n')
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'control')
  expect(existsSync(marker)).toBe(true)
  unlinkSync(marker)

  protectHostExecution()
  await expect(saveWork(work, 'generic')).rejects.toThrow('held')
  mkdirSync(join(work, 'src'), { recursive: true })
  writeFileSync(join(work, 'src', 'rent.rs'), 'pub fn rent() -> u32 { 1 }\n')
  const out = await saveWorkQueued(
    work,
    "Unit price never wipes a customer's own price\n\nSaved by Damon when this job's reviewed work landed.",
    protectedGitRunner(hooks, { protocols: ['file'] }),
    { guard: repositoryGuard(hooks, { address: /.+/ }) }
  )
  expect(out).toMatchObject({ saved: true, pushed: true })
  expect(git(remote, 'log', '-1', '--format=%s', 'main').trim()).toBe("Unit price never wipes a customer's own price")
  expect(git(remote, 'show', 'main:src/rent.rs')).toContain('pub fn rent')
  expect(existsSync(marker)).toBe(false)
  vi.resetModules()
}, 60_000)

test("under Damon's save git still uses the owner's own credential helper", async () => {
  const { hardenedArgs, scrubbedEnv } = await import('../src/main/lib/protected-git')
  const dir = mkdtempSync(join(tmpdir(), 'damon-cred-')); dirs.push(dir)
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true })
  const helper = (args: string[], env: NodeJS.ProcessEnv): string => {
    try { return execFileSync('git', [...args, 'config', '--get-all', 'credential.helper'], { cwd: dir, encoding: 'utf8', windowsHide: true, env }).trim() } catch { return '' }
  }
  expect(helper(hardenedArgs(join(dir, 'no-hooks')), scrubbedEnv())).toBe(helper([], process.env))
})
