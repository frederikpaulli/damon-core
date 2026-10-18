import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lineLooksLikeSecret } from './git-save'

export const NOTES_CAP = 400
const MAX_NOTE = 400
export const NOTES_HEADER = [
  '# Notes',
  '',
  'Written by Damon. One line per thing worth knowing, added by the agents as they',
  'work. Newest at the bottom. Damon trims this file when it gets long; anything',
  'older moves to NOTES-ARCHIVE.md.',
  ''
].join('\n')

const OURS = 'Written by Damon.'

function targetIn(folder: string): { file: string; archive: string } | null {
  try {
    const mine = join(folder, 'NOTES.md')
    if (!existsSync(mine) || readFileSync(mine, 'utf8').includes(OURS)) {
      return { file: mine, archive: join(folder, 'NOTES-ARCHIVE.md') }
    }
    return { file: join(folder, 'DAMON-NOTES.md'), archive: join(folder, 'DAMON-NOTES-ARCHIVE.md') }
  } catch {
    return null
  }
}

export function noteLine(who: string, text: string, at: Date): string {
  const when = at.toISOString().slice(0, 16).replace('T', ' ')
  const said = text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE)
  return `- ${when} · ${who.replace(/\s+/g, ' ').trim()} · ${said}`
}

export function readNotes(folder: string): string {
  const at = targetIn(folder)
  if (!at) return ''
  try {
    return existsSync(at.file) ? readFileSync(at.file, 'utf8') : ''
  } catch {
    return ''
  }
}

function noteLines(notes: string): string[] {
  return notes
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith('- '))
}

export const NOTES_BUDGET_CHARS = 6000

export function relevantNotes(notes: string, query: string, budget: number = NOTES_BUDGET_CHARS): string {
  return rankByRelevance(noteLines(notes), (l) => l, query, { budget }).join('\n')
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
export function relevanceMatched<T>(items: readonly T[], textOf: (t: T) => string, query: string): boolean {
  const terms = new Set(wordsOf(query).filter((w) => w.length > 3))
  return items.some((item) => wordsOf(textOf(item)).some((w) => terms.has(w)))
}
export function rankByRelevance<T>(items: readonly T[], textOf: (t: T) => string, query: string, opts: { budget: number; max?: number }): T[] {
  if (items.length === 0) return []
  const terms = new Set(wordsOf(query).filter((w) => w.length > 3))
  const scored = items.map((item, index) => {
    let score = 0
    for (const w of wordsOf(textOf(item))) if (terms.has(w)) score += 1
    return { item, score, index, size: textOf(item).length + 1 }
  })
  const ordered = scored.some((s) => s.score > 0)
    ? scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.index - a.index)
    : [...scored].sort((a, b) => b.index - a.index)
  const chosen: typeof scored = []
  let used = 0
  for (const s of ordered) {
    if (opts.max !== undefined && chosen.length >= opts.max) break
    if (used + s.size > opts.budget) continue
    chosen.push(s)
    used += s.size
  }
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.item)
}

export function newestNotes(notes: string, count: number): string {
  return noteLines(notes).slice(-count).join('\n')
}

export function addNote(folder: string, who: string, text: string, at: Date = new Date()): 'added' | 'failed' | 'refused' {
  if (text.trim().length === 0) return 'failed'
  if (lineLooksLikeSecret(text)) return 'refused'
  const where = targetIn(folder)
  if (!where) return 'failed'
  try {
    if (!existsSync(where.file)) writeFileSync(where.file, `${NOTES_HEADER}\n`, 'utf8')
    appendFileSync(where.file, `${noteLine(who, text, at)}\n`, 'utf8')
  } catch {
    return 'failed'
  }
  trim(where)
  return 'added'
}

function trim(where: { file: string; archive: string }): void {
  try {
    const lines = readFileSync(where.file, 'utf8').split('\n')
    const notes = lines.filter((l) => l.startsWith('- '))
    if (notes.length <= NOTES_CAP) return
    const move = notes.slice(0, Math.floor(notes.length / 2))
    const keep = notes.slice(move.length)
    appendFileSync(where.archive, `${move.join('\n')}\n`, 'utf8')
    writeFileSync(where.file, `${NOTES_HEADER}\n${keep.join('\n')}\n`, 'utf8')
  } catch {
  }
}
