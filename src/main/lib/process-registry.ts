import { execFile, execFileSync } from 'node:child_process'
import { writeJson } from './json-file'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface TrackedProcess {
  pid: number
  match: string
  projectId?: string
  agentId?: string
  startedAt: string
}

const JUDGED_LIVE_MS = 5 * 60_000
const RUNNING_FILE = 'running-processes.json'
const INITIALIZED_FILE = 'running-processes.initialized'

export class ProcessRegistry {
  private live = new Map<number, TrackedProcess>()
  private dir?: string
  private recoveryComplete = false
  private persistenceFailed = false
  private judgedLive = new Map<number, { match: string; at: number }>()

  useDir(dir: string): void {
    if (this.live.size && this.dir !== dir) throw Error('Cannot move an active execution registry.')
    this.dir = dir
    this.recoveryComplete = false
  }

  add(entry: TrackedProcess): void {
    if (this.persistenceFailed) throw Error('Execution tracking needs recovery before admitting another process.')
    this.judgedLive.delete(entry.pid)
    this.live.set(entry.pid, entry)
    this.persist(true)
  }

  assertReadyForNativeExecution(): void {
    if (!this.dir || !this.recoveryComplete || this.persistenceFailed) throw Error('Execution recovery and durable tracking are required before native admission.')
    if (!existsSync(join(this.dir, RUNNING_FILE)) || !existsSync(join(this.dir, INITIALIZED_FILE))) throw Error('Execution recovery records disappeared. Native admission is held.')
  }

  forget(pid: number): void {
    this.judgedLive.delete(pid)
    if (this.live.delete(pid)) this.persist()
  }

  list(): TrackedProcess[] {
    return [...this.live.values()]
  }

  nativeLeftovers(): TrackedProcess[] {
    return this.list().filter((p) => /native-launch-[^\\/]*\.json/.test(p.match) && p.projectId !== 'native_accounts' && p.projectId !== 'native_auth')
  }

  pruneDead(which: (entry: TrackedProcess) => boolean = () => true, readLines = commandLinesOf, alive = stillAlive, now = Date.now()): TrackedProcess[] {
    const candidates = this.list().filter(which)
    const living = candidates.filter((e) => alive(e.pid))
    const dead = candidates.filter((e) => !living.includes(e))
    const fresh = (e: TrackedProcess): boolean => { const j = this.judgedLive.get(e.pid); return !!j && j.match === e.match && now - j.at < JUDGED_LIVE_MS }
    const ask = living.filter((e) => !fresh(e))
    const lines = ask.length ? readLines(ask.map((e) => e.pid)) : new Map<number, string>()
    const reused = ask.filter((e) => { const line = lines.get(e.pid); return line !== undefined && !line.includes(e.match) })
    for (const e of ask) { const line = lines.get(e.pid); if (line !== undefined && line.includes(e.match)) this.judgedLive.set(e.pid, { match: e.match, at: now }) }
    const gone = [...dead, ...reused]
    for (const e of gone) { this.live.delete(e.pid); this.judgedLive.delete(e.pid) }
    if (gone.length) this.persist()
    return gone
  }

  killTree(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return true
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
      }
    } catch {
    }
    if (stillAlive(pid)) return false
    this.forget(pid)
    return true
  }

  killAll(): number {
    const pids = [...this.live.keys()]
    for (const pid of pids) this.killTree(pid)
    return pids.length
  }

  killAllWithin(deadlineMs: number): Promise<number> {
    const pids = [...this.live.keys()]
    if (pids.length === 0) return Promise.resolve(0)
    const all = Promise.all(pids.map((pid) => this.killTreeAsync(pid)))
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadlineMs)))
    return Promise.race([all.then(() => undefined), deadline]).then(() => pids.length)
  }

  killTreeSoon(pid: number): void {
    void this.killTreeAsync(pid)
  }

  private killTreeAsync(pid: number): Promise<void> {
    return new Promise((resolve) => {
      if (!Number.isInteger(pid) || pid <= 0) return resolve()
      const done = (): void => {
        if (!stillAlive(pid)) this.forget(pid)
        resolve()
      }
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], done)
        } else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
            }
          }
          done()
        }
      } catch {
        done()
      }
    })
  }

  killFor(projectId: string, agentId?: string): number {
    const hit = this.list().filter(
      (e) => e.projectId === projectId && (agentId === undefined || e.agentId === agentId)
    )
    for (const e of hit) void this.killTreeAsync(e.pid)
    return hit.length
  }

  sweep(readLines = commandLinesOf, alive = stillAlive): TrackedProcess[] {
    if (!this.dir) return []
    this.recoveryComplete = false
    let recorded: TrackedProcess[]
    try { recorded = JSON.parse(readFileSync(join(this.dir, RUNNING_FILE), 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(join(this.dir, INITIALIZED_FILE))) {
        if (this.live.size) throw Error('Execution records disappeared while processes remain tracked.')
        this.persist(true); this.recoveryComplete = true; return []
      }
      throw Error('The previous execution registry is unreadable. Recovery is required before protected execution.')
    }
    if (!Array.isArray(recorded) || recorded.some(entry => !entry || !Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.match !== 'string' || !entry.match || typeof entry.startedAt !== 'string')) throw Error('The previous execution registry needs recovery.')
    for (const entry of recorded) this.live.set(entry.pid, entry)
    const killed: TrackedProcess[] = []
    const lines = readLines(recorded.map((e) => e.pid))
    for (const entry of recorded) {
      const line = lines.get(entry.pid)
      if (!alive(entry.pid) || (line !== undefined && !isSameProcess(entry, () => line))) { this.live.delete(entry.pid); continue }
      this.live.set(entry.pid, entry)
      if (line !== undefined && this.killTree(entry.pid)) { this.live.delete(entry.pid); killed.push(entry) }
    }
    this.persist(true)
    this.recoveryComplete = this.live.size === 0
    return killed
  }

  private persist(required = false): void {
    if (!this.dir) return
    try {
      writeJson(join(this.dir, RUNNING_FILE), this.list())
      const marker = join(this.dir, INITIALIZED_FILE)
      if (!existsSync(marker)) writeFileSync(marker, 'Damon execution registry initialized. Missing records require recovery.\n', { flag: 'wx' })
      this.persistenceFailed = false
    } catch {
      this.persistenceFailed = true
      if (required) throw Error('Execution tracking could not be persisted. No further execution may be admitted until recovery.')
    }
  }
}

export function isSameProcess(entry: TrackedProcess, readCommandLine = commandLineOf): boolean {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false
  if (entry.match.length === 0) return false
  const live = readCommandLine(entry.pid)
  return live !== null && live.includes(entry.match)
}

export function proveNativeCleanup(registry: ProcessRegistry, live: { projectId: string; callerId: string }[], readLines = commandLinesOf, alive = stillAlive, log: (line: string) => void = () => {}): void {
  registry.assertReadyForNativeExecution()
  const notLive = (p: TrackedProcess): boolean => !live.some((l) => l.projectId === p.projectId && l.callerId === p.agentId)
  const leftovers = (): TrackedProcess[] => registry.nativeLeftovers().filter(notLive)
  const first = leftovers()
  if (!first.length) return
  const pids = new Set(first.map((p) => p.pid))
  registry.pruneDead((p) => pids.has(p.pid), readLines, alive)
  const still = leftovers()
  if (!still.length) return
  for (const p of still) log(`Native helper ${p.pid} is still running for ${p.projectId}/${p.agentId ?? '?'} with no live turn; recovery waits for it.`)
  throw Error('Native process cleanup is still unverified.')
}

function commandLineOf(pid: number): string | null {
  return commandLinesOf([pid]).get(pid) ?? null
}

function commandLinesOf(pids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0)
  if (process.platform !== 'win32' || wanted.length === 0) return out
  try {
    const filter = wanted.map((p) => `ProcessId=${p}`).join(' or ')
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const parsed = JSON.parse(raw.trim() || '[]') as { ProcessId: number; CommandLine: string | null } | { ProcessId: number; CommandLine: string | null }[]
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof row?.CommandLine === 'string' && row.CommandLine.length > 0) out.set(row.ProcessId, row.CommandLine)
    }
  } catch {
  }
  return out
}

export function stillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const processes = new ProcessRegistry()
