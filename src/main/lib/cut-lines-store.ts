import { join } from 'node:path'
import { readJson, writeJson } from './json-file'

export interface CutLine { line: string; file?: string; at: string }

export const CUT_LINES_FILE = 'cut-lines.json'
const MAX_CUT_LINES = 500

export class CutLinesStore {
  private readonly file: string
  constructor(stateDir: string) {
    this.file = join(stateDir, CUT_LINES_FILE)
  }

  list(): CutLine[] {
    const raw = readJson<unknown>(this.file, [])
    return Array.isArray(raw) ? raw.filter((c): c is CutLine => !!c && typeof (c as CutLine).line === 'string' && typeof (c as CutLine).at === 'string') : []
  }

  remove(line: string): boolean {
    const key = line.trim().replace(/\s+/g, ' ').toLowerCase()
    const all = this.list()
    const left = all.filter((c) => c.line.replace(/\s+/g, ' ').toLowerCase() !== key)
    if (left.length === all.length) return false
    writeJson(this.file, left)
    return true
  }

  add(line: string, file?: string): void {
    const trimmed = line.trim()
    if (trimmed.length < 4) return
    const all = this.list()
    const key = trimmed.replace(/\s+/g, ' ').toLowerCase()
    if (all.some((c) => c.line.replace(/\s+/g, ' ').toLowerCase() === key)) return
    all.push({ line: trimmed, ...(file ? { file } : {}), at: new Date().toISOString() })
    writeJson(this.file, all.slice(-MAX_CUT_LINES))
  }
}
