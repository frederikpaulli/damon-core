import { promises as fsp, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface CheckpointFile { path: string; sha256: string; text: string }
export interface Checkpoint { taskId: string; at: string; done: string; next: string; notes?: string; auto: boolean; files: CheckpointFile[]; skipped: string[]; removed?: string[]; reset?: string[]; ended?: true }
export interface Handoff { at: string; decisions: string[]; open: string[] }
export interface CheckpointEntry { at: string; done: string; next: string; notes?: string; auto: boolean; files: number; paths: string[]; bytes: number; skipped?: string[] }
export const CHECKPOINT_EVERY_MS = 10 * 60_000
export const CHECKPOINT_KEEP_MS = 7 * 24 * 60 * 60_000
const FILE_MAX = 1024 * 1024
const TOTAL_MAX = 4 * 1024 * 1024
const LOG_KEEP = 40
const safe = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown'
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class CheckpointStore {
  private readonly dir: string
  constructor(stateDir: string) { this.dir = join(stateDir, 'checkpoints') }

  static snapshot(files: readonly { path: string; bytes: Buffer }[]): { files: CheckpointFile[]; skipped: string[] } {
    const out: CheckpointFile[] = [], skipped: string[] = []
    let total = 0
    for (const f of files) {
      if (f.bytes.length > FILE_MAX) { skipped.push(`${f.path} (over 1 MB)`); continue }
      if (total + f.bytes.length > TOTAL_MAX) { skipped.push(`${f.path} (the checkpoint is full at 4 MB)`); continue }
      let text: string
      try { if (f.bytes.includes(0)) throw Error('binary'); text = utf8.decode(f.bytes) } catch { skipped.push(`${f.path} (not text)`); continue }
      out.push({ path: f.path, sha256: createHash('sha256').update(f.bytes).digest('hex'), text })
      total += f.bytes.length
    }
    return { files: out, skipped }
  }

  async save(input: Checkpoint): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const base = join(this.dir, safe(input.taskId))
    const log = await this.log(input.taskId)
    const carried = input.auto && !input.notes?.trim() ? log.at(-1)?.notes : undefined
    const cp: Checkpoint = carried ? { ...input, notes: carried } : input
    await fsp.writeFile(`${base}.json.tmp`, JSON.stringify(cp), 'utf8')
    await fsp.rename(`${base}.json.tmp`, `${base}.json`)
    const kept = log.at(-1)?.auto && cp.auto ? log.slice(0, -1) : log
    const entry: CheckpointEntry = { at: cp.at, done: cp.done, next: cp.next, ...(cp.notes?.trim() ? { notes: cp.notes.trim() } : {}), auto: cp.auto, files: cp.files.length, paths: cp.files.map((f) => f.path).slice(0, 100), bytes: cp.files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0), ...(cp.skipped.length ? { skipped: cp.skipped.slice(0, 40) } : {}) }
    await fsp.writeFile(`${base}.log.json`, JSON.stringify([...kept, entry].slice(-LOG_KEEP)), 'utf8')
  }

  async latest(taskId: string): Promise<Checkpoint | null> {
    try { return JSON.parse(await fsp.readFile(join(this.dir, `${safe(taskId)}.json`), 'utf8')) as Checkpoint } catch { return null }
  }

  async log(taskId: string): Promise<CheckpointEntry[]> {
    try { const v = JSON.parse(await fsp.readFile(join(this.dir, `${safe(taskId)}.log.json`), 'utf8')) as unknown; return Array.isArray(v) ? (v as CheckpointEntry[]) : [] } catch { return [] }
  }

  logSync(taskId: string): CheckpointEntry[] {
    try { const v = JSON.parse(readFileSync(join(this.dir, `${safe(taskId)}.log.json`), 'utf8')) as unknown; return Array.isArray(v) ? (v as CheckpointEntry[]) : [] } catch { return [] }
  }

  async saveHandoff(taskId: string, h: Handoff): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const base = join(this.dir, `${safe(taskId)}.handoff.json`)
    await fsp.writeFile(`${base}.tmp`, JSON.stringify(h), 'utf8')
    await fsp.rename(`${base}.tmp`, base)
  }

  async handoff(taskId: string): Promise<Handoff | null> {
    try { return JSON.parse(await fsp.readFile(join(this.dir, `${safe(taskId)}.handoff.json`), 'utf8')) as Handoff } catch { return null }
  }

  handoffSync(taskId: string): Handoff | null {
    try { return JSON.parse(readFileSync(join(this.dir, `${safe(taskId)}.handoff.json`), 'utf8')) as Handoff } catch { return null }
  }

  async drop(taskId: string): Promise<void> {
    for (const f of [`${safe(taskId)}.json`, `${safe(taskId)}.log.json`, `${safe(taskId)}.handoff.json`]) await fsp.rm(join(this.dir, f), { force: true })
  }

  async prune(now = Date.now()): Promise<number> {
    let names: string[] = []
    try { names = await fsp.readdir(this.dir) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      try { if (now - (await fsp.stat(join(this.dir, name))).mtimeMs > CHECKPOINT_KEEP_MS) { await fsp.rm(join(this.dir, name), { force: true }); removed++ } } catch {}
    }
    return removed
  }
}
