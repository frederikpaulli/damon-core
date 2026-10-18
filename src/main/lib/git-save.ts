import { execFile } from 'node:child_process'
import { assertHostExecutionAllowed } from './execution-boundary'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type GitRun = (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>
export type RepoGuard = (cwd: string, run: GitRun) => Promise<string | null>

export interface SaveOutcome {
  saved: boolean
  pushed: boolean
  unpushed?: number
  reason?: 'no-git' | 'no-remote' | 'nothing-changed' | 'secret-found' | 'failed'
  detail?: string
  attempts?: number
}

export async function saveWork(cwd: string, note: string, run: GitRun = realGit, guard?: RepoGuard): Promise<SaveOutcome> {
  const no = (reason: SaveOutcome['reason'], detail?: string): SaveOutcome => ({
    saved: false,
    pushed: false,
    reason,
    detail
  })

  const inRepo = await run(['rev-parse', '--is-inside-work-tree'], cwd)
  if (!inRepo.ok) return no('no-git')

  const remote = await run(['remote'], cwd)
  if (!remote.ok || remote.out.trim().length === 0) return no('no-remote')

  if (guard) {
    const refused = await guard(cwd, run)
    if (refused) return no('failed', refused)
  }

  const status = await run(['status', '--porcelain'], cwd)
  if (!status.ok) return no('failed', status.out)
  if (status.out.trim().length === 0) return no('nothing-changed')

  const staged = await run(['add', '-A'], cwd)
  if (!staged.ok) return no('failed', staged.out)

  const diff = await run(['diff', '--cached', '-U0', '--no-renames', '--diff-filter=AMT', '--no-color'], cwd)
  if (!diff.ok) {
    await run(['reset'], cwd)
    if (isLockError(diff.out)) return no('failed', diff.out)
    return no('failed', 'The changes were too large to check for secrets, so nothing was saved.')
  }
  const found = looksLikeSecret(diff.out)
  if (found) {
    await run(['reset'], cwd)
    return no(
      'secret-found',
      `Something that looks like a ${found} was about to be uploaded, so nothing was saved. Take it out of the file and put it in a connection instead, then this will save on its own next time.`
    )
  }

  const committed = await run(['commit', '-m', note], cwd)
  if (!committed.ok) {
    await run(['reset'], cwd)
    return no('failed', committed.out)
  }

  const pushed = await run(['push'], cwd)
  if (pushed.ok) return { saved: true, pushed: true }

  const behind = await run(['rev-list', '--count', '@{upstream}..HEAD'], cwd)
  const counted = behind.ok ? Number.parseInt(behind.out.trim(), 10) : Number.NaN
  const unpushed = Number.isFinite(counted) && counted >= 1 ? counted : 1
  return { saved: true, pushed: false, unpushed, detail: firstErrorLine(pushed.out) }
}

export type Sleep = (ms: number) => Promise<void>

export interface QueueOptions {
  sleep?: Sleep
  delaysMs?: number[]
  staleLockMs?: number
  now?: () => number
  guard?: RepoGuard
}

const DEFAULT_DELAYS_MS = [5_000, 20_000, 60_000]
const STALE_LOCK_MS = 10 * 60_000

interface Waiting {
  notes: string[]
  promise: Promise<SaveOutcome>
  settle: (outcome: SaveOutcome) => void
}

interface Lane {
  next: Waiting | null
}

const lanes = new Map<string, Lane>()

export function saveWorkQueued(
  cwd: string,
  note: string,
  run: GitRun = realGit,
  options: QueueOptions = {}
): Promise<SaveOutcome> {
  const key = resolve(cwd).toLowerCase()
  const busy = lanes.get(key)
  if (busy) {
    if (!busy.next) busy.next = waiting()
    if (!busy.next.notes.includes(note)) busy.next.notes.push(note)
    return busy.next.promise
  }

  const lane: Lane = { next: null }
  lanes.set(key, lane)
  const first = waiting()
  first.notes.push(note)

  void (async () => {
    let current = first
    for (;;) {
      const outcome = await saveWithRetries(cwd, current.notes.join('\n\n'), run, options).catch(
        (err: unknown): SaveOutcome => ({
          saved: false,
          pushed: false,
          reason: 'failed',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
      const following = lane.next
      lane.next = null
      if (!following) lanes.delete(key)
      current.settle(outcome)
      if (!following) return
      current = following
    }
  })()

  return first.promise
}

function waiting(): Waiting {
  let settle!: (outcome: SaveOutcome) => void
  const promise = new Promise<SaveOutcome>((r) => {
    settle = r
  })
  return { notes: [], promise, settle }
}

async function saveWithRetries(cwd: string, note: string, run: GitRun, options: QueueOptions): Promise<SaveOutcome> {
  const sleep = options.sleep ?? realSleep
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS
  const staleAfter = options.staleLockMs ?? STALE_LOCK_MS
  const now = options.now ?? Date.now

  let attempts = 0
  let pauses = 0
  let removedALock = false
  for (;;) {
    attempts += 1
    const outcome = await saveWork(cwd, note, run, options.guard)
    if (!(outcome.reason === 'failed' && isLockError(outcome.detail))) return { ...outcome, attempts }

    if (!removedALock && removeStaleLock(cwd, staleAfter, now)) {
      removedALock = true
      continue
    }
    if (pauses < delays.length) {
      await sleep(delays[pauses]!)
      pauses += 1
      continue
    }
    return { ...outcome, attempts }
  }
}

function isLockError(detail: string | undefined): boolean {
  if (!detail) return false
  return /index\.lock/i.test(detail) || /Unable to create '.*\.lock': File exists/i.test(detail)
}

function removeStaleLock(cwd: string, staleAfterMs: number, now: () => number): boolean {
  const lock = join(cwd, '.git', 'index.lock')
  let ageMs: number
  try {
    ageMs = now() - statSync(lock).mtimeMs
  } catch {
    return false
  }
  if (ageMs < staleAfterMs) return false
  try {
    unlinkSync(lock)
  } catch {
    return false
  }
  return !existsSync(lock)
}

function firstErrorLine(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const flagged = lines.find((l) => /^(fatal|error):/i.test(l) || l.startsWith('!'))
  return (flagged ?? lines[0] ?? '').slice(0, 300)
}

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SECRETS: { what: string; pattern: RegExp }[] = [
  { what: 'private key file', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { what: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { what: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { what: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { what: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { what: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    what: 'password or key written into a file',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i
  }
]

export function lineLooksLikeSecret(text: string): string | null {
  for (const { what, pattern } of SECRETS) if (pattern.test(text)) return what
  return null
}

export function looksLikeSecret(diff: string): string | null {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  for (const { what, pattern } of SECRETS) if (pattern.test(added)) return what
  return null
}

const MAX_OUTPUT = 64 * 1024 * 1024
const realGit: GitRun = (args, cwd) =>
  new Promise((resolve) => {
    assertHostExecutionAllowed('Repository hooks, filters and publication')
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      const tooMuch = (err as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      resolve({
        ok: !err,
        out: tooMuch ? `git ${args[0] ?? ''} printed more than 64 MB, which is more than can be read` : `${stdout ?? ''}${stderr ?? ''}`
      })
    })
  })
