// Runs a command in a throwaway Docker container (no network, read-only root, no
// capabilities) over a copy of the approved files. Its output is untrusted until reviewed.
import { MAX_INPUT_FILE_BYTES, MAX_INPUT_TOTAL_BYTES } from '../../shared/execution-policy'
import { spawn, execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, lstatSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { writeJson } from './json-file'
import { resolveInside } from './file-browser'

export const isolatedRequest = z.object({
  command: z.string().min(1).max(300), args: z.array(z.string().max(100_000)).max(80),
  inputs: z.array(z.object({ path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(100),
  outputs: z.array(z.string().min(1).max(500)).max(100),
  timeoutSeconds: z.number().int().min(1).max(120)
}).strict()
export type IsolatedRequest = z.infer<typeof isolatedRequest>
export interface IsolatedResult { operationId: string; image: string; dockerExitCode: number; result: unknown; evidence: 'local-isolated-process'; note: string }

export function workerPath(value: string): string {
  if (!value || value.includes('\\') || /[\x00-\x1f:*?]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Use an exact relative file path without traversal or alternate streams.')
  return value
}
export function workerArguments(name: string, image: string, driver: string): string[] {
  if (!/^node@sha256:[a-f0-9]{64}$/.test(image)) throw Error('The isolated worker needs an approved immutable Node image digest.')
  if (!/^damon-worker-[a-f0-9-]{36}$/.test(name)) throw Error('Invalid worker identity.')
  return ['run', '--rm', '--pull=never', '--name', name, '--label', 'com.damon.worker=isolated-v1', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--tmpfs=/work:rw,nosuid,nodev,size=64m,uid=1000,gid=1000', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000', '--workdir=/work', '--env=HOME=/work', '--env=NODE_OPTIONS=', '-i', image, 'node', '-e', driver]
}

const DRIVER = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
let raw = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 24000000) process.exit(90); });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  for (const file of input.files) { const target = path.join('/work', file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { flag: 'wx' }); }
  for (const file of input.outputs) { const dir = path.dirname(path.join('/work', file)); if (dir === '/work' || dir.startsWith('/work/')) fs.mkdirSync(dir, { recursive: true }); }
  cp.execFile(input.command, input.args, { cwd: '/work', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp' }, timeout: input.timeoutSeconds * 1000, maxBuffer: 1048576 }, (error, stdout, stderr) => {
    const outputs = []; let outputBytes = 0;
    for (const file of input.outputs) {
      try {
        const target = path.join('/work', file), real = fs.realpathSync(target);
        if (!real.startsWith('/work/') || !fs.statSync(real).isFile() || fs.statSync(real).size > 1048576) throw Error('Output is outside the workspace, not a file or too large.');
        const content = fs.readFileSync(real); outputBytes += content.length;
        if (outputBytes > 4194304) throw Error('Output budget exceeded.');
        outputs.push({ path: file, content: content.toString('base64') });
      } catch { outputs.push({ path: file, error: 'Requested output unavailable or refused.' }); }
    }
    process.stdout.write(JSON.stringify({ commandExitCode: error ? error.code ?? null : 0, commandFailed: Boolean(error), stdout, stderr, outputs }));
  });
});`

export class IsolatedWorker {
  private active = new Set<string>()
  private recovery: Promise<void> | undefined
  private uncertain = false
  private settled = new Map<string, string>()
  constructor(private options: { dataDir: string; image: string; dockerPath?: string; readJournal?: (path: string) => Promise<string> }) {}
  private get executable(): string { return this.options.dockerPath ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '/usr/bin/docker') }
  private get config(): string { return join(this.options.dataDir, 'isolated-docker-config') }
  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
    return env
  }
  private daemon: { at: number; up: boolean } | undefined
  async daemonUp(): Promise<boolean> {
    if (this.daemon && Date.now() - this.daemon.at < 20_000) return this.daemon.up
    const up = await new Promise<boolean>(resolve => execFile(this.executable, ['--config', this.config, 'version', '--format', '{{.Server.Version}}'], { env: this.environment(), windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(!error && /\d/.test(String(stdout)))))
    this.daemon = { at: Date.now(), up }
    return up
  }
  async daemonAnswers(tries = 3, gapMs = 5000): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      this.daemon = undefined
      if (await this.daemonUp()) return true
      if (i < tries - 1) await new Promise(resolve => setTimeout(resolve, gapMs))
    }
    return false
  }
  static readonly NOT_RUNNING = 'Docker Desktop is not running, so the isolated worker cannot start. Start Docker Desktop; the job resumes on its own. No host fallback was used.'
  private desktop(args: string[], timeout: number): Promise<boolean> {
    return new Promise(resolve => execFile(this.executable, ['desktop', ...args], { env: process.env, windowsHide: true, timeout, maxBuffer: 256 * 1024 }, error => resolve(!error)))
  }
  static readonly STARTING = 'Waiting for Docker Desktop to answer. Damon starts it when work waits for it, and this job starts on its own when it is up.'
  static readonly NOT_UP_FOR_AGENTS = 'Docker Desktop is not answering yet, so this isolated run cannot start now. Damon starts Docker Desktop itself when work waits for it: this is never the owner\'s to do, so do not ask him or put it on his list. Carry on without the run and mark what needed it as blocked, or try it again in a few minutes. No host fallback was used.'
  async startDesktop(wait: { waitMs?: number; everyMs?: number } = {}): Promise<boolean> {
    const answers = async (): Promise<boolean> => {
      const until = Date.now() + (wait.waitMs ?? 5 * 60_000)
      do {
        this.daemon = undefined
        if (await this.daemonUp()) return true
        await new Promise(resolve => setTimeout(resolve, wait.everyMs ?? 10_000))
      } while (Date.now() < until)
      return false
    }
    await this.desktop(['start'], 180_000)
    if (await answers()) return true
    await this.desktop(['restart'], 240_000)
    return answers()
  }
  unfinishedJournals(): number {
    const dir = join(this.options.dataDir, 'isolated-operations')
    try {
      let open = 0
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        const path = join(dir, f)
        let key: string
        try { const s = statSync(path); key = `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { open += 1; continue }
        if (this.settled.get(f) === key) continue
        try {
          const state = JSON.parse(readFileSync(path, 'utf8')).state
          if (['completed', 'failed', 'stopped'].includes(state)) this.settled.set(f, key)
          else open += 1
        } catch { open += 1 }
      }
      return open
    } catch { return 0 }
  }
  async stopDesktop(): Promise<boolean> {
    if (this.active.size || this.unfinishedJournals() > 0) return false
    const ok = await this.desktop(['stop'], 120_000)
    this.daemon = undefined
    return ok
  }
  private docker(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => execFile(this.executable, ['--config', this.config, ...args], { env: this.environment(), windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(Error('Docker control could not be verified.')) : resolve(stdout)))
  }
  private async remove(name: string): Promise<void> {
    try { await this.docker(['rm', '--force', name]) } catch {}
    const remaining = await this.docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])
    if (remaining.trim()) throw Error('The isolated container is still present.')
  }
  async recover(): Promise<void> {
    if (this.active.size) throw Error('Wait for active isolated operations before recovery.')
    mkdirSync(this.config, { recursive: true }); writeJson(join(this.config, 'config.json'), {})
    const dir = join(this.options.dataDir, 'isolated-operations'); mkdirSync(dir, { recursive: true })
    const readJournal = this.options.readJournal ?? ((p: string) => readFile(p, 'utf8'))
    for (const file of (await readdir(dir)).filter(file => file.endsWith('.json'))) {
      const path = join(dir, file)
      let key: string
      try { const s = await stat(path); key = `${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
      catch { this.uncertain = true; throw Error('An isolated operation journal needs recovery. No new execution was admitted.') }
      if (this.settled.get(file) === key) continue
      let record: { id: string; container: string; state: string }
      try {
        record = JSON.parse(await readJournal(path))
        if (!record || !/^[a-f0-9-]{36}$/.test(record.id) || record.container !== `damon-worker-${record.id}` || file !== `${record.id}.json` || !['prepared', 'created', 'cleanup-uncertain', 'completed', 'failed', 'stopped'].includes(record.state)) throw Error('invalid')
      } catch { this.uncertain = true; throw Error('An isolated operation journal needs recovery. No new execution was admitted.') }
      if (['completed', 'failed', 'stopped'].includes(record.state)) { this.settled.set(file, key); continue }
      try { await this.remove(record.container); writeJson(path, { ...record, state: 'stopped', recoveredAt: new Date().toISOString() }) } catch { this.uncertain = true; throw Error('Previous isolated execution cleanup is uncertain. No new execution was admitted.') }
    }
    this.uncertain = false
  }
  async run(projectId: string, projectPath: string, value: IsolatedRequest, signal?: AbortSignal): Promise<IsolatedResult> {
    const input = isolatedRequest.parse(value)
    if (signal?.aborted) throw Error('Isolated execution was cancelled before admission.')
    if (this.uncertain && !this.active.size) this.recovery = undefined
    if (!this.recovery) this.recovery = this.recover().catch(error => { this.recovery = undefined; throw error })
    await this.recovery
    if (signal?.aborted) throw Error('Isolated execution was cancelled before admission.')
    if (this.uncertain) throw Error('Isolated execution is held until container cleanup is verified.')
    if (!(await this.daemonAnswers())) throw Error(IsolatedWorker.NOT_UP_FOR_AGENTS)
    if (this.active.has(projectId)) throw Error('An isolated operation is already running for this project.')
    if (this.active.size >= 2) throw Error('The isolated worker capacity is in use. Wait for an operation to finish.')
    this.active.add(projectId)
    try {
      let total = 0
      const root = realpathSync(projectPath)
      const files = input.inputs.map(file => {
        const name = workerPath(file.path), target = resolveInside(root, name)
        if (!target) throw Error('An input escapes this project or uses a link.')
        const actual = realpathSync(target), rel = relative(root, actual)
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || lstatSync(target).isSymbolicLink() || !lstatSync(actual).isFile()) throw Error('An input escapes this project or is not a regular file.')
        if (lstatSync(actual).size > MAX_INPUT_FILE_BYTES) throw Error('Each isolated input is limited to 64 MB.')
        const bytes = readFileSync(actual); total += bytes.length
        if (bytes.length > MAX_INPUT_FILE_BYTES) throw Error('Each isolated input is limited to 64 MB.')
        if (total > MAX_INPUT_TOTAL_BYTES) throw Error('The isolated input budget is 256 MB.')
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('An approved input changed. Review the current version before running.')
        return { path: name, content: bytes.toString('base64') }
      })
      input.outputs.forEach(workerPath)
      const id = randomUUID(), name = `damon-worker-${id}`
      const args = workerArguments(name, this.options.image, DRIVER)
      const executable = this.executable, env = this.environment()
      const journal = join(this.options.dataDir, 'isolated-operations', `${id}.json`)
      mkdirSync(dirname(journal), { recursive: true })
      const record = { id, projectId, container: name, image: this.options.image, startedAt: new Date().toISOString(), state: 'prepared' }
      writeJson(journal, record)
      try { await this.docker(['create', ...args.slice(1)]); writeJson(journal, { ...record, state: 'created' }) } catch {
        this.uncertain = true; writeJson(journal, { ...record, state: 'cleanup-uncertain' })
        throw Error('Isolated container creation was not confirmed. Recovery is required; no host fallback was used.')
      }
      if (signal?.aborted) {
        try { await this.remove(name); writeJson(journal, { ...record, state: 'stopped' }) } catch {
          this.uncertain = true; writeJson(journal, { ...record, state: 'cleanup-uncertain' })
          throw Error('Cancelled isolated creation cleanup is uncertain. New work is held.')
        }
        throw Error('Isolated execution was cancelled; its container was removed before start.')
      }
      return await new Promise<IsolatedResult>((resolve, reject) => {
        let stdout = '', stdoutBytes = 0, stderrBytes = 0, settled = false, ending = false
        const decoder = new StringDecoder('utf8')
        const child = spawn(executable, ['--config', this.config, 'start', '--attach', '--interactive', name], { shell: false, windowsHide: true, env })
        const finishError = (message: string): void => {
          if (settled || ending) return
          ending = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          void this.remove(name).then(() => {
            settled = true; child.kill(); writeJson(journal, { ...record, state: 'stopped' }); reject(Error(message + ' The isolated container was removed.'))
          }).catch(() => {
            settled = true; child.kill(); this.uncertain = true
            try { writeJson(journal, { ...record, state: 'cleanup-uncertain' }) } finally { reject(Error(message + ' Cleanup is uncertain; new isolated work is held.')) }
          })
        }
        const timer = setTimeout(() => finishError('Isolated execution exceeded its time limit.'), (input.timeoutSeconds + 5) * 1000)
        const abort = (): void => finishError('Isolated execution was cancelled.')
        signal?.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', chunk => { if (ending || settled) return; stdoutBytes += chunk.length; if (stdoutBytes > 8 * 1024 * 1024) finishError('Isolated output exceeded its limit.'); else stdout += decoder.write(chunk) })
        child.stderr.on('data', chunk => { if (ending || settled) return; stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) finishError('Isolated error output exceeded its limit.') })
        child.on('error', () => finishError('The isolated Docker runtime could not be started. No host fallback was used.'))
        child.stdin.on('error', () => {})
        child.on('close', code => {
          if (settled || ending) return
          if (code !== 0) { finishError('The isolated worker failed or Docker is unavailable. No host fallback was used.'); return }
          let result: unknown
          try { result = JSON.parse(stdout + decoder.end()) } catch { finishError('The isolated worker returned unreadable output.'); return }
          ending = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          void this.remove(name).then(() => {
            writeJson(journal, { ...record, state: 'completed', exitCode: code }); settled = true
            resolve({ operationId: id, image: this.options.image, dockerExitCode: code, result, evidence: 'local-isolated-process', note: 'Worker output is untrusted. This is not independent review, customer acceptance or live integration evidence.' })
          }).catch(() => {
            this.uncertain = true; settled = true
            try { writeJson(journal, { ...record, state: 'cleanup-uncertain' }) } finally { reject(Error('Worker output was received but cleanup could not be verified. New isolated work is held.')) }
          })
        })
        if (signal?.aborted) abort()
        else child.stdin.end(JSON.stringify({ ...input, files }))
      })
    } finally { this.active.delete(projectId) }
  }
}
