import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpus } from 'node:os'
import { buildThreadLimits } from '../machine-load'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { CODEX_BROKER_CONFIG, CODEX_BROKER_VERSION } from './codex-broker-channel'
import { COPY_TOOLS, NATIVE_WEB_TOOLS } from '../../../shared/native-tools'
import { classifySigner, nativeSigner, NATIVE_PUBLISHERS, type NativeBuildStatus, type NativeSigner } from '../../../shared/native-trust'
import { resolveInside } from '../file-browser'
import { spawnNativeJob } from './native-job-process'
import { BROKER_CALL_TIMEOUT_MS } from '../../../shared/broker-call-limits'

export type SubscriptionProvider = 'claude' | 'openai'
export interface NativeExecutable { path: string; sha256: string }
export interface SubscriptionStatus { provider: SubscriptionProvider; state: 'signed-in-subscription' | 'sign-in-required' | 'unsupported'; detail: string }
export const CLAUDE_BROKER_VERSION = '2.1.263'
const safeModel = /^[a-zA-Z0-9._-]{1,100}$/

export function nativeSubscriptionEnvironment(provider: SubscriptionProvider, profile: string, systemRoot: string): NodeJS.ProcessEnv {
  if (!isAbsolute(profile) || !isAbsolute(systemRoot)) throw Error('Native runtime paths must be absolute.')
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
    HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    TEMP: join(profile, 'tmp'), TMP: join(profile, 'tmp')
  }
  if (provider === 'claude') Object.assign(env, { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false' })
  else env.CODEX_HOME = profile
  return env
}

export function brokerMcpConfig(url: string, authorization: string): string {
  return JSON.stringify({ mcpServers: { damon_broker: { type: 'http', url, headers: { Authorization: authorization }, timeout: BROKER_CALL_TIMEOUT_MS } } })
}

export const PROGRAM_HASH_FRESH_MS = 24 * 60 * 60_000
type ProgramStat = { size: number; mtimeMs: number; ctimeMs: number; ino: number }
const sameFile = (a: ProgramStat, b: ProgramStat): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
const streamSha256 = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  createReadStream(path, { highWaterMark: 1024 * 1024 }).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
})
export class ProgramHashes {
  private readonly seen = new Map<string, ProgramStat & { at: number; sha256: string }>()
  constructor(
    private readonly hash: (path: string) => string = path => createHash('sha256').update(readFileSync(path)).digest('hex'),
    private readonly now: () => number = Date.now,
    private readonly hashAsync: (path: string) => Promise<string> = streamSha256
  ) {}
  of(path: string): string {
    const stat = statSync(path)
    const seen = this.seen.get(path)
    if (seen && sameFile(seen, stat) && this.now() - seen.at < PROGRAM_HASH_FRESH_MS) return seen.sha256
    const sha256 = this.hash(path)
    this.seen.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, at: this.now(), sha256 })
    return sha256
  }
  async ofAsync(path: string): Promise<string> {
    const before = await statAsync(path)
    const seen = this.seen.get(path)
    if (seen && sameFile(seen, before) && this.now() - seen.at < PROGRAM_HASH_FRESH_MS) return seen.sha256
    const sha256 = await this.hashAsync(path)
    const after = await statAsync(path)
    if (sameFile(before, after)) this.seen.set(path, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino, at: this.now(), sha256 })
    return sha256
  }
}

export class NativeSubscriptionRuntime {
  private readonly executables: Readonly<Record<SubscriptionProvider, Readonly<NativeExecutable>>>
  private readonly jobHelper?: Readonly<NativeExecutable>
  constructor(private readonly dataDir: string, executables: Record<SubscriptionProvider, NativeExecutable>, jobHelper?: NativeExecutable, private readonly trust?: { accepts(provider: SubscriptionProvider, path: string, sha256: string): boolean; read(): { provider: string; reportedVersion: string }[]; policy?(): { claude: boolean; openai: boolean }; accept?(input: { provider: SubscriptionProvider; path: string; expectedSha256: string; reportedVersion: string; replacedSha256: string; replacedVersion: string; under: 'owner-standing-policy'; signer?: NativeSigner }): unknown }) {
    if (process.platform !== 'win32' || !isAbsolute(dataDir)) throw Error('This measured native boundary currently supports Windows only.')
    this.executables = Object.freeze({ claude: Object.freeze({ ...executables.claude }), openai: Object.freeze({ ...executables.openai }) })
    this.jobHelper = jobHelper ? Object.freeze({ ...jobHelper }) : undefined
    for (const entry of Object.values(this.executables)) {
      if (!isAbsolute(entry.path) || !entry.path.toLowerCase().endsWith('.exe') || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('A reviewed native executable identity is required.')
    }
  }
  private readonly hashes = new ProgramHashes()
  private measure(path: string): string { return this.hashes.of(path) }
  async warmHashes(): Promise<void> {
    for (const entry of [this.executables.claude, this.executables.openai, ...(this.jobHelper ? [this.jobHelper] : [])]) {
      try { await this.hashes.ofAsync(entry.path) } catch {}
    }
  }
  private trusted(provider: SubscriptionProvider, path: string, found: string): boolean {
    return found === this.executables[provider].sha256 || !!this.trust?.accepts(provider, path, found)
  }
  private prepare(provider: SubscriptionProvider, verify = true): { path: string; profile: string; env: NodeJS.ProcessEnv; sha256: string } {
    const entry = this.executables[provider]
    if (realpathSync(entry.path).toLowerCase() !== entry.path.toLowerCase()) throw Error('The native program changed. Its boundary needs revalidation.')
    const found = this.measure(entry.path)
    if (verify && !this.trusted(provider, entry.path, found)) throw Error('The native program changed. Its boundary needs revalidation.')
    mkdirSync(this.dataDir, { recursive: true })
    const root = realpathSync(this.dataDir)
    const profile = resolveInside(root, `native-subscriptions/${provider}`)
    if (!profile) throw Error('The native profile location is unsafe.')
    mkdirSync(profile, { recursive: true })
    for (const name of ['tmp', 'runs']) {
      const target = resolveInside(profile, name)
      if (!target) throw Error('A native profile directory uses an unsafe link.')
      mkdirSync(target, { recursive: true })
    }
    const configName = provider === 'claude' ? 'settings.json' : 'config.toml'
    const config = resolveInside(profile, configName)
    if (!config) throw Error('The native profile configuration is unsafe.')
    const expected = provider === 'claude' ? JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }) + '\n' : '# Damon native broker profile. Runtime policy is supplied by the launcher.\n'
    if (existsSync(config)) {
      if (readFileSync(config, 'utf8') !== expected) throw Error('The dedicated native profile configuration changed. Review it before resuming.')
    } else writeFileSync(config, expected, { flag: 'wx' })
    const env = nativeSubscriptionEnvironment(provider, profile, process.env.SystemRoot ?? 'C:\\Windows')
    return { path: entry.path, profile, env, sha256: verify ? found : '' }
  }
  private async query(provider: SubscriptionProvider, args: string[], verify = true): Promise<string> {
    const runtime = this.prepare(provider, verify)
    const sha256 = verify ? runtime.sha256 : this.measure(runtime.path)
    if (!this.jobHelper) throw Error('A verified native lifetime wrapper is required.')
    const cwd = mkdtempSync(join(runtime.profile, 'runs', 'query-'))
    const child = await spawnNativeJob({ helperPath: this.jobHelper.path, helperSha256: this.jobHelper.sha256, executable: runtime.path, executableSha256: sha256, args, cwd, env: runtime.env, owner: { projectId: 'native_accounts', agentId: provider } })
    return new Promise((resolve, reject) => {
      let out = '', err = '', done = false
      const limit = 64 * 1024
      const finish = (ok: boolean): void => {
        if (done) return; done = true; clearTimeout(timer)
        if (ok) resolve(out + '\n' + err); else reject(Error('The native subscription status could not be verified.'))
      }
      const timer = setTimeout(() => { try { child.kill() } catch {} finish(false) }, 15000)
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); if (out.length > limit) { try { child.kill() } catch {} finish(false) } })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); if (err.length > limit) err = err.slice(0, limit) })
      child.once('error', () => finish(false))
      child.once('close', (code: number | null) => finish(code === 0))
    })
  }
  async signer(provider: SubscriptionProvider): Promise<NativeSigner> {
    const helper = this.jobHelper
    if (!helper || !existsSync(helper.path) || this.measure(helper.path) !== helper.sha256) return { status: 'unchecked' }
    const path = this.executables[provider].path
    return new Promise(resolve => execFile(helper.path, ['--verify', path], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { resolve({ status: 'unchecked' }); return }
      try {
        const parsed = JSON.parse(stdout) as { status: string; subject?: string; thumbprint?: string }
        resolve(nativeSigner.parse({ status: parsed.status, ...(parsed.subject ? { subject: parsed.subject } : {}), ...(parsed.thumbprint ? { thumbprint: parsed.thumbprint } : {}) }))
      } catch { resolve({ status: 'unchecked' }) }
    }))
  }
  approvedVersions(provider: SubscriptionProvider): string[] {
    const reviewed = provider === 'claude' ? CLAUDE_BROKER_VERSION : CODEX_BROKER_VERSION
    const accepted = (this.trust?.read() ?? [])
      .filter(entry => entry.provider === provider)
      .map(entry => entry.reportedVersion.replace(/ \(Claude Code\)$/, '').replace(/^codex-cli /, '').trim())
      .filter(Boolean)
    return [...new Set([reviewed, ...accepted])]
  }

  async buildStatus(provider: SubscriptionProvider): Promise<NativeBuildStatus> {
    const entry = this.executables[provider]
    const reviewedVersion = provider === 'claude' ? `${CLAUDE_BROKER_VERSION} (Claude Code)` : `codex-cli ${CODEX_BROKER_VERSION}`
    const base = { provider, path: entry.path, reviewedSha256: entry.sha256, reviewedVersion }
    let found: string
    try {
      if (realpathSync(entry.path).toLowerCase() !== entry.path.toLowerCase()) throw Error('link')
      found = await this.hashes.ofAsync(entry.path)
    } catch {
      return { ...base, state: 'missing', detail: `${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed where Damon expects it, or its path leads somewhere else. Nothing can run through it.` }
    }
    if (found === entry.sha256) return { ...base, state: 'matches-reviewed', foundSha256: found, detail: 'This is the exact build Damon was reviewed against.' }
    let version: string | undefined
    try { version = (await this.query(provider, ['--version'], false)).trim() } catch { version = undefined }
    if (this.trust?.accepts(provider, entry.path, found)) {
      return { ...base, state: 'owner-accepted', foundSha256: found, ...(version ? { foundVersion: version } : {}), detail: `You accepted this build${version ? ` (${version})` : ''}. It is not the one Damon was reviewed against.` }
    }
    if (!version) return { ...base, state: 'unrecognised', foundSha256: found, detail: 'The program at that path is not the reviewed build and will not say what it is. It has not been used.' }
    const signer = await this.signer(provider)
    const signature = classifySigner(provider, signer), signed = { signature, ...(signer.subject ? { signerSubject: signer.subject } : {}) }
    const name = provider === 'claude' ? 'Claude Code' : 'Codex'
    if (this.trust?.policy?.()[provider]) {
      try {
        this.trust.accept?.({ provider, path: entry.path, expectedSha256: found, reportedVersion: version, replacedSha256: entry.sha256, replacedVersion: reviewedVersion, under: 'owner-standing-policy', signer })
        return { ...base, ...signed, state: 'owner-accepted', foundSha256: found, foundVersion: version, detail: `${name} updated itself to ${version}, signed by ${NATIVE_PUBLISHERS[provider]}, and you have asked Damon to keep up with these updates. Nobody looked at this build.` }
      } catch {}
    }
    const because = signature === 'valid-expected-publisher' ? '' : signature === 'unsigned' ? ' It is not signed, so the update policy did not take it.' : signature === 'invalid' ? ' Its signature is not one Windows accepts, so the update policy did not take it.' : signature === 'valid-other-publisher' ? ` It is signed by someone other than ${NATIVE_PUBLISHERS[provider]}, so the update policy did not take it.` : ' Its signature could not be checked, so the update policy did not take it.'
    return {
      ...base, ...signed, state: 'update-pending-review', foundSha256: found, foundVersion: version,
      detail: `${name} updated itself to ${version}. Damon checks the exact program it was reviewed against (${reviewedVersion}), so it has not used this one.${because} Accept it to carry on.`
    }
  }

  async signOut(provider: SubscriptionProvider): Promise<void> {
    await this.query(provider, provider === 'claude' ? ['auth', 'logout'] : ['logout'])
  }

  async status(provider: SubscriptionProvider): Promise<SubscriptionStatus> {
    try { this.prepare(provider) }
    catch {
      const build = await this.buildStatus(provider)
      if (build.state !== 'owner-accepted') {
        return { provider, state: 'unsupported', detail: build.state === 'update-pending-review' || build.state === 'unrecognised' ? build.detail : 'The reviewed native program or dedicated profile is unavailable or changed. Review setup before signing in.' }
      }
      try { this.prepare(provider) }
      catch { return { provider, state: 'unsupported', detail: 'The reviewed native program or dedicated profile is unavailable or changed. Review setup before signing in.' } }
    }
    try {
      const version = (await this.query(provider, ['--version'])).trim()
      const reviewedVersion = provider === 'claude' ? `${CLAUDE_BROKER_VERSION} (Claude Code)` : `codex-cli ${CODEX_BROKER_VERSION}`
      const acceptedVersion = this.trust?.read().some(entry => entry.provider === provider && entry.reportedVersion === version)
      if (version !== reviewedVersion && !acceptedVersion) return { provider, state: 'unsupported', detail: `This is ${version}; the reviewed build is ${reviewedVersion}. Accept the update in Accounts to use it.` }
      if (provider === 'claude') {
        const state = JSON.parse(await this.query(provider, ['auth', 'status']))
        if (state.loggedIn === true && state.authMethod === 'claude.ai') return { provider, state: 'signed-in-subscription', detail: 'Native Claude subscription sign-in is available.' }
      } else {
        const status = (await this.query(provider, ['login', 'status'])).trim()
        if (status === 'Logged in using ChatGPT') return { provider, state: 'signed-in-subscription', detail: 'Native ChatGPT subscription sign-in is available.' }
      }
      return { provider, state: 'sign-in-required', detail: 'Sign in through the native provider in the dedicated Damon profile.' }
    } catch { return { provider, state: 'sign-in-required', detail: 'The native subscription is unavailable or its profile needs review. No API fallback is enabled.' } }
  }
  async launchSignIn(provider: SubscriptionProvider, signal: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    signal.throwIfAborted()
    const version = (await this.query(provider, ['--version'])).trim()
    if (!this.approvedVersions(provider).some(approved => version === (provider === 'claude' ? `${approved} (Claude Code)` : `codex-cli ${approved}`))) throw Error('The native version needs boundary revalidation.')
    signal.throwIfAborted()
    const runtime = this.prepare(provider), cwd = mkdtempSync(join(runtime.profile, 'runs', 'signin-'))
    const args = provider === 'claude'
      ? ['auth', 'login', '--claudeai']
      : ['app-server', ...Object.entries(CODEX_BROKER_CONFIG).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])]
    if (!this.jobHelper) throw Error('A verified native lifetime wrapper is required.')
    return spawnNativeJob({ helperPath: this.jobHelper.path, helperSha256: this.jobHelper.sha256, executable: runtime.path, executableSha256: runtime.sha256, args, cwd, env: runtime.env, owner: { projectId: 'native_auth', agentId: provider }, signal })
  }
  async launchClaude(request: { model: string; maxTurns?: number; endpoint: { type: 'http'; url: string; headers: { Authorization: string } }; tools: string[]; nativeTools?: string[]; owner: { projectId: string; agentId: string }; systemAppend?: string; pinnedRun?: string; copy?: { cwd: string; env: Record<string, string> } }, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    signal?.throwIfAborted()
    const input = { ...request, tools: [...request.tools], nativeTools: [...(request.nativeTools ?? [])], owner: { ...request.owner }, endpoint: { ...request.endpoint, headers: { ...request.endpoint.headers } } }
    if (!safeModel.test(input.model) || input.tools.some(tool => !/^[a-z][a-z0-9_]{0,79}$/.test(tool))) throw Error('Invalid Claude broker configuration.')
    const copy = request.copy && isAbsolute(request.copy.cwd) && existsSync(request.copy.cwd) ? { cwd: request.copy.cwd, env: { ...request.copy.env } } : undefined
    const allowedNative: readonly string[] = copy ? [...NATIVE_WEB_TOOLS, ...COPY_TOOLS] : NATIVE_WEB_TOOLS
    if (input.nativeTools.some(tool => !allowedNative.includes(tool))) throw Error('Invalid Claude broker configuration.')
    const maxTurns = input.maxTurns ?? 100
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 150) throw Error('Invalid Claude turn limit.')
    const url = new URL(input.endpoint.url)
    if (input.endpoint.type !== 'http' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password || !/^Bearer [a-f0-9]{64}$/.test(input.endpoint.headers.Authorization)) throw Error('Only the private broker endpoint is allowed.')
    await this.requireSubscription('claude')
    signal?.throwIfAborted()
    const runtime = this.prepare('claude')
    const cwd = copy ? copy.cwd : request.pinnedRun && /^[a-z0-9-]{1,80}$/i.test(request.pinnedRun) ? join(runtime.profile, 'runs', request.pinnedRun) : mkdtempSync(join(runtime.profile, 'runs', 'run-'))
    mkdirSync(cwd, { recursive: true })
    const systemAppendFile = request.systemAppend ? join(copy ? mkdtempSync(join(runtime.profile, 'runs', 'run-')) : cwd, 'system-append.txt') : undefined
    if (systemAppendFile) writeFileSync(systemAppendFile, request.systemAppend!, 'utf8')
    const settings = join(runtime.profile, 'settings.json')
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', input.model,
      '--tools', input.nativeTools.join(','),
      '--allowedTools', [...input.tools.map(tool => `mcp__damon_broker__${tool}`), ...input.nativeTools].join(','),
      '--strict-mcp-config', '--mcp-config', brokerMcpConfig(url.href, input.endpoint.headers.Authorization),
      '--setting-sources', '', '--settings', settings, '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--max-turns', String(maxTurns),
      ...(copy ? ['--disallowedTools', 'Bash(git:*),Bash(git *)'] : []),
      ...(systemAppendFile ? ['--append-system-prompt-file', systemAppendFile, '--exclude-dynamic-system-prompt-sections'] : [])]
    if (!this.jobHelper) throw Error('A verified native lifetime wrapper is required.')
    const env = copy ? { ...runtime.env, ...copyEnvironment(), ...copy.env } : runtime.env
    return spawnNativeJob({ helperPath: this.jobHelper.path, helperSha256: this.jobHelper.sha256, executable: runtime.path, executableSha256: runtime.sha256, args, cwd, env, owner: input.owner, signal })
  }
  async launchCodex(requestOwner: { projectId: string; agentId: string }, signal?: AbortSignal): Promise<{ child: ChildProcessWithoutNullStreams; cwd: string }> {
    signal?.throwIfAborted()
    const owner = { ...requestOwner }
    await this.requireSubscription('openai')
    signal?.throwIfAborted()
    const runtime = this.prepare('openai'), cwd = mkdtempSync(join(runtime.profile, 'runs', 'run-'))
    const args = ['app-server', ...Object.entries(CODEX_BROKER_CONFIG).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])]
    if (!this.jobHelper) throw Error('A verified native lifetime wrapper is required.')
    return { child: await spawnNativeJob({ helperPath: this.jobHelper.path, helperSha256: this.jobHelper.sha256, executable: runtime.path, executableSha256: runtime.sha256, args, cwd, env: runtime.env, owner, signal }), cwd }
  }
  private async requireSubscription(provider: SubscriptionProvider): Promise<void> {
    const status = await this.status(provider)
    if (status.state === 'unsupported') throw Error(`The native program cannot be used: ${status.detail} No model call or API fallback was admitted.`)
    if (status.state !== 'signed-in-subscription') throw Error('Native subscription authentication is required. No model call or API fallback was admitted.')
  }
}

export function copyEnvironment(source: NodeJS.ProcessEnv = process.env, logicalCores = cpus().length): Record<string, string> {
  const home = source.USERPROFILE ?? '', local = source.LOCALAPPDATA ?? ''
  const out: Record<string, string> = { ...buildThreadLimits(logicalCores) }
  const path = source.PATH ?? source.Path
  if (path) out.PATH = path
  if (home) { out.CARGO_HOME = source.CARGO_HOME ?? join(home, '.cargo'); out.RUSTUP_HOME = source.RUSTUP_HOME ?? join(home, '.rustup') }
  if (local) out.npm_config_cache = join(local, 'npm-cache')
  for (const key of ['PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (source[key]) out[key] = source[key]!
  return out
}
