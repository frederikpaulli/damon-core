// The seal on an outward action (send, submit, sign, pay, deliver). It records the bytes of
// every file that leaves, the facts it cites and the destination. If any of them changes
// after the check passed, the seal comes off and the card is not ready.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './json-file'
import { droppedWords, stillSays } from './decision-hold'
import { cardSentFiles, formSheetKey, formSheetKeys, readyOn, type ReadyLane } from './ready-gate'
import { isSharedUpload } from '../../shared/outgoing'
import { formAnswers, sealedWordFault, type SealedTexts } from '../../shared/outgoing'
import { findingKey } from './critique-store'

export const OUTWARD_ACTIONS_FILE = 'outward-actions.json'

export type OutwardKind = 'submit' | 'send' | 'sign' | 'pay' | 'deliver'
export type OutwardChannel = 'form' | 'email' | 'file' | 'payment'
export interface OutwardDestination { url?: string; to?: { name: string; contact?: string }; channel: OutwardChannel }
export interface OutwardLeave { file: string; sha256: string; role: 'document' | 'message' | 'answers' | 'attachment' }
export interface CitedFact { id: string; sha256: string }
export interface OutwardSeal { checkId: string; reportAt: string; at: string; bytes: string; facts: string; destination: string; scope?: string; profile?: string }
export interface OutwardSettled { file: string; span: string; at: string; by: 'owner' }
export interface OutwardNote { at: string; from: string; text: string; class: 'style' | 'bookkeeping' | 'suggestion' | 'unread' }
export interface OutwardShadow { at: string; ready: boolean; why: string | null; gate: string | null; agree: boolean }
export interface OutwardAction {
  id: string; projectId: string; cardId: string; kind: OutwardKind
  destination: OutwardDestination
  leaves: OutwardLeave[]
  factsCited: CitedFact[]
  seal?: OutwardSeal
  settled: OutwardSettled[]
  notes: OutwardNote[]
  shadow?: OutwardShadow
  destinationAt?: string
  press?: { at: string; bytes: string }
  handover?: { at: string; text: string }
  createdAt: string; updatedAt: string
}

const norm = (f: string): string => f.replace(/\\/g, '/').replace(/^\.\//, '')
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function destinationOf(card: { url?: string; to?: { name: string; contact?: string } }): OutwardDestination {
  const url = card.url?.trim() || undefined
  const to = card.to?.name?.trim() ? { name: card.to.name.trim(), ...(card.to.contact?.trim() ? { contact: card.to.contact.trim() } : {}) } : undefined
  const channel: OutwardChannel = url ? 'form' : to?.contact?.includes('@') ? 'email' : 'file'
  return { ...(url ? { url } : {}), ...(to ? { to } : {}), channel }
}
export function destinationKey(d: OutwardDestination): string {
  return JSON.stringify([d.channel, d.url ?? null, d.to?.name.toLowerCase() ?? null, d.to?.contact?.toLowerCase() ?? null])
}
export function sealBytes(leaves: { file: string; sha256: string }[]): string {
  return sha(JSON.stringify([...leaves].map(l => [norm(l.file).toLowerCase(), l.sha256]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))))
}
export function factsKey(facts: CitedFact[]): string {
  return sha(JSON.stringify([...facts].map(f => [f.id, f.sha256]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))))
}

export interface ReadyNow {
  bytes: (file: string) => string | undefined
  answers: (file: string) => string | undefined
  facts: (id: string) => string | undefined
  destination: string
  required: string[]
  profile?: string
}
export interface ReadyAnswer { ready: boolean; why: string | null }
export function ready(action: OutwardAction | undefined, now: ReadyNow): ReadyAnswer {
  const seal = action?.seal
  if (!action || !seal) return { ready: false, why: 'no seal: no passed check on what leaves' }
  if (!action.leaves.length || sealBytes(action.leaves) !== seal.bytes) return { ready: false, why: 'the seal does not match its own files' }
  const moved = action.leaves.filter(l => (l.role === 'answers' ? now.answers(l.file) : now.bytes(l.file)) !== l.sha256).map(l => l.file)
  if (moved.length) return { ready: false, why: `changed since checked: ${moved.join(', ')}` }
  const held = new Set(action.leaves.map(l => norm(l.file).toLowerCase()))
  const uncovered = [...new Set(now.required.map(norm))].filter(f => !held.has(f.toLowerCase()))
  if (uncovered.length) return { ready: false, why: `not covered by the check that sealed it: ${uncovered.join(', ')}` }
  if (factsKey(action.factsCited) !== seal.facts) return { ready: false, why: 'the seal does not match its own facts' }
  const facts = action.factsCited.filter(f => now.facts(f.id) !== f.sha256).map(f => f.id)
  if (facts.length) return { ready: false, why: `a fact it states changed: ${facts.join(', ')}` }
  if (seal.profile !== now.profile) return { ready: false, why: seal.profile === undefined ? 'his profile was not part of the check that sealed it' : 'his profile changed since it was checked' }
  if (now.destination !== seal.destination) return { ready: false, why: 'its destination changed' }
  return { ready: true, why: null }
}

export interface FactSource { id: string; text: string }
const SENTENCE = /(?<=[.!?])\s+(?=["“'(A-Z0-9ÆØÅ])/
export function factSources(decisions: string, ledger: { id: string; text: string; status?: string }[] = []): FactSource[] {
  const out = new Map<string, FactSource>()
  for (const line of (decisions ?? '').split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    for (const s of l.replace(/^[-*]\s+/, '').split(SENTENCE).map(squash).filter(Boolean)) {
      const id = 'decisions:' + sha(s.toLowerCase()).slice(0, 16)
      if (!out.has(id)) out.set(id, { id, text: s })
    }
  }
  for (const f of ledger) if (f.status !== 'retired' && f.text?.trim()) out.set('ledger:' + f.id, { id: 'ledger:' + f.id, text: squash(f.text) })
  return [...out.values()]
}
export const factHash = (text: string): string => sha(squash(text).toLowerCase())
export function factLookup(sources: FactSource[]): (id: string) => string | undefined {
  const by = new Map(sources.map(s => [s.id, factHash(s.text)]))
  return id => by.get(id)
}

const WORD = /[\p{L}\p{N}]+/gu
const runOf = (w: string): number => w.trim().split(/\s+/).length
export function citedFacts(sources: FactSource[], leaves: string[], read: (file: string) => string | null, pageOf: (file: string) => string | null = () => null): CitedFact[] {
  const files = leaves.map(norm).filter(f => !isSharedUpload(f))
  const readable = files.filter(f => { const page = pageOf(f); return !(page && files.some(x => x.toLowerCase() === norm(page).toLowerCase())) })
  const cache = new Map<string, string | null>()
  const memo = (f: string): string | null => { if (!cache.has(f)) cache.set(f, read(f)); return cache.get(f)! }
  const blind = readable.some(f => memo(f) === null)
  const out: CitedFact[] = []
  for (const s of sources) {
    if ((s.text.match(WORD) ?? []).length < 2) continue
    const dropped = droppedWords([s.text], []).map(d => ({ ...d, words: d.words.filter(w => runOf(w) >= 2) })).filter(d => d.words.length)
    if (!dropped.length) continue
    if (blind || stillSays(dropped, readable, memo).found.length) out.push({ id: s.id, sha256: factHash(s.text) })
  }
  return out
}

function roleOf(file: string): OutwardLeave['role'] {
  const f = norm(file)
  if (isSharedUpload(f)) return 'attachment'
  if (/\.(?:txt|eml)$/i.test(f)) return 'message'
  return 'document'
}

export function coveredNow(context: unknown, required: string[], currentHash: (file: string) => string | undefined): { file: string; hash: string }[] | undefined {
  const files = context && typeof context === 'object' && !Array.isArray(context) ? (context as { files?: unknown }).files : undefined
  if (!Array.isArray(files) || !required.length) return undefined
  const key = (f: string): string => norm(f).toLowerCase()
  const basis = files.filter((f): f is { file: string; hash: string } => !!f && typeof f.file === 'string' && typeof f.hash === 'string')
  const current = basis.filter(f => currentHash(f.file) === f.hash)
  if (!required.every(s => current.some(f => key(f.file) === key(s)))) return undefined
  return current
}

export function sheetsCoveredNow(context: unknown, sheets: { file: string; key: string }[]): OutwardLeave[] | undefined {
  if (!sheets.length) return []
  const recorded = context && typeof context === 'object' && !Array.isArray(context) ? (context as { formSheets?: unknown }).formSheets : undefined
  if (!Array.isArray(recorded)) return undefined
  const key = (f: string): string => norm(f).toLowerCase()
  const out: OutwardLeave[] = []
  for (const s of sheets) {
    const r = recorded.find((x): x is { file: string; key: string } => !!x && typeof x.file === 'string' && typeof x.key === 'string' && key(x.file) === key(s.file))
    if (!r || r.key !== s.key) return undefined
    out.push({ file: norm(s.file), sha256: s.key, role: 'answers' })
  }
  return out
}

export const MAX_OUTWARD_ACTIONS = 100
export class OutwardActionStore {
  private readonly file: string
  constructor(stateDir: string) { this.file = join(stateDir, OUTWARD_ACTIONS_FILE) }
  list(): OutwardAction[] {
    if (!existsSync(this.file)) return []
    const raw = readJson<{ actions?: unknown }>(this.file, {})
    return Array.isArray(raw.actions) ? (raw.actions as OutwardAction[]).filter(a => !!a && typeof a.cardId === 'string') : []
  }
  forCard(cardId: string): OutwardAction | undefined { return this.list().find(a => a.cardId === cardId) }
  put(action: OutwardAction): void {
    const others = this.list().filter(a => a.cardId !== action.cardId)
    const kept = others.length >= MAX_OUTWARD_ACTIONS ? new Set([...others].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, MAX_OUTWARD_ACTIONS - 1)) : undefined
    writeJson(this.file, { version: 1, actions: [...(kept ? others.filter(a => kept.has(a)) : others), action] })
  }
}

export interface SealCard { id: string; kind?: string; url?: string; to?: { name: string; contact?: string }; files: string[] }
export interface SealLane { id: string; scope?: string; context?: unknown; reports: { at: string }[] }
export interface SealInput {
  projectId: string
  card: SealCard
  required: string[]
  sheets?: { file: string; key: string }[]
  sends: string[]
  passed?: SealLane
  laneNow: (id: string) => { reports: { at: string }[]; passes: boolean; retired?: boolean; refused?: boolean } | undefined
  currentHash: (file: string) => string | undefined
  facts: FactSource[]
  read: (file: string) => string | null
  pageOf?: (file: string) => string | null
  at?: string
  profile?: { hash: string; basis?: string }
}
const PROFILE_MOVED = 'moved-since-its-check'
function profileSeal(input: SealInput, lane: SealLane, earlier: boolean): string | undefined {
  if (!input.profile) return undefined
  const ctx = lane.context && typeof lane.context === 'object' && !Array.isArray(lane.context) ? (lane.context as { facts?: unknown }).facts : undefined
  const read = typeof ctx === 'string' && input.profile.basis !== undefined ? ctx === input.profile.basis : undefined
  if (earlier) return read === true ? input.profile.hash : undefined
  return read === false ? PROFILE_MOVED : input.profile.hash
}
export function syncSeal(store: OutwardActionStore, input: SealInput): { action?: OutwardAction; changed: boolean } {
  const kind = input.card.kind as OutwardKind | undefined
  if (kind !== 'submit' && kind !== 'send' && kind !== 'sign' && kind !== 'pay' && kind !== 'deliver') return { changed: false }
  const at = input.at ?? new Date().toISOString()
  const stored = store.forCard(input.card.id)
  const destination = destinationOf(input.card)
  const destKey = destinationKey(destination)
  const moved = !!stored && destinationKey(stored.destination) !== destKey
  const existing: OutwardAction | undefined = stored && moved ? { ...stored, destination, destinationAt: at, updatedAt: at } : stored
  const lastAt = input.passed?.reports.at(-1)?.at
  const afterDestination = !!lastAt && (!existing?.destinationAt || lastAt > existing.destinationAt)
  const coveredFiles = input.passed && lastAt && afterDestination ? coveredNow(input.passed.context, input.required, input.currentHash) : undefined
  const sheetLeaves = coveredFiles && input.passed ? sheetsCoveredNow(input.passed.context, input.sheets ?? []) : undefined
  if (input.passed && lastAt && coveredFiles && sheetLeaves) {
    const key = (f: string): string => norm(f).toLowerCase()
    const sends = new Set(input.sends.map(key))
    const sheetNames = new Set(sheetLeaves.map(l => key(l.file)))
    const leaves: OutwardLeave[] = [
      ...coveredFiles.filter(f => sends.has(key(f.file))).map(f => ({ file: norm(f.file), sha256: f.hash, role: roleOf(f.file) })),
      ...sheetLeaves
    ]
    const bytes = sealBytes(leaves)
    const sameReport = !!existing?.seal && existing.seal.checkId === input.passed.id && existing.seal.reportAt === lastAt
    if (sameReport && existing!.seal!.bytes === bytes && existing!.seal!.destination === destKey) {
      const profile = existing!.seal!.profile === undefined ? profileSeal(input, input.passed, true) : undefined
      if (profile !== undefined) {
        const action: OutwardAction = { ...existing!, seal: { ...existing!.seal!, profile }, updatedAt: at }
        store.put(action)
        return { action, changed: true }
      }
      if (moved) { store.put(existing!); return { action: existing, changed: true } }
      return { action: existing, changed: false }
    }
    if (!sameReport || existing!.seal!.destination === destKey) {
      const byBytes = new Set(leaves.filter(l => l.role !== 'answers').map(l => key(l.file)))
      const sheetText = (f: string): string | null => { const t = input.read(f); if (t === null || !sheetNames.has(key(f)) || byBytes.has(key(f))) return t; return formAnswers(t)?.answers ?? t }
      const factsCited = citedFacts(input.facts, [...new Set(leaves.map(l => l.file))], sheetText, input.pageOf)
      const action: OutwardAction = {
        id: existing?.id ?? randomUUID(), projectId: input.projectId, cardId: input.card.id, kind, destination, leaves, factsCited,
        seal: (() => { const profile = profileSeal(input, input.passed!, false); return { checkId: input.passed!.id, reportAt: lastAt, at, bytes, facts: factsKey(factsCited), destination: destKey, ...(input.passed!.scope ? { scope: input.passed!.scope } : {}), ...(profile !== undefined ? { profile } : {}) } })(),
        settled: existing?.settled ?? [], notes: existing?.notes ?? [], ...(existing?.shadow ? { shadow: existing.shadow } : {}),
        ...(existing?.destinationAt ? { destinationAt: existing.destinationAt } : {}),
        ...(existing?.press ? { press: existing.press } : {}), ...(existing?.handover ? { handover: existing.handover } : {}),
        createdAt: existing?.createdAt ?? at, updatedAt: at
      }
      store.put(action)
      return { action, changed: true }
    }
  }
  if (existing?.seal) {
    const lane = input.laneNow(existing.seal.checkId)
    const latest = lane?.reports.at(-1)?.at
    const why = !lane ? 'is gone' : lane.retired ? 'was set aside' : lane.refused ? 'finds a fault in what leaves on the report it sealed on' : latest !== existing.seal.reportAt ? (lane.passes ? `answered again on ${latest} on other bytes than these` : `answered again on ${latest} and does not pass`) : null
    if (why) {
      const { seal: _seal, ...rest } = existing
      void _seal
      const action: OutwardAction = { ...rest, notes: [...existing.notes, { at, from: 'damon', text: `The check that sealed this (${existing.seal.checkId}) ${why}, so the seal came off.`, class: 'bookkeeping' as const }].slice(-20), updatedAt: at }
      store.put(action)
      return { action, changed: true }
    }
  }
  if (existing && moved) { store.put(existing); return { action: existing, changed: true } }
  return { action: existing, changed: false }
}

export interface CardSealItem { id: string; kind?: string; url?: string; to?: { name: string; contact?: string }; files?: string[]; file?: string }
export interface CardSealDeps<L extends ReadyLane & { reports: { at: string }[]; retired?: unknown }> {
  projectId: string
  store: OutwardActionStore
  lanes: L[]
  clear: (lane: L) => boolean
  refuses?: (lane: L) => boolean
  failsOutward?: (lane: L) => boolean
  currentHash: (file: string) => string | undefined
  text: (file: string) => string | undefined
  decisions: string
  ledger: { id: string; text: string; status?: string }[]
  sends: (files: string[]) => string[]
  read: (file: string) => string | null
  pageOf?: (file: string) => string | null
  at?: string
  profile?: string
  profileBasis?: string
}
export function sealForCard<L extends ReadyLane & { reports: { at: string }[]; retired?: unknown }>(item: CardSealItem, deps: CardSealDeps<L>): { action?: OutwardAction; answer: ReadyAnswer; lane?: L; faulted?: L } {
  const files = [...new Set([...(item.files ?? []), ...(item.file ? [item.file] : [])])]
  const live = deps.lanes.filter(x => !x.retired)
  const required = cardSentFiles(files)
  const on = readyOn(live, { files, sent: required }, x => deps.clear(x as L), () => '')
  const passed = on.passedId ? live.find(x => x.id === on.passedId) : undefined
  const sheets = formSheetKeys(files, { currentHash: deps.currentHash, text: deps.text })
  const sources = factSources(deps.decisions, deps.ledger)
  const sealNow = deps.store.forCard(item.id)?.seal
  const current = [on.passedId, on.outstandingId].filter((x): x is string => !!x)
  const lastAt = (l: L): string | undefined => (l.reports as { at: string }[]).at(-1)?.at
  const newestAfter = (seal: OutwardSeal): L | undefined => deps.lanes
    .filter(l => !l.retired && (l.id === seal.checkId || (!!seal.scope && l.scope === seal.scope) || current.includes(l.id)))
    .filter(l => { const at = lastAt(l); return !!at && at > seal.reportAt })
    .sort((a, b) => ((lastAt(a) ?? '') < (lastAt(b) ?? '') ? 1 : -1))[0]
  const key = (f: string): string => norm(f).toLowerCase()
  const own = required.filter(f => !isSharedUpload(norm(f)))
  const coversNow = (l: L): boolean => {
    const ctx = l.context && typeof l.context === 'object' && !Array.isArray(l.context) ? (l.context as { files?: unknown }).files : undefined
    if (!Array.isArray(ctx) || !own.length) return false
    const basis = ctx.filter((f): f is { file: string; hash: string } => !!f && typeof f === 'object' && typeof (f as { file?: unknown }).file === 'string')
    return own.every(r => basis.some(f => key(f.file) === key(r) && deps.currentHash(f.file) === f.hash))
  }
  const faultedAfter = (since: string | undefined): L | undefined => !deps.failsOutward || !since ? undefined : live.find(l => { const at = lastAt(l); return !!at && at > since && coversNow(l) && deps.failsOutward!(l) })
  const sealable = passed && !faultedAfter(lastAt(passed)) ? passed : undefined
  const { action } = syncSeal(deps.store, {
    projectId: deps.projectId, card: { id: item.id, kind: item.kind, url: item.url, to: item.to, files },
    required, sheets, sends: deps.sends(files), passed: sealable,
    laneNow: id => {
      if (sealNow && sealNow.checkId === id) {
        const next = newestAfter(sealNow)
        if (next) return { reports: next.reports, passes: deps.clear(next) }
        const own = deps.lanes.find(l => l.id === id && !l.retired)
        if (own && lastAt(own) === sealNow.reportAt && deps.refuses?.(own)) return { reports: own.reports, passes: false, refused: true }
        if (faultedAfter(sealNow.reportAt)) return { reports: [{ at: sealNow.reportAt }], passes: false, refused: true }
        return { reports: [{ at: sealNow.reportAt }], passes: true }
      }
      const x = deps.lanes.find(l => l.id === id); return x ? { reports: x.reports, passes: !x.retired && deps.clear(x), retired: !!x.retired } : undefined
    },
    currentHash: deps.currentHash, facts: sources, read: deps.read, pageOf: deps.pageOf, at: deps.at,
    ...(deps.profile !== undefined ? { profile: { hash: factHash(deps.profile), basis: deps.profileBasis } } : {})
  })
  const answers = (f: string): string | undefined => formSheetKey(deps.text(f)) ?? deps.currentHash(f)
  const lane = current.length ? live.find(x => x.id === current[0]) : undefined
  const faulted = faultedAfter(sealNow?.reportAt ?? (passed ? lastAt(passed) : undefined))
  return { action, lane, ...(faulted && !action?.seal ? { faulted } : {}), answer: ready(action, { bytes: sealedBytesNow(action, deps.currentHash, deps.pageOf), answers, facts: factLookup(sources), destination: destinationKey(destinationOf(item)), required: [...required, ...sheets.map(s => s.file)], ...(deps.profile !== undefined ? { profile: factHash(deps.profile) } : {}) }) }
}

export interface OutwardCheckConfig { isOutward: (id: string) => boolean; required: readonly string[] }
export interface OutwardVerdict { answered: boolean; passes: boolean; why: string | null }
export interface VerdictLane {
  reports: { checks?: { id: string; status: string; observed?: string; evidence?: string[] }[]; problems?: string[]; parsed?: { findings?: { where: string; what: string }[] } }[]
  context?: unknown; decisionHold?: unknown; retired?: unknown; carriedFindings?: { where: string; what: string }[]
}
export interface VerdictWords { read: (file: string) => string | null; form: boolean }
export function outwardVerdict(lane: VerdictLane, cfg: OutwardCheckConfig, exempt: (file: string) => boolean = () => false, words?: VerdictWords): OutwardVerdict {
  if (lane.retired) return { answered: false, passes: false, why: 'its check was replaced and has not answered since' }
  const last = lane.reports.at(-1)
  if (!last) return { answered: false, passes: false, why: 'no check has answered yet' }
  if (lane.decisionHold) return { answered: false, passes: false, why: 'your decisions changed and a file that leaves still says the old words' }
  const checks = last.checks ?? []
  const said = (s: string | undefined): string => squash(s ?? '').slice(0, 400)
  const fails = checks.filter(c => cfg.isOutward(c.id) && c.status === 'fail').map(c => `The ${c.id} check found: ${said(c.observed) || 'a fault in what leaves'}`)
  if (fails.length) return { answered: true, passes: false, why: fails.join(' ') }
  const unfinished: string[] = []
  for (const id of cfg.required) if (!checks.some(c => c.id === id)) unfinished.push(`the ${id} check did not run`)
  for (const c of checks.filter(c => cfg.isOutward(c.id))) {
    if (c.status !== 'pass') unfinished.push(`the ${c.id} check could not finish: ${said(c.observed)}`)
    else if (!(c.evidence ?? []).length) unfinished.push(`the ${c.id} check passed with no evidence`)
  }
  const ctx = lane.context && typeof lane.context === 'object' && !Array.isArray(lane.context) ? lane.context as { files?: unknown; unreadable?: unknown } : {}
  const files = (Array.isArray(ctx.files) ? ctx.files : []).map(f => (f && typeof f === 'object' ? String((f as { file?: unknown }).file ?? '') : String(f))).map(norm).filter(f => f && !exempt(f))
  const escape = (s: string): string => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
  const names = (text: string): string | undefined => {
    const t = norm(text).toLowerCase()
    return files.find(f => t.includes(f.toLowerCase()) || new RegExp('(?:^|[\\s/"\'(])' + escape((f.split('/').pop() ?? f).toLowerCase()) + '(?![\\w.-])').test(t))
  }
  for (const p of last.problems ?? []) {
    const m = /^([^:]+): evidence was not independently inspected: (.+)$/s.exec(p)
    if (!m || !cfg.isOutward(m[1]!.trim())) continue
    const file = names(m[2]!.replace(/https?:\/\/\S+/gi, ' '))
    if (file) unfinished.push(`the ${m[1]!.trim()} check did not read ${file}`)
  }
  for (const u of Array.isArray(ctx.unreadable) ? ctx.unreadable : []) {
    const f = norm(String(u))
    if (files.some(x => x.toLowerCase() === f.toLowerCase())) unfinished.push(`Damon's check could not read ${f}`)
  }
  if (unfinished.length) return { answered: false, passes: false, why: unfinished[0]! }
  const worded = words ? wordFaults(lane, last, cfg, words) : null
  if (worded) return { answered: true, passes: false, why: worded }
  return { answered: true, passes: true, why: null }
}

function wordFaults(lane: VerdictLane, last: VerdictLane['reports'][number], cfg: OutwardCheckConfig, words: VerdictWords): string | null {
  const findings = last.parsed?.findings ?? []
  const checks = (last.checks ?? []).filter(c => c.status !== 'pass' && !cfg.isOutward(c.id))
  const print = checks.find(c => c.status === 'fail' && /print/i.test(c.id))
  if (print) return `The ${print.id} check found: ${squash(print.observed ?? '').slice(0, 400) || 'a fault in a page that leaves'}`
  if (!findings.length && !checks.length) return null
  const ctx = lane.context && typeof lane.context === 'object' && !Array.isArray(lane.context) ? lane.context as { files?: unknown; formSheets?: unknown } : {}
  const docs = (Array.isArray(ctx.files) ? ctx.files : []).map(f => norm(f && typeof f === 'object' ? String((f as { file?: unknown }).file ?? '') : String(f))).filter(Boolean)
  const onCard = (Array.isArray(ctx.formSheets) ? ctx.formSheets : []).map(s => norm(s && typeof s === 'object' ? String((s as { file?: unknown }).file ?? '') : String(s))).filter(Boolean)
  const sheets = words.form ? onCard : []
  const cache = new Map<string, string | null>()
  const read = (f: string): string | null => { if (!cache.has(f)) { let t: string | null = null; try { t = words.read(f) } catch { t = null } cache.set(f, t) } return cache.get(f)! }
  const sealed: SealedTexts = {
    docs: (() => {
      const isPdf = (f: string): boolean => /\.pdf$/i.test(f)
      const plain = docs.filter(f => !isPdf(f)).map(file => ({ file, text: read(file) }))
      const anyRead = plain.some(d => d.text !== null)
      return [...plain, ...docs.filter(isPdf).map(file => ({ file, text: anyRead ? '' : read(file) }))]
    })(),
    sheets: sheets.flatMap(file => { const t = read(file); if (t === null) return []; const fa = formAnswers(t); return [{ file, answers: fa?.answers ?? t, headings: fa?.headings ?? [] }] }),
    filedIn: onCard.flatMap(file => { const t = read(file); return t === null ? [] : [{ file, text: t }] })
  }
  for (const f of findings) {
    const why = sealedWordFault({ where: f.where, what: f.what }, sealed)
    if (why) return `A finding ${why} and reports a fault: ${squash(`${f.where}: ${f.what}`).slice(0, 400)}`
  }
  const earlier = [...lane.reports.flatMap(r => r.parsed?.findings ?? []), ...(lane.carriedFindings ?? [])]
  for (const c of checks) {
    const finding = c.id.startsWith('finding-') ? earlier.find(f => findingKey(f) === c.id) : undefined
    const why = sealedWordFault({ what: c.observed ?? '', evidence: c.evidence, ...(finding ? { finding } : {}) }, sealed)
    if (why) return `The ${c.id} check ${why} and reports a fault: ${squash(c.observed ?? '').slice(0, 400)}`
  }
  return null
}

export interface SealGate { ready: boolean; key?: string; refused?: string; waiting?: string }
export function sealGate(action: OutwardAction | undefined, answer: ReadyAnswer, verdict: OutwardVerdict | undefined): SealGate {
  if (answer.ready && action?.seal) return { ready: true, key: `seal:${action.seal.bytes}:${action.seal.facts}` }
  if (verdict?.answered && !verdict.passes && verdict.why) return { ready: false, refused: verdict.why }
  if (/^no seal/.test(answer.why ?? '') && verdict?.why) return { ready: false, waiting: verdict.why }
  return { ready: false, waiting: answer.why ?? verdict?.why ?? 'no check has answered yet' }
}

export const PRESS_WAIT_MS = 60 * 60_000
export function pressKey(required: string[], sheets: { file: string; key: string }[], currentHash: (file: string) => string | undefined): string {
  return sealBytes([...required.map(f => ({ file: f, sha256: currentHash(f) ?? 'missing' })), ...sheets.map(s => ({ file: s.file, sha256: s.key }))])
}
export type PressStep = { step: 'none' } | { step: 'wait' } | { step: 'go' } | { step: 'lapse'; why: 'moved' | 'late' | 'refused' }
export function pressStep(press: OutwardAction['press'], now: { key: string; ready: boolean; checking: boolean; at: number }): PressStep {
  if (!press) return { step: 'none' }
  if (now.key !== press.bytes) return { step: 'lapse', why: 'moved' }
  if (now.ready) return { step: 'go' }
  if (now.at - Date.parse(press.at) > PRESS_WAIT_MS) return { step: 'lapse', why: 'late' }
  if (now.checking) return { step: 'wait' }
  return { step: 'lapse', why: 'refused' }
}

export function sealedBytesNow(action: OutwardAction | undefined, currentHash: (file: string) => string | undefined, pageOf?: (file: string) => string | null): (file: string) => string | undefined {
  const same = (a: string, b: string): boolean => norm(a).toLowerCase() === norm(b).toLowerCase()
  return file => {
    const now = currentHash(file)
    const leaf = action?.leaves.find(l => l.role !== 'answers' && same(l.file, file))
    if (!leaf || now === leaf.sha256 || !pageOf || !/\.pdf$/i.test(file)) return now
    const page = pageOf(file)
    const pageLeaf = page ? action!.leaves.find(l => l.role !== 'answers' && same(l.file, page)) : undefined
    return pageLeaf && currentHash(page!) === pageLeaf.sha256 ? leaf.sha256 : now
  }
}

export function shadowOf(action: OutwardAction | undefined, answer: ReadyAnswer, gate: string | null, at: string): OutwardShadow | null {
  const agree = answer.ready === !gate
  const prev = action?.shadow
  if (prev && prev.ready === answer.ready && prev.why === answer.why && prev.gate === gate) return null
  return { at, ready: answer.ready, why: answer.why, gate, agree }
}

export interface SealedLeaves { id: string; bytes: string; leaves: { file: string; hash: string }[]; answers?: string[] }
export function sealedLeaves(action: OutwardAction | undefined, answer: ReadyAnswer, currentHash?: (file: string) => string | undefined): SealedLeaves | undefined {
  if (!answer.ready || !action?.seal) return undefined
  return { id: action.id, bytes: action.seal.bytes, leaves: action.leaves.filter(l => l.role !== 'answers' && (!currentHash || currentHash(l.file) === l.sha256)).map(l => ({ file: l.file, hash: l.sha256 })), answers: action.leaves.filter(l => l.role === 'answers').map(l => l.file) }
}

export type FillerUse = 'whole' | 'answers' | 'skip'
export function fillerUse(sealed: { files: { file: string }[]; answers?: string[] } | undefined, file: string): FillerUse {
  if (!sealed) return 'whole'
  const k = norm(file).toLowerCase()
  if (sealed.files.some(f => norm(f.file).toLowerCase() === k)) return 'whole'
  if ((sealed.answers ?? []).some(f => norm(f).toLowerCase() === k)) return 'answers'
  return 'skip'
}
