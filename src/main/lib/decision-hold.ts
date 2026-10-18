import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './json-file'
import { globalDecisionLines } from './edit-lane-basis'
import { cardSentFiles } from './ready-gate'
import { readyCheckFor } from '../../shared/your-turn'
import { pdfTextReadable } from '../../shared/critic-reach'
import { DocumentTextStore } from './document-text'
import type { CritiqueObligation, DecisionHold } from './critique-store'

const SEEN_FILE = 'decision-lines-seen.json'

const NUMBER_WORDS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000', dozen: '12' }
const isNumber = (w: string): boolean => /^\d+(?:[.,]\d+)*$/.test(w) || w in NUMBER_WORDS
const valueOf = (w: string): string => NUMBER_WORDS[w] ?? w.replace(/,/g, '')
function spellings(w: string): string[] {
  const v = valueOf(w)
  return [...new Set([w, v, ...Object.keys(NUMBER_WORDS).filter(k => NUMBER_WORDS[k] === v)])]
}

const plain = (s: string): string => s.normalize('NFKC').replace(/[­​-‍⁠﻿]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
const TOKEN = /[\p{L}\p{N}]+(?:[.,'&][\p{L}\p{N}]+)*/gu
const tokens = (s: string): string[] => plain(s).match(TOKEN) ?? []
const segments = (line: string): string[][] => plain(line).split(/[.!?;:](?=\s|$)|[()[\]"]/).map(tokens).filter(t => t.length)

export interface Dropped { was: string; now: string | null; words: string[] }

function likeness(a: string, b: string): number {
  const x = new Set(tokens(a).map(w => w.toLowerCase())), y = new Set(tokens(b).map(w => w.toLowerCase()))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}
const squash = (l: string): string => l.replace(/\s+/g, ' ').trim()

export function droppedWords(oldLines: string[], newLines: string[]): Dropped[] {
  const was = oldLines.map(squash), now = newLines.map(squash)
  const nowSet = new Set(now), wasSet = new Set(was)
  const added = now.filter(l => !wasSet.has(l))
  const out: Dropped[] = []
  for (const line of was) {
    if (nowSet.has(line)) continue
    let best: string | null = null, score = 0
    for (const n of added) { const s = likeness(line, n); if (s > score) { score = s; best = n } }
    const paired = score >= 0.5 ? best : null
    const nowWords = new Set(paired ? tokens(paired).map(w => w.toLowerCase()) : [])
    const nowNumbers = new Set([...nowWords].filter(isNumber).map(valueOf))
    const nowRuns = new Set((paired ? segments(paired) : []).flatMap(t => t.map((_, i) => t.slice(i, i + 3).join(' ').toLowerCase())))
    const words: string[] = []
    for (const seg of segments(line)) {
      const low = seg.map(w => w.toLowerCase())
      seg.forEach((w, i) => {
        if (!isNumber(low[i]!) || nowNumbers.has(valueOf(low[i]!))) return
        if (i + 1 < seg.length) words.push(`${w} ${seg[i + 1]}`)
        if (i > 0) words.push(`${seg[i - 1]} ${w}`)
        if (seg.length === 1) words.push(w)
      })
      for (let i = 0; i + 3 <= seg.length; i++) if (!nowRuns.has(low.slice(i, i + 3).join(' '))) words.push(seg.slice(i, i + 3).join(' '))
    }
    const unique = [...new Map(words.map(w => [w.toLowerCase(), w])).values()]
    if (unique.length) out.push({ was: line, now: paired, words: unique })
  }
  return out
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', apos: "'", quot: '"', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: ' ', hellip: ' ', shy: '­', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å', eacute: 'é', Eacute: 'É', egrave: 'è', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß' }
function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
    }
    return ENTITIES[e] ?? ' '
  })
}
export function textWords(text: string, file: string): string[] {
  let t = text
  if (/\.html?$/i.test(file)) t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return tokens(decodeEntities(t)).map(w => w.toLowerCase())
}
function forms(word: string): string[][] {
  const parts = tokens(word).map(w => w.toLowerCase())
  let all: string[][] = [[]]
  for (const p of parts) all = all.flatMap(a => (isNumber(p) ? spellings(p) : [p]).map(s => [...a, s]))
  return all
}
function says(words: string[], run: string[]): boolean {
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) if (words[i + j] !== run[j]) continue outer
    return true
  }
  return false
}

export interface StillSaid { found: { word: string; files: string[] }[]; unread: string[] }
export function stillSays(dropped: Dropped[], sent: string[], read: (file: string) => string | null): StillSaid {
  const words = [...new Map(dropped.flatMap(d => d.words).map(w => [w.toLowerCase(), w])).values()]
  if (!words.length) return { found: [], unread: [] }
  const texts = sent.map(f => { const t = read(f); return { file: f, words: t === null ? null : textWords(t, f) } })
  const found: StillSaid['found'] = []
  for (const w of words) {
    const runs = forms(w)
    const files = texts.filter(t => t.words && runs.some(r => says(t.words!, r))).map(t => t.file)
    if (files.length) found.push({ word: w, files })
  }
  return { found, unread: found.length ? [] : texts.filter(t => !t.words).map(t => t.file) }
}

const base = (f: string): string => f.replace(/\\/g, '/').split('/').pop() ?? f
const quoteList = (xs: string[]): string => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
export function holdLine(s: StillSaid): string {
  if (s.found.length) {
    const shown: StillSaid['found'] = []
    for (const f of [...s.found].sort((a, b) => a.word.length - b.word.length)) {
      if (shown.length >= 3) break
      if (!shown.some(x => f.word.toLowerCase().includes(x.word.toLowerCase()))) shown.push(f)
    }
    const parts = shown.map(f => `"${f.word}" (in ${quoteList([...new Set(f.files.map(base))])})`)
    return `Your decisions changed and no longer say ${quoteList(parts)}, but this package still does. Damon checks this package's claims again on the files as they are now; the card waits for that check.`
  }
  return `Your decisions changed, and Damon could not read ${quoteList(s.unread.map(base))} to see whether this package still says what they no longer say. Damon checks this package's claims again on the files as they are now; the card waits for that check.`
}

export function sentTextReader(root: string, stateDir: string, missing: string[] = []): (file: string) => string | null {
  const docs = new DocumentTextStore(stateDir)
  return (file: string) => {
    const full = join(root, ...file.replace(/\\/g, '/').split('/'))
    try {
      if (/\.pdf$/i.test(file)) {
        const bytes = readFileSync(full)
        const doc = docs.cachedNow(createHash('sha256').update(bytes).digest('hex'), 'pdf')
        if (!doc) { missing.push(file); return null }
        return pdfTextReadable(doc) ? doc.text : null
      }
      if (/\.(?:md|markdown|txt|html?|csv|json|xml|rtf)$/i.test(file) || !/\.[a-z0-9]{1,5}$/i.test(file)) return statSync(full).isFile() ? readFileSync(full, 'utf8') : null
      return null
    } catch { return null }
  }
}

export interface HoldCard { id: string; kind?: string; files?: string[]; file?: string }
export interface PlannedHold { cardId: string; laneId: string; hold: DecisionHold }
export function planDecisionHolds(input: { decisions: string; known: string[]; seen: string[] | null; cards: HoldCard[]; lanes: CritiqueObligation[]; read: (file: string) => string | null; at?: string }): { lines: string[]; dropped: Dropped[]; holds: PlannedHold[] } {
  const lines = globalDecisionLines(input.decisions, input.known)
  if (!input.seen) return { lines, dropped: [], holds: [] }
  const present = new Set(input.decisions.split(/\r?\n/).map(squash).filter(Boolean))
  const dropped = droppedWords(input.seen.filter(l => !present.has(squash(l))), lines)
  if (!dropped.length) return { lines, dropped, holds: [] }
  const at = input.at ?? new Date().toISOString()
  const live = input.lanes.filter(x => !x.retired)
  const holds: PlannedHold[] = []
  const done = new Set<string>()
  for (const card of input.cards) {
    if (card.kind !== 'submit' && card.kind !== 'send') continue
    const files = [...new Set([...(card.files ?? []), ...(card.file ? [card.file] : [])])]
    const sent = cardSentFiles(files)
    const ready = readyCheckFor(live, { files, sent }, () => true)
    const lane = live.find(x => x.id === (ready?.passedId ?? ready?.outstandingId))
    if (!lane || !lane.reports.length || done.has(lane.id)) continue
    const said = stillSays(dropped, sent, input.read)
    if (!said.found.length && !said.unread.length) continue
    done.add(lane.id)
    holds.push({ cardId: card.id, laneId: lane.id, hold: { at, line: holdLine(said), words: said.found.map(f => f.word).slice(0, 8), files: [...new Set([...said.found.flatMap(f => f.files), ...said.unread])].slice(0, 12) } })
  }
  return { lines, dropped, holds }
}

type HoldStore = { list(): CritiqueObligation[]; holdOnDecisions(id: string, hold: DecisionHold): boolean }
export function applyDecisionHolds(stateDir: string, store: HoldStore, input: { decisions: string; known: string[]; cards: HoldCard[]; read: (file: string) => string | null }): { holds: PlannedHold[]; dropped: Dropped[] } {
  const file = join(stateDir, SEEN_FILE)
  let seen: string[] | null = null
  if (existsSync(file)) { const saved = readJson<{ lines?: unknown }>(file, {}); seen = Array.isArray(saved.lines) ? saved.lines.filter((l): l is string => typeof l === 'string') : null }
  const lines = globalDecisionLines(input.decisions, input.known)
  if (seen && seen.length === lines.length && seen.every((l, i) => l === lines[i])) return { holds: [], dropped: [] }
  const plan = planDecisionHolds({ ...input, seen, lanes: store.list() })
  for (const h of plan.holds) store.holdOnDecisions(h.laneId, h.hold)
  writeJson(file, { lines: plan.lines })
  return { holds: plan.holds, dropped: plan.dropped }
}
