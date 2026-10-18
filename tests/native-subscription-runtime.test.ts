import { expect, it } from 'vitest'
import { nativeSubscriptionEnvironment, NativeSubscriptionRuntime } from '../src/main/lib/providers/native-subscription-runtime'
import { join } from 'node:path'

it('constructs an explicit private native environment without inherited model keys, hooks or paths', () => {
  const profile = join(process.cwd(), 'synthetic-native-profile')
  const env = nativeSubscriptionEnvironment('openai', profile, process.env.SystemRoot ?? process.cwd())
  expect(Object.keys(env).sort()).toEqual(['APPDATA', 'CODEX_HOME', 'HOME', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'].sort())
  expect(env.CODEX_HOME).toBe(profile)
  expect(env.PATH).toBe(join(process.env.SystemRoot ?? process.cwd(), 'System32'))
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  const claude = nativeSubscriptionEnvironment('claude', profile, process.env.SystemRoot ?? process.cwd())
  expect(claude.CLAUDE_CONFIG_DIR).toBe(profile); expect(claude.ENABLE_TOOL_SEARCH).toBe('false'); expect(claude.CODEX_HOME).toBeUndefined()
})

it('refuses wrapper commands and unreviewed executable identities', () => {
  const executable = { path: 'codex.cmd', sha256: '0'.repeat(64) }
  expect(() => new NativeSubscriptionRuntime(process.cwd(), { claude: executable, openai: executable })).toThrow()
})

it('hashes an unchanged program once, and again when it changes or a day passes', async () => {
  const { mkdtempSync, writeFileSync, statSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { ProgramHashes, PROGRAM_HASH_FRESH_MS } = await import('../src/main/lib/providers/native-subscription-runtime')
  const file = join(mkdtempSync(join(tmpdir(), 'damon-program-')), 'claude.exe')
  writeFileSync(file, 'build one')
  let clock = 1_000_000, hashed = 0
  const hashes = new ProgramHashes(() => { hashed += 1; return 'h' + hashed }, () => clock)
  expect(hashes.of(file)).toBe('h1')
  clock += 60_000
  expect(hashes.of(file)).toBe('h1')
  expect(hashed).toBe(1)
  const before = statSync(file)
  writeFileSync(file, 'build two')
  utimesSync(file, before.atime, before.mtime)
  expect(hashes.of(file)).toBe('h2')
  clock += PROGRAM_HASH_FRESH_MS
  expect(hashes.of(file)).toBe('h3')
})
