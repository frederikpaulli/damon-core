import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentInfo } from '../../shared/types'
import { lineLooksLikeSecret } from './git-save'

export interface AgentMemory {
  agentMd: string
  memoryMd: string
  rejections: string[]
}

const MEMORY_BUDGET_CHARS = 1800

export const MAX_REJECTIONS = 6
export const REJECTION_DAYS = 30
const REJECTION_MAX_CHARS = 240

export class MemoryStore {
  constructor(private root: string) {}

  private made = new Set<string>()

  dirFor(agentId: string): string {
    const dir = join(this.root, agentId)
    if (!this.made.has(dir)) {
      mkdirSync(dir, { recursive: true })
      this.made.add(dir)
    }
    return dir
  }

  load(agent: AgentInfo, projectName: string): AgentMemory {
    const dir = this.dirFor(agent.id)
    const agentFile = join(dir, 'AGENT.md')
    const memoryFile = join(dir, 'MEMORY.md')

    if (!existsSync(agentFile)) {
      const today = new Date().toISOString().slice(0, 10)
      writeFileSync(
        agentFile,
        `# ${agent.name}

**Role:** ${agent.role}

**Standing brief:** Owns this role on the project "${projectName}" and stays sharply focused on it. Does the work fully, verifies it, reports concretely. Applies saved lessons; keeps its own notes short and durable.

_Created ${today}._
`,
        'utf8'
      )
    }
    if (!existsSync(memoryFile)) {
      writeFileSync(memoryFile, `# What ${agent.name} has learned\n`, 'utf8')
    }

    return {
      agentMd: readFileSync(agentFile, 'utf8'),
      memoryMd: readFileSync(memoryFile, 'utf8'),
      rejections: this.rejections(agent.id)
    }
  }

  rejections(agentId: string, now: number = Date.now()): string[] {
    const file = join(this.dirFor(agentId), 'REJECTIONS.md')
    if (!existsSync(file)) return []
    const cutoff = new Date(now - REJECTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const kept: string[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/.exec(line.trim())
      if (!m) continue
      if (m[1]! < cutoff) continue
      kept.push(`[${m[1]}] ${m[2]!.trim()}`)
    }
    return kept.slice(-MAX_REJECTIONS).reverse()
  }

  addRejections(agentId: string, objections: string[], now: number = Date.now()): string[] {
    const clean = objections
      .map((o) => o.trim().replace(/^[-•]\s*/, '').replace(/\s+/g, ' '))
      .filter((o) => o.length > 3)
      .map((o) => (o.length > REJECTION_MAX_CHARS ? o.slice(0, REJECTION_MAX_CHARS - 1) + '…' : o))
    if (clean.length === 0) return []

    const file = join(this.dirFor(agentId), 'REJECTIONS.md')
    const today = new Date(now).toISOString().slice(0, 10)
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const cutoff = new Date(now - REJECTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    let bullets = existing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^-\s*\[\d{4}-\d{2}-\d{2}\]/.test(l))
      .filter((l) => (/^-\s*\[(\d{4}-\d{2}-\d{2})\]/.exec(l)?.[1] ?? '') >= cutoff)

    for (const o of clean) {
      if (bullets.some((b) => b.endsWith(o))) continue
      bullets.push(`- [${today}] ${o}`)
    }
    bullets = bullets.slice(-MAX_REJECTIONS)

    writeFileSync(
      file,
      `# What a reviewer sent back, and why\n\nOldest first. Anything over ${REJECTION_DAYS} days old is dropped, because a standard can move in that time.\n\n${bullets.join('\n')}\n`,
      'utf8'
    )
    return bullets
  }

  clearRejections(agentId: string): void {
    const file = join(this.dirFor(agentId), 'REJECTIONS.md')
    if (existsSync(file)) writeFileSync(file, '# What a reviewer sent back, and why\n', 'utf8')
  }

  relevant(agentId: string, query: string, limit = 6): string[] {
    const memoryFile = join(this.dirFor(agentId), 'MEMORY.md')
    if (!existsSync(memoryFile)) return []
    const bullets = readFileSync(memoryFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
    const terms = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    )
    const scored = bullets.map((b, index) => {
      const words = b.toLowerCase().split(/[^a-z0-9]+/)
      let score = 0
      for (const w of words) if (terms.has(w)) score += 1
      return { b, score, index }
    })
    const anyMatch = scored.some((s) => s.score > 0)
    if (!anyMatch) return bullets.slice(-limit)
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, limit)
      .map((s) => s.b)
  }

  addNotes(agentId: string, notes: string[]): void {
    if (notes.length === 0) return
    const memoryFile = join(this.dirFor(agentId), 'MEMORY.md')
    const existing = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf8') : '# Lessons\n'
    const lines = existing.split('\n')
    const header = lines[0] ?? '# Lessons'
    let bullets = lines.slice(1).filter((l) => l.trim().startsWith('-'))

    const today = new Date().toISOString().slice(0, 10)
    for (const note of notes) {
      const clean = note.trim().replace(/^[-•]\s*/, '')
      if (!clean) continue
      if (bullets.some((b) => b.includes(clean))) continue
      if (lineLooksLikeSecret(clean)) continue
      bullets.push(`- [${today}] ${clean}`)
    }

    const render = (): string => `${header}\n${bullets.join('\n')}\n`
    while (render().length > MEMORY_BUDGET_CHARS && bullets.length > 1) {
      bullets = bullets.slice(1)
    }

    writeFileSync(memoryFile, render(), 'utf8')
  }
}
