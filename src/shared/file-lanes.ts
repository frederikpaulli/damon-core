import { ownerMoment } from './owner-moment'

export type Lane = 'produced' | 'working'

export interface FileNote {
  file: string
  what: string
}

export interface FileOnDisk {
  path: string
  bytes: number
  at: string
  by?: string
}

export interface FileRow {
  path: string
  lane: Lane
  explanation: string
  explained: boolean
  mechanical: string
}

const SAYS_DELIVERABLE = /\b(deliverable|final|finished|for the owner|hand(ed)? (over )?to you|the result)\b/i

const EVIDENCE = /(^|\/)(damon-shots|\.playwright-mcp|screenshots?)\//i

export function evidenceFile(path: string): boolean {
  return EVIDENCE.test(path.replace(/\\/g, '/'))
}

export function rewroteDeliverable(written: string[], produced: string[]): string[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const made = new Set(produced.map(norm))
  return written.filter((w) => made.has(norm(w)))
}

export function laneOf(note: FileNote): Lane {
  if (evidenceFile(note.file)) return 'working'
  return SAYS_DELIVERABLE.test(note.what ?? '') ? 'produced' : 'working'
}

function mechanicalFacts(f: FileOnDisk): string {
  const size = f.bytes >= 1024 ? `${Math.round(f.bytes / 1024)} KB` : `${f.bytes} bytes`
  const when = Number.isFinite(Date.parse(f.at)) ? ownerMoment(f.at) : ''
  const who = f.by ? `written by ${f.by}` : 'written by the team'
  return [who, when, size].filter(Boolean).join(' · ')
}

export function fileRows(onDisk: FileOnDisk[], notes: FileNote[]): FileRow[] {
  const byPath = new Map<string, FileNote>()
  for (const n of notes) byPath.set(n.file.replace(/\\/g, '/'), n)

  const rows: FileRow[] = onDisk.map((f) => {
    const note = byPath.get(f.path.replace(/\\/g, '/'))
    const what = (note?.what ?? '').trim()
    return {
      path: f.path,
      lane: note ? laneOf(note) : 'working',
      explanation: what === '' ? 'No explanation given' : what,
      explained: what !== '',
      mechanical: mechanicalFacts(f)
    }
  })

  return rows.sort((a, b) => (a.lane === b.lane ? 0 : a.lane === 'produced' ? -1 : 1))
}
