import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lineLooksLikeSecret } from './git-save'

export type BrainSection = 'map' | 'decisions' | 'glossary'
export const BRAIN_BUDGET_CHARS = 2400

export const DECISIONS_CAP_CHARS = 16000
export type BrainRefusalCode = 'secret' | 'over-cap' | 'not-found' | 'ambiguous'
export interface BrainRefusal { refused: BrainRefusalCode; detail: string }

const NOT_NOW_HEADING = /^#{1,6}\s+not now\b/i
export const NOT_NOW_BUDGET_CHARS = 900

const FILES: Record<BrainSection, string> = { map: 'MAP.md', decisions: 'DECISIONS.md', glossary: 'GLOSSARY.md' }
const TITLES: Record<BrainSection, string> = {
  map: 'The map',
  decisions: 'Decisions & shared facts',
  glossary: 'Glossary'
}

export class BrainStore {
  private dir: string
  constructor(stateDir: string) {
    this.dir = join(stateDir, 'brain')
    mkdirSync(this.dir, { recursive: true })
  }

  private file(s: BrainSection): string {
    return join(this.dir, FILES[s])
  }

  private raw(s: BrainSection): string {
    const f = this.file(s)
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  read(section?: BrainSection): string {
    if (section) return this.raw(section)
    return (Object.keys(FILES) as BrainSection[])
      .map((s) => {
        const c = this.raw(s).trim()
        return c ? `## ${TITLES[s]}\n${c}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
  }

  private archiveFile(s: BrainSection): string {
    return join(this.dir, FILES[s].replace(/\.md$/, '-archive.md'))
  }

  history(s: BrainSection): string {
    const f = this.archiveFile(s)
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  notNow(budget: number = NOT_NOW_BUDGET_CHARS): string[] {
    const out: string[] = []
    let inNotNow = false
    let used = 0
    for (const l of this.raw('decisions').split('\n')) {
      const t = l.trim()
      if (/^#{1,6}\s/.test(t)) { inNotNow = NOT_NOW_HEADING.test(t); continue }
      if (!inNotNow || !t) continue
      const line = t.replace(/^[-*]\s*/, '')
      if (used + line.length + 1 > budget) break
      out.push(line)
      used += line.length + 1
    }
    return out
  }

  overCap(s: BrainSection): boolean {
    return s === 'decisions' && this.raw(s).trim().length > DECISIONS_CAP_CHARS
  }

  private save(s: BrainSection, text: string): void {
    const f = this.file(s)
    writeFileSync(f + '.tmp', text.trim() + '\n', 'utf8')
    renameSync(f + '.tmp', f)
  }

  write(section: BrainSection, content: string, mode: 'replace' | 'append', by: { owner?: boolean } = {}): BrainRefusal | null {
    const secret = lineLooksLikeSecret(content)
    if (secret) return { refused: 'secret', detail: `it looks like it contains a ${secret}` }
    const next = mode === 'append' ? `${this.raw(section).trim()}\n${content.trim()}`.trim() : content.trim()
    if (section === 'decisions' && !by.owner && next.length > DECISIONS_CAP_CHARS) {
      return {
        refused: 'over-cap',
        detail: mode === 'append'
          ? `the decisions would be ${next.length.toLocaleString('en-US')} characters against a ${DECISIONS_CAP_CHARS.toLocaleString('en-US')} limit. Make room first: move a part that is settled history or no longer true to the archive with mode "retire" (find = its heading line), or rewrite the whole section as the current state with mode "replace". Nothing retired or replaced is lost. Then add this. ${this.parts(section)}`
          : `the new decisions are ${next.length.toLocaleString('en-US')} characters against a ${DECISIONS_CAP_CHARS.toLocaleString('en-US')} limit. Keep only what is true today; settled history belongs in the archive.`
      }
    }
    if (mode === 'replace') {
      const old = this.raw(section).trim()
      if (old && old !== next) appendFileSync(this.archiveFile(section), `\n## Replaced ${new Date().toISOString()}\n${old}\n`, 'utf8')
    }
    this.save(section, next)
    return null
  }

  fix(section: BrainSection, find: string, replace: string): BrainRefusal | null {
    const current = this.raw(section)
    const secret = lineLooksLikeSecret(replace)
    if (secret) return { refused: 'secret', detail: `it looks like it contains a ${secret}` }
    const at = find ? current.indexOf(find) : -1
    if (at === -1) return { refused: 'not-found', detail: 'that text is not in the file. Read it first and copy the exact words.' }
    if (current.indexOf(find, at + 1) !== -1) return { refused: 'ambiguous', detail: 'that text occurs more than once. Include enough of the surrounding words to make it unique.' }
    const next = current.slice(0, at) + replace + current.slice(at + find.length)
    if (section === 'decisions' && next.trim().length > DECISIONS_CAP_CHARS && next.length > current.length) return { refused: 'over-cap', detail: `the decisions would pass the ${DECISIONS_CAP_CHARS.toLocaleString('en-US')}-character limit. Make room first with mode "retire" or "replace". ${this.parts(section)}` }
    appendFileSync(this.archiveFile(section), `\n## Fixed ${new Date().toISOString()}: replaced "${find.slice(0, 200)}"\n`, 'utf8')
    this.save(section, next)
    return null
  }

  private parts(section: BrainSection): string {
    const sizes: { heading: string; chars: number }[] = []
    for (const line of this.raw(section).split('\n')) {
      if (/^#{1,6}\s/.test(line.trim())) sizes.push({ heading: line.trim(), chars: line.length + 1 })
      else if (sizes.length) sizes[sizes.length - 1]!.chars += line.length + 1
    }
    if (!sizes.length) return ''
    return `Its largest parts: ${sizes.sort((a, b) => b.chars - a.chars).slice(0, 8).map(p => `"${p.heading.slice(0, 90)}" (${p.chars.toLocaleString('en-US')})`).join('; ')}.`
  }

  retire(section: BrainSection, heading: string): BrainRefusal | null {
    const lines = this.raw(section).split('\n')
    const want = heading.trim()
    const at = lines.flatMap((l, i) => l.trim() === want && /^#{1,6}\s/.test(want) ? [i] : [])
    if (!at.length) return { refused: 'not-found', detail: 'no heading line reads exactly that. Copy the whole heading line, with its # marks, from the section.' }
    if (at.length > 1) return { refused: 'ambiguous', detail: 'that heading occurs more than once. Use mode "fix" on the part instead.' }
    const start = at[0]!, level = want.match(/^#+/)![0].length
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i]!.trim().match(/^(#{1,6})\s/)
      if (m && m[1]!.length <= level) { end = i; break }
    }
    appendFileSync(this.archiveFile(section), `\n## Retired ${new Date().toISOString()}\n${lines.slice(start, end).join('\n')}\n`, 'utf8')
    this.save(section, [...lines.slice(0, start), ...lines.slice(end)].join('\n'))
    return null
  }

  readWithOwnerNotes(ownerProfile: string): string {
    const body = this.read()
    const notes = ownerProfile.trim()
    const head = notes ? `## Owner notes (authoritative, obey these first)\n${notes}` : ''
    return [head, body].filter(Boolean).join('\n\n')
  }

  relevantSlice(query: string, budget: number = BRAIN_BUDGET_CHARS): string {
    const lines: string[] = []
    for (const s of ['map', 'decisions', 'glossary'] as BrainSection[]) {
      let inNotNow = false
      const body = this.raw(s)
      body.split('\n').forEach((l, i) => {
        const t = l.trim()
        if (/^#{1,6}\s/.test(t)) inNotNow = NOT_NOW_HEADING.test(t)
        if (t && !t.startsWith('#') && !inNotNow) lines.push(t)
      })
    }
    if (lines.length === 0) return ''
    const terms = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    )
    const scored = lines.map((l, index) => {
      let score = 0
      for (const w of l.toLowerCase().split(/[^a-z0-9]+/)) if (terms.has(w)) score += 1
      return { l, score, index }
    })
    const ordered = scored.some((s) => s.score > 0)
      ? scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
      : scored
    const out: string[] = []
    let used = 0
    for (const s of ordered) {
      if (used + s.l.length + 1 > budget) break
      out.push(s.l)
      used += s.l.length + 1
    }
    return out.join('\n')
  }
}
