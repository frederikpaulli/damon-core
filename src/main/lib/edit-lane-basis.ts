import { createHash } from 'node:crypto'
import type { CritiqueObligation } from './critique-store'

export const EDIT_LANE_CRITICAL = 'package-lines'

export interface DecisionCard { kind?: string; files?: string[]; file?: string; company?: string }

const OUTWARD = new Set(['submit', 'send'])
const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
const filesOf = (c: DecisionCard): string[] => [...(c.files ?? []), ...(c.file ? [c.file] : [])]

export function editLaneCards<T extends DecisionCard>(laneFiles: string[], cards: T[]): T[] {
  if (!laneFiles.length) return []
  const outward = cards.filter(c => OUTWARD.has(c.kind ?? ''))
  const on = (c: T, f: string): boolean => filesOf(c).some(g => norm(g) === norm(f))
  if (!laneFiles.every(f => outward.some(c => on(c, f)))) return []
  return outward.filter(c => laneFiles.some(f => on(c, f)))
}

const GENERIC = new Set(['consulting', 'consultants', 'consultancy', 'group', 'company', 'companies', 'management', 'denmark', 'danmark', 'nordic', 'nordics', 'europe', 'european', 'international', 'global', 'solutions', 'services', 'systems', 'technologies', 'technology', 'holding', 'holdings', 'partners', 'digital', 'labs', 'the', 'and', 'aps', 'bank', 'business', 'unknown'])
export function companyTokens(company: string): string[] {
  const words = (company ?? '').match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter(w => (w.length >= 4 || (w.length >= 3 && w === w.toUpperCase() && /\p{L}/u.test(w))) && !GENERIC.has(w.toLowerCase())))]
}
const SHARED_DIRS = new Set(['outgoing', 'attachments', 'final', 'documents', 'docs', 'files', 'drafts', 'sent', 'reviews'])
export function cardTokens(card: DecisionCard): string[] {
  const folders = filesOf(card).flatMap(f => f.replace(/\\/g, '/').split('/').slice(0, -1))
    .filter(s => s.length >= 2 && !SHARED_DIRS.has(s.toLowerCase()) && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(s))
  return [...new Set([...companyTokens(card.company ?? ''), ...folders])]
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function names(tokens: string[], caseSensitive: boolean): (line: string) => boolean {
  const res = tokens.filter(Boolean).map(t => {
    const edge = t.includes('-') ? '[\\p{L}\\p{N}_-]' : '[\\p{L}\\p{N}_]'
    return new RegExp(`(?<!${edge})${escape(t)}(?!${edge})`, caseSensitive ? 'u' : 'iu')
  })
  return line => res.some(r => r.test(line))
}
const linesOf = (text: string): string[] => (text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)

export function packageDecisionLines(decisions: string, tokens: string[]): string[] {
  const own = names(tokens, false)
  return linesOf(decisions).filter(own)
}

export function editLaneCritical(input: { brief: string; decisions: string; notes: string; tokens: string[] }): string {
  return createHash('sha256').update(JSON.stringify({ brief: input.brief, lines: packageDecisionLines(input.decisions, input.tokens), notes: input.notes })).digest('hex')
}

function labelled(line: string, known: Set<string>): boolean {
  const body = line.replace(/^[#>*\-\s]+/, '')
  const cut = body.search(/[:(]/)
  if (cut <= 0 || cut > 60) return false
  const words = body.slice(0, cut).match(/[\p{L}\p{N}][\p{L}\p{N}.&'’-]*/gu) ?? []
  if (!words.length) return false
  let company = false
  for (const raw of words) {
    const w = raw.replace(/[.'’-]+$/u, '')
    if (known.has(w)) { company = true; continue }
    if (GENERIC.has(w.toLowerCase()) || /\p{N}/u.test(w) || (w.length >= 2 && w === w.toUpperCase() && /\p{L}/u.test(w))) continue
    return false
  }
  return company
}

export function decisionNoteKey(decisions: string, own: string[], known: string[]): string {
  const isOwn = names(own, false), knownSet = new Set(known.filter(Boolean))
  const all = linesOf(decisions)
  const mine = all.filter(isOwn)
  const global = all.filter(l => !isOwn(l) && !labelled(l, knownSet))
  return createHash('sha256').update(JSON.stringify({ own: mine, global })).digest('hex')
}

export function globalDecisionLines(decisions: string, known: string[]): string[] {
  const knownSet = new Set(known.filter(Boolean))
  return linesOf(decisions).filter(l => !labelled(l, knownSet))
}

const LOOSE = new Set(['critical', 'criticalOn', 'observed'])
const rest = (b: Record<string, unknown>): string => JSON.stringify(Object.keys(b).filter(k => !LOOSE.has(k)).sort().map(k => [k, b[k]]))
export function editLaneAdopts(old: unknown, now: Record<string, unknown>, ctx: { reported: boolean; wholeKey: string }): boolean {
  if (!ctx.reported || !old || typeof old !== 'object' || Array.isArray(old)) return false
  const o = old as Record<string, unknown>
  if (rest(o) !== rest(now)) return false
  return o.criticalOn === EDIT_LANE_CRITICAL ? o.critical === now.critical : o.critical === ctx.wholeKey
}

export interface EditLaneContext { cards: DecisionCard[]; brief: string; decisions: string; notes: string }
type LaneStore = { list(): CritiqueObligation[]; adoptBasis(scope: string, basis: unknown, unchanged: (old: unknown) => boolean): boolean }
export function settleEditLane(store: LaneStore, scope: string, basis: Record<string, unknown>, ctx: EditLaneContext | null): boolean {
  if (!ctx || !ctx.cards.length) return false
  const wholeKey = typeof basis.critical === 'string' ? basis.critical : ''
  const tokens = [...new Set(ctx.cards.flatMap(cardTokens))]
  basis.critical = editLaneCritical({ brief: ctx.brief, decisions: ctx.decisions, notes: ctx.notes, tokens })
  basis.criticalOn = EDIT_LANE_CRITICAL
  const live = store.list().find(x => x.scope === scope && !x.retired)
  const reported = !!live?.reports.length
  return store.adoptBasis(scope, basis, old => editLaneAdopts(old, basis, { reported, wholeKey }))
}
