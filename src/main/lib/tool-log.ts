import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson } from './json-file'
import type { Handling } from '../../shared/routing'

const DIR = 'tool-use'
const NO_TASK = '_no-task'

export interface ToolUse {
  id?: string
  ok?: boolean
  outcome?: string
  proof?: string[]
  background?: boolean
  at: string
  agentId: string
  agentName: string
  taskId?: string
  taskTitle?: string
  provider: string
  model: string
  tool: string
  summary: string
  detail?: string
  flagged?: boolean
}

export function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

export class ToolLog {
  private dir: string

  constructor(stateDir: string) {
    this.dir = join(stateDir, DIR)
  }

  record(use: ToolUse): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.fileFor(use.taskId), JSON.stringify(use) + '\n', 'utf8')
    } catch {
    }
  }

  forTask(taskId: string): ToolUse[] {
    return this.readFile(this.fileFor(taskId))
  }

  countForTask(taskId: string): number {
    return this.forTask(taskId).length
  }

  recent(limit = 200): ToolUse[] {
    const out: ToolUse[] = []
    for (const file of this.filesNewestFirst()) {
      out.push(...this.readFile(file).reverse())
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  forAgent(agentId: string, limit = 200): ToolUse[] {
    const out: ToolUse[] = []
    for (const file of this.filesNewestFirst()) {
      out.push(...this.readFile(file).filter((u) => u.agentId === agentId).reverse())
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  async prune(before: string): Promise<{ filesDropped: number; linesDropped: number }> {
    let filesDropped = 0
    let linesDropped = 0
    const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
    for (const file of this.files()) {
      let seen: { size: number; mtimeMs: number }
      let lines: ToolUse[]
      try {
        const at = await statAsync(file)
        seen = { size: at.size, mtimeMs: at.mtimeMs }
        lines = parseLines(await readFileAsync(file, 'utf8'))
      } catch {
        continue
      }
      const keep = lines.filter((u) => u.flagged === true || u.at >= before)
      if (lines.length > 0 && keep.length < lines.length) {
        try {
          const now = statSync(file)
          if (now.size === seen.size && now.mtimeMs === seen.mtimeMs) {
            linesDropped += lines.length - keep.length
            if (keep.length === 0) {
              rmSync(file)
              filesDropped += 1
            } else {
              writeFileSync(file, keep.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8')
            }
          }
        } catch {
        }
      }
      await turn()
    }
    return { filesDropped, linesDropped }
  }

  findMentioning(needle: string): { file: string; use: ToolUse }[] {
    const term = needle.toLowerCase()
    if (term.length === 0) return []
    const hits: { file: string; use: ToolUse }[] = []
    for (const file of this.files()) {
      for (const use of this.readFile(file)) {
        if (use.summary.toLowerCase().includes(term)) hits.push({ file, use })
      }
    }
    return hits
  }

  purgeMentioning(needle: string): number {
    const term = needle.toLowerCase()
    if (term.length === 0) return 0
    let removed = 0
    for (const file of this.files()) {
      const lines = this.readFile(file)
      const keep = lines.filter((u) => !u.summary.toLowerCase().includes(term))
      if (keep.length === lines.length) continue
      removed += lines.length - keep.length
      try {
        if (keep.length === 0) rmSync(file)
        else writeFileSync(file, keep.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8')
      } catch {
      }
    }
    return removed
  }

  private fileFor(taskId: string | undefined): string {
    return join(this.dir, `${taskId ? safeName(taskId) : NO_TASK}.jsonl`)
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(this.dir, f))
    } catch {
      return []
    }
  }

  private filesNewestFirst(): string[] {
    return this.files()
      .map((f) => {
        try {
          return { f, at: statSync(f).mtimeMs }
        } catch {
          return { f, at: 0 }
        }
      })
      .sort((a, b) => b.at - a.at)
      .map((x) => x.f)
  }

  private readFile(file: string): ToolUse[] {
    if (!existsSync(file)) return []
    try {
      return parseLines(readFileSync(file, 'utf8'))
    } catch {
      return []
    }
  }
}

function parseLines(text: string): ToolUse[] {
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as ToolUse
      } catch {
        return null
      }
    })
    .filter((u): u is ToolUse => u !== null)
}

export type { Handling }

export const OPEN_HANDLING: Handling = { touchesPersonalData: false, noTrainingProviders: false }

export class HandlingStore {
  private file: string

  constructor(stateDir: string) {
    this.file = join(stateDir, 'handling.json')
  }

  get(): Handling {
    const saved = readJson<Partial<Handling>>(this.file, {})
    return {
      touchesPersonalData: saved.touchesPersonalData === true,
      noTrainingProviders: saved.noTrainingProviders === true
    }
  }

  set(handling: Handling): Handling {
    const next: Handling = {
      touchesPersonalData: handling.touchesPersonalData === true,
      noTrainingProviders: handling.noTrainingProviders === true
    }
    writeJson(this.file, next)
    return next
  }
}
