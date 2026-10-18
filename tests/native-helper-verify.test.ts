import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const helper = join(__dirname, '..', 'out', 'native', 'Damon.NativeJob.exe')
const claude = join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe')
const runnable = process.platform === 'win32' && existsSync(helper)

function verify(path: string): { status: string; subject?: string; thumbprint?: string } {
  return JSON.parse(execFileSync(helper, ['--verify', path], { encoding: 'utf8', windowsHide: true }))
}

it.skipIf(!runnable || !existsSync(claude))('the installed Claude Code is signed by Anthropic, and the helper says so', () => {
  const result = verify(claude)
  expect(result.status).toBe('valid')
  expect(result.subject).toMatch(/CN="Anthropic, PBC"/)
  expect(result.thumbprint).toMatch(/^[A-F0-9]{40}$/)
})

it.skipIf(!runnable)('a program with no embedded signature is reported as unsigned, not as valid', () => {
  expect(verify(helper).status).toBe('unsigned')
})

it.skipIf(!runnable)('a path that does not exist is a refusal, not a verdict', () => {
  expect(() => verify(join(__dirname, 'no-such-program.exe'))).toThrow()
})
