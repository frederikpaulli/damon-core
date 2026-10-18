import { existsSync, lstatSync, readFileSync, statSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { deliveryScope, deliveryStage } from '../../shared/delivery'
import { resolveInside } from './file-browser'
import { lineLooksLikeSecret } from './git-save'
import { ARCHIVE_FILE, mergeArchived, shelvedPlans } from './work-needs-archive'

export function requireReviewedText(text: string): string {
  const inspect = text.replace(/\\"/g, '"')
  if (lineLooksLikeSecret(inspect) || /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~-]{20,}|"(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)"\s*:\s*"[^"\s]{12,}"/i.test(inspect)) throw Error('The proposed model input contains a possible credential. Review it before continuing.')
  return text
}
export const PROTECTED_CONTEXT_LIMIT_BYTES = 384 * 1024
export const PROTECTED_CONTEXT_TARGET_BYTES = 256 * 1024
const KEEP_CHARS = 300
const KEEP_CHARS_RECENT = 3000
const RECENT_TASKS = 5
const RECORD_BUDGET_BYTES = 48 * 1024
const IDENTITY_BUDGET_BYTES = 16 * 1024
const BRAIN_FILE_LIMIT = 8 * 1024 * 1024
const KEEP_CHARS_BRAIN = 16000
const BRAIN_NOTE = 'This file is longer than fits in a snapshot, so its END is here: `tail` is its last characters, `omittedChars` is how many came before, and `sha256` is the hash of the whole file. Nothing was deleted. Call read_in_full with that sha256 to read it from the beginning, and pass the `nextFrom` it answers with back as `from` to carry on. Do not guess what the omitted part said.'
const PROJECTED_FILE_LIMIT = 8 * 1024 * 1024
const PROJECTED_RECORDS = ['tasks.json', 'critiques.json', 'agents.json', 'your-turn.json'] as const
export const PROJECTION_NOTE = 'Long texts inside ' + PROJECTED_RECORDS.join(', ') + ' are shortened here. Where one was, `{ head, omittedChars, sha256 }` gives its first characters, how many characters were left out, and the sha256 of the whole original. Nothing was deleted and nothing is out of reach: call `read_in_full` with that sha256 to read the whole text, and pass the `nextFrom` it answers with back as `from` to carry on through a long one. Read it before relying on it; do not claim to have read an omitted text you did not fetch, and do not guess what it said.'
export interface ShortenedText { head: string; omittedChars: number; sha256: string }
const shorten = (text: string, keep: number): string | ShortenedText =>
  text.length <= keep ? text : { head: text.slice(0, keep), omittedChars: text.length - keep, sha256: createHash('sha256').update(text).digest('hex') }
function projectText(value: unknown, keep: number): unknown {
  if (typeof value === 'string') return shorten(value, keep)
  if (Array.isArray(value)) return value.map(item => projectText(item, keep))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectText(item, keep)]))
  return value
}
const finishedLine = (task: Loose): Loose => {
  const review = task.review && typeof task.review === 'object' ? { satisfied: (task.review as Loose).satisfied, at: (task.review as Loose).at } : undefined
  return {
    id: task.id, agentId: task.agentId, title: task.title, ...(task.label !== undefined ? { label: task.label } : {}), status: task.status, ...(task.round !== undefined ? { round: task.round } : {}),
    createdAt: task.createdAt, updatedAt: task.updatedAt, ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.changedFiles !== undefined ? { changedFiles: task.changedFiles } : {}), ...(task.deliverableIds !== undefined ? { deliverableIds: task.deliverableIds } : {}),
    ...(review ? { review } : {}), finishedLine: true
  }
}
const taskAsHandedOver = (task: unknown): unknown => {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task
  const { builtOn, sessionId: _sessionId, inputUpdates, ...rest } = task as Record<string, unknown>
  const counted = Array.isArray(inputUpdates) ? { ...rest, inputUpdateCount: inputUpdates.length } : rest
  return Array.isArray(builtOn)
    ? { ...counted, builtOn: builtOn.map(stamp => (stamp && typeof stamp === 'object' ? (stamp as { file?: unknown }).file : stamp)) }
    : counted
}

type Loose = Record<string, unknown>
const isList = (x: unknown): x is Loose[] => Array.isArray(x)
const settled = (need: Loose): boolean => Boolean(need.retired || need.ownerDecision || (need.answer !== undefined && need.answer !== null && need.answer !== ''))
const planIsOpen = (plan: Loose): boolean => isList(plan.needs) && plan.needs.some(need => !settled(need))
const taskIsFinished = (task: unknown): boolean => {
  const status = (task as { status?: unknown } | null)?.status
  return status === 'approved' || status === 'failed'
}
const sha256Of = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function shapeForTurn(name: string, value: unknown, closedAsStub = false): unknown {
  if (!value || typeof value !== 'object') return value
  if (name === 'work-needs.json' && isList((value as { plans?: unknown }).plans)) {
    return { ...(value as Loose), plans: ((value as { plans: Loose[] }).plans)
      .filter(plan => !(isList(plan.needs) && plan.needs.length > 0 && plan.needs.every(need => need.retired)))
      .map(plan => {
        if (closedAsStub && !planIsOpen(plan)) return { id: plan.id, title: typeof plan.title === 'string' ? shorten(plan.title, 120) : plan.title, closed: true, sha256: sha256Of(plan) }
        const needs = isList(plan.needs) ? plan.needs.map(need => {
          const { history: _history, ...rest } = need
          if (!settled(need)) return rest
          const { why: _why, sources: _sources, ...answered } = rest
          return answered
        }) : plan.needs
        const open = isList(needs) && needs.some(need => !settled(need))
        if (open) return { ...plan, needs }
        const { context: _context, verified: _verified, ...closed } = plan
        return { ...closed, needs: isList(needs) ? needs.map(need => need.answer !== undefined && need.answer !== null ? { ...need, answer: projectText(need.answer, 200) } : need) : needs }
      }) }
  }
  if (name === 'critiques.json') {
    const live = (item: Loose): Loose => {
      const { context: _context, tasks: _tasks, carriedFindings, carriedChallenges, carriedOrigins, ...rest } = item
      const decided = new Set<unknown>([...(isList(item.ownerDecisions) ? item.ownerDecisions.map(d => (d as Loose).challenge) : []), ...(isList(item.releasedChallenges) ? item.releasedChallenges : [])])
      const open = isList(carriedChallenges) ? carriedChallenges.filter(c => !decided.has(c)) : []
      const all = isList(item.reports) ? item.reports : []
      const reports = all.map((report, i) => {
        const { raw: _raw, ...kept } = report as Loose
        if (i === all.length - 1) {
          if (!isList(kept.checks)) return kept
          const failing = kept.checks.filter(check => (check as Loose)?.status !== 'pass')
          return { ...kept, checks: failing, passedChecks: kept.checks.length - failing.length }
        }
        const parsed = (kept.parsed ?? {}) as Loose
        return { at: kept.at, taskId: kept.taskId, findings: isList(parsed.findings) ? parsed.findings.length : 0, problems: isList(kept.problems) ? kept.problems.length : 0 }
      })
      return { ...rest, reports, carriedChallenges: open, carriedFindingCount: isList(carriedFindings) ? carriedFindings.length : 0, ...(carriedOrigins && typeof carriedOrigins === 'object' ? { carriedOriginCount: Object.keys(carriedOrigins).length } : {}) }
    }
    const stub = (item: Loose): Loose => item.retired
      ? { id: item.id, scope: item.scope, retired: true, basis: item.basis, createdAt: item.createdAt, reports: isList(item.reports) ? item.reports.length : 0 }
      : live(item)
    if (isList(value)) return value.map(stub)
    const record = value as Loose
    const listed = Object.entries(record).find(([, item]) => isList(item))
    return listed ? { ...record, [listed[0]]: (listed[1] as Loose[]).map(stub) } : value
  }
  if (name === 'your-turn.json') {
    const recent = Date.now() - 6 * 60 * 60_000
    const stub = (item: Loose): Loose => typeof item.doneAt === 'string' && Date.parse(item.doneAt) < recent
      ? { id: item.id, title: item.title, kind: item.kind, doneAt: item.doneAt, ...(item.closedAs ? { closedAs: item.closedAs } : {}), ...(item.replacedBy ? { replacedBy: item.replacedBy } : {}) }
      : item
    const trim = (items: Loose[]): Loose[] => {
      const shaped = items.map(stub)
      const old = shaped.filter(item => typeof item.doneAt === 'string' && Date.parse(item.doneAt) < recent)
      if (old.length <= 20) return shaped
      const keep = new Set(old.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 20))
      return [...shaped.filter(item => !old.includes(item) || keep.has(item)), { olderFinishedCards: old.length - 20, note: 'Older finished cards are on record and were left out of this snapshot; none of them needs anything.' }]
    }
    if (isList(value)) return trim(value)
    const record = value as Loose
    const listed = Object.entries(record).find(([, item]) => isList(item))
    return listed ? { ...record, [listed[0]]: trim(listed[1] as Loose[]) } : value
  }
  if (name === 'work-order.json' && isList((value as { artifacts?: unknown }).artifacts)) {
    const artifacts = (value as { artifacts: Loose[] }).artifacts
    const latest = new Map<string, Loose>()
    for (const a of artifacts) if (typeof a.file === 'string') latest.set(a.file, a)
    return { ...(value as Loose), artifacts: artifacts.filter(a => latest.get(a.file as string) === a).map(({ files: _files, ...rest }) => rest) }
  }
  return value
}
export interface OmittedEntries { omittedEntries: number; sha256: string; note: string; ids?: unknown[]; moreIds?: number }

const FINISHED_NOTE = 'Finished entries were left out of this snapshot so the open work fits. Nothing was deleted and none of them needs anything: `ids` names them, and read_in_full with this sha256 returns them all (use nextFrom as from to continue). Do not guess what they said.'
const FINISHED_IDS_SHOWN = 100
const ARCHIVED_NOTE = 'Older closed plans moved to work-needs-archive.json. None of them needs anything and nothing was deleted: `ids` names them, every tool still finds any of them by its id, and read_in_full with this sha256 returns them all (use nextFrom as from to continue). Do not guess what they said.'
function splitFinished(name: string, value: unknown): { rest: unknown; finished: Loose[] } | null {
  if (!value || typeof value !== 'object') return null
  const isDone: ((entry: Loose) => boolean) | null =
    name === 'work-needs.json' ? plan => !planIsOpen(plan)
    : name === 'tasks.json' ? taskIsFinished
    : doneTest(name)
  if (!isDone) return null
  const key = name === 'work-needs.json' ? 'plans' : isList(value) ? null : Object.entries(value as Loose).find(([, item]) => isList(item))?.[0]
  if (key === undefined) return null
  const list = (key === null ? value : (value as Loose)[key]) as unknown
  if (!isList(list)) return null
  const finished = list.filter(entry => isDone(entry))
  const kept = list.filter(entry => !isDone(entry))
  return { rest: key === null ? kept : { ...(value as Loose), [key]: kept }, finished }
}
const ENTRIES_NOTE = 'Older entries were left out of this snapshot. Nothing was deleted: call read_in_full with this sha256 to read the omitted collection, then use nextFrom as from to continue. Record-level sha256 references retrieve that whole record the same way. Do not guess what omitted entries said or treat this list as the whole record.'

const IDENTITY_KEYS = ['id', 'title', 'status', 'at', 'createdAt', 'updatedAt', 'kind', 'taskIds']
const identityOf = (entry: unknown): unknown => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const row = entry as Record<string, unknown>
  const stub: Record<string, unknown> = {}
  for (const key of IDENTITY_KEYS) if (row[key] !== undefined) stub[key] = shorten(String(row[key]), 200)
  stub.sha256 = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
  stub.onlyItsName = true
  return stub
}

function keepWhatFits(entries: unknown[], project: (entry: unknown, indexFromEnd: number) => unknown, budget: number = RECORD_BUDGET_BYTES): { kept: unknown[]; omitted?: OmittedEntries } {
  const kept: unknown[] = []
  let spent = 0
  let taken = 0
  let full = 0
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const projected = project(entries[i], taken)
    const cost = Buffer.byteLength(JSON.stringify(projected) ?? '') + 1
    if (spent + cost > budget && kept.length > 0) { full = i + 1; break }
    kept.unshift(projected)
    spent += cost
    taken += 1
  }
  for (let i = full - 1; i >= 0; i -= 1) {
    const stub = identityOf(entries[i])
    const cost = Buffer.byteLength(JSON.stringify(stub) ?? '') + 1
    if (spent + cost > budget + IDENTITY_BUDGET_BYTES) break
    kept.unshift(stub)
    spent += cost
  }
  if (kept.length === entries.length) return { kept }
  const omitted = entries.slice(0, entries.length - kept.length)
  return {
    kept,
    omitted: { omittedEntries: omitted.length, sha256: createHash('sha256').update(JSON.stringify(omitted)).digest('hex'), note: ENTRIES_NOTE }
  }
}

const LEVELS = [
  { recent: KEEP_CHARS_RECENT, recentTasks: RECENT_TASKS, keep: KEEP_CHARS, messages: 100, budget: RECORD_BUDGET_BYTES },
  { recent: 1500, recentTasks: 3, keep: KEEP_CHARS, messages: 60, budget: RECORD_BUDGET_BYTES },
  { recent: 800, recentTasks: 1, keep: 200, messages: 40, budget: 32 * 1024 },
  { recent: 400, recentTasks: 1, keep: 150, messages: 20, budget: 20 * 1024 }
] as const

const doneTest = (name: string): ((entry: Loose) => boolean) | null =>
  name === 'critiques.json' ? item => Boolean(item?.retired)
  : name === 'your-turn.json' ? card => typeof card?.doneAt === 'string'
  : null
function keepOpenAndWhatFits(entries: unknown[], isDone: (entry: Loose) => boolean, project: (entry: unknown) => unknown, budget: number): { kept: unknown[]; omitted?: OmittedEntries } {
  const done = entries.filter(entry => isDone(entry as Loose))
  const openCost = entries.filter(entry => !isDone(entry as Loose)).reduce<number>((sum, entry) => sum + Buffer.byteLength(JSON.stringify(project(entry)) ?? '') + 1, 0)
  const budgeted = keepWhatFits(done, project, Math.max(0, budget - openCost))
  const from = done.length - budgeted.kept.length
  const kept: unknown[] = []
  let seen = 0
  let taken = 0
  for (const entry of entries) {
    if (isDone(entry as Loose)) { if (seen++ >= from) kept.push(budgeted.kept[taken++]); continue }
    kept.push(project(entry))
  }
  return { kept, omitted: budgeted.omitted }
}

function projectRecord(name: string, value: unknown, level = 0): { projected: unknown; omitted?: OmittedEntries } {
  const L = LEVELS[Math.min(level, LEVELS.length - 1)]!
  const isDone = doneTest(name)
  const budgetList = (list: unknown[]): { kept: unknown[]; omitted?: OmittedEntries } => isDone
    ? keepOpenAndWhatFits(list, isDone, entry => projectText(entry, L.keep), L.budget)
    : keepWhatFits(list, entry => projectText(entry, L.keep), L.budget)
  if (Array.isArray(value)) {
    if (name !== 'tasks.json') {
      const { kept, omitted } = budgetList(value)
      return { projected: kept, omitted }
    }
    const finished = taskIsFinished
    const open = value.filter(task => !finished(task))
    const done = value.filter(finished)
    const keepOpen = (project: (task: unknown, fromEnd: number) => unknown): { kept: unknown[]; omitted?: OmittedEntries } => {
      const budgeted = keepWhatFits(done, (task, fromEnd) => project(task, fromEnd + open.length), L.budget)
      const keep = new Set(budgeted.kept.map((_, i) => done[done.length - budgeted.kept.length + i]))
      const kept: unknown[] = []
      let taken = 0
      for (let i = 0; i < value.length; i += 1) {
        const task = value[i]
        if (finished(task)) { if (keep.has(task)) kept.push(budgeted.kept[taken++]) ; continue }
        kept.push(project(task, value.length - 1 - i))
      }
      return { kept, omitted: budgeted.omitted }
    }
    const asHanded = (task: unknown): unknown => finished(task) ? finishedLine(taskAsHandedOver(task) as Loose) : taskAsHandedOver(task)
    const generous = keepOpen((task, fromEnd) => projectText(asHanded(task), fromEnd < L.recentTasks ? L.recent : L.keep))
    if (!generous.omitted) return { projected: generous.kept }
    const narrow = keepOpen((task, fromEnd) => projectText(asHanded(task), fromEnd < 1 ? L.recent : L.keep))
    return { projected: narrow.kept, omitted: narrow.omitted }
  }
  const shaped: unknown = shapeForTurn(name, value)
  if (shaped && typeof shaped === 'object') {
    const record = shaped as Record<string, unknown>
    const listed = Object.entries(record).find(([, item]) => Array.isArray(item))
    if (listed) {
      const [key, item] = listed
      const { kept, omitted } = budgetList(item as unknown[])
      return {
        projected: { ...(projectText({ ...record, [key]: [] }, KEEP_CHARS) as Record<string, unknown>), [key]: kept },
        omitted
      }
    }
  }
  return { projected: projectText(shaped, KEEP_CHARS) }
}
export const FULL_TEXT_PAGE_CHARS = 40000
export interface ShortenedTextPage { sha256: string; text: string; totalChars: number; from: number; nextFrom?: number }
function eachString(value: unknown, visit: (text: string) => boolean): boolean {
  if (typeof value === 'string') return visit(value)
  if (value && typeof value === 'object' && visit(JSON.stringify(value))) return true
  if (Array.isArray(value)) { for (const item of value) if (eachString(item, visit)) return true; return false }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) if (eachString(item, visit)) return true; return false }
  return false
}
export function readShortenedText(stateDir: string, sha256: string, from = 0): ShortenedTextPage {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error('Ask for a text by its sha256, exactly as the snapshot printed it.')
  const start = Number.isSafeInteger(from) && from >= 0 ? from : 0
  let found: string | null = null
  for (const name of ['brain/MAP.md', 'brain/DECISIONS.md', 'brain/GLOSSARY.md']) {
    const file = resolveInside(stateDir, name)
    if (!file || !existsSync(file)) continue
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > PROJECTED_FILE_LIMIT) continue
    let text: string
    try { text = readFileSync(file, 'utf8').replace(/^﻿/, '') } catch { continue }
    if (createHash('sha256').update(text).digest('hex') === sha256) { found = text; break }
  }
  for (const name of [...PROJECTED_RECORDS, 'work-needs.json']) {
    if (found !== null) break
    const file = resolveInside(stateDir, name)
    if (!file || !existsSync(file)) continue
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > PROJECTED_FILE_LIMIT) continue
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { continue }
    eachString(parsed, text => {
      if (createHash('sha256').update(text).digest('hex') !== sha256) return false
      found = text; return true
    })
    const candidates = [projectRecord(name, parsed).omitted, ...LEVELS.map((_, level) => projectRecord(name, shapeForTurn(name, parsed), level).omitted)]
    for (const omitted of candidates) {
      if (found !== null || omitted?.sha256 !== sha256) continue
      const isDone = name === 'tasks.json' ? taskIsFinished : doneTest(name)
      const listed = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>).find(Array.isArray)
      const entries = Array.isArray(listed) && isDone ? listed.filter(entry => isDone(entry as Loose)) : listed
      if (Array.isArray(entries)) found = JSON.stringify(entries.slice(0, omitted.omittedEntries))
    }
    if (found === null) {
      const split = splitFinished(name, parsed)
      if (split && split.finished.length && sha256Of(split.finished) === sha256) found = JSON.stringify(split.finished)
    }
    if (found !== null) break
  }
  if (found === null) {
    const file = resolveInside(stateDir, ARCHIVE_FILE)
    if (file && existsSync(file) && lstatSync(file).isFile() && lstatSync(file).size <= PROJECTED_FILE_LIMIT) {
      try {
        const archive = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { entries?: unknown }
        const entries = (isList(archive.entries) ? archive.entries : []) as unknown as { position: number; plan: { id: string } }[]
        let mainPlans: { id: string }[] = []
        const mainFile = resolveInside(stateDir, 'work-needs.json')
        if (mainFile && existsSync(mainFile)) { const main = JSON.parse(readFileSync(mainFile, 'utf8').replace(/^\uFEFF/, '')) as { plans?: unknown }; if (isList(main.plans)) mainPlans = main.plans as unknown as { id: string }[] }
        const shelved = shelvedPlans(mainPlans, entries)
        if (shelved.length && sha256Of(shelved) === sha256) found = JSON.stringify(shelved)
        else eachString(entries.map(e => e?.plan), text => {
          if (createHash('sha256').update(text).digest('hex') !== sha256) return false
          found = text; return true
        })
      } catch {}
    }
  }
  if (found === null) throw Error('There is no text with that sha256 in this project\'s saved records. Use the hash exactly as the snapshot printed it beside the omission.')
  const whole: string = found
  const text = whole.slice(start, start + FULL_TEXT_PAGE_CHARS)
  const next = start + text.length
  return { sha256, text, totalChars: whole.length, from: start, ...(next < whole.length ? { nextFrom: next } : {}) }
}
export interface ProtectedBasisSnapshot { stored: Record<string, any>; conversation: { ownerMessagesSha256: string; ownerMessageHashes: string[] } }
export const CONTEXT_FILES = ['brain/MAP.md', 'brain/DECISIONS.md', 'brain/GLOSSARY.md', 'work-needs.json', 'work-needs-archive.json', 'work-order.json', 'critiques.json', 'tasks.json', 'agents.json', 'your-turn.json', 'user-profile.json', 'standards.json', 'delivery.json', 'chat.jsonl', 'chat.json'] as const
const contextCache = new Map<string, { key: string; context: string; basis: ProtectedBasisSnapshot }>()
function recordsKey(stateDir: string): string {
  return CONTEXT_FILES.map(name => {
    const parts = name.split('/')
    let at = stateDir
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]!)
      let s: Stats
      try { s = lstatSync(at) } catch { return 'none' }
      if (s.isSymbolicLink()) return 'unsafe'
      if (i === parts.length - 1) return `${s.size}:${s.mtimeMs}`
    }
    return 'none'
  }).join('|')
}
export function protectedProjectContext(stateDir: string, basis?: (value: ProtectedBasisSnapshot) => void): string {
  const key = recordsKey(stateDir)
  const hit = contextCache.get(stateDir)
  if (hit && hit.key === key) { basis?.(hit.basis); return hit.context }
  let captured: ProtectedBasisSnapshot | undefined
  const context = buildProjectContext(stateDir, value => { captured = value })
  if (captured) { contextCache.set(stateDir, { key, context, basis: captured }); basis?.(captured) }
  return context
}
function buildProjectContext(stateDir: string, basis?: (value: ProtectedBasisSnapshot) => void): string {
  const read = (name: string, limit = 384 * 1024): string | null => {
    const file = resolveInside(stateDir, name)
    if (!file) throw Error('Project context uses an unsafe path.')
    if (!existsSync(file)) return null
    const tooBig = (bytes: number): Error => Error(
      `This project's ${name} is too large to hand to a turn safely: ${Math.round(bytes / 1024)} KB against a ${Math.round(limit / 1024)} KB limit. Nothing was discarded and it is still on disk. Shorten or archive that record before this turn can start.`
    )
    if (!lstatSync(file).isFile()) throw Error(`This project's ${name} is not a file Damon can read. Nothing was discarded; it is still on disk.`)
    if (lstatSync(file).size > limit) throw tooBig(lstatSync(file).size)
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (Buffer.byteLength(raw) > limit) throw tooBig(Buffer.byteLength(raw))
    return raw
  }
  const stored: Record<string, unknown> = {}
  const canonicalStored: Record<string, unknown> = {}
  const omittedEntries: Record<string, OmittedEntries> = {}
  for (const name of ['brain/MAP.md', 'brain/DECISIONS.md', 'brain/GLOSSARY.md']) {
    const raw = read(name, BRAIN_FILE_LIMIT)
    if (raw === null) continue
    stored[name] = raw.length <= KEEP_CHARS_BRAIN
      ? raw
      : { tail: raw.slice(raw.length - KEEP_CHARS_BRAIN), omittedChars: raw.length - KEEP_CHARS_BRAIN, sha256: createHash('sha256').update(raw).digest('hex'), note: BRAIN_NOTE }
    canonicalStored[name] = raw
  }
  for (const name of ['work-needs.json', 'work-order.json', 'critiques.json', 'tasks.json', 'agents.json', 'your-turn.json', 'user-profile.json', 'standards.json']) {
    const projected = (PROJECTED_RECORDS as readonly string[]).includes(name)
    const shaped = name === 'work-needs.json' || name === 'work-order.json'
    const raw = read(name, projected || shaped ? PROJECTED_FILE_LIMIT : undefined)
    if (raw === null) continue
    const parsed = JSON.parse(raw)
    canonicalStored[name] = parsed
    if (!projected) { stored[name] = shapeForTurn(name, parsed); continue }
    const done = projectRecord(name, shapeForTurn(name, parsed))
    stored[name] = done.projected
    if (done.omitted) omittedEntries[name] = done.omitted
  }
  const delivery = read('delivery.json', 8 * 1024 * 1024)
  if (delivery !== null) {
    const data = JSON.parse(delivery)
    if (data.version !== 1 || data.projectId !== basename(stateDir) || !Array.isArray(data.records) || data.records.length > 1000) throw Error('Delivery context needs recovery before model access.')
    const latest = data.records.at(-1)
    stored['delivery'] = latest ? { scope: deliveryScope.parse(latest.scope), declaredStage: deliveryStage.parse(latest.stage), revision: latest.revision, historyRecords: data.records.length, note: 'Current owner-declared arrangements only. Earlier history remains on disk. A stage is not execution permission, authenticated client approval or a deployment receipt.' } : null
  }
  const log = read('chat.jsonl', 32 * 1024 * 1024), legacy = log === null ? read('chat.json', 32 * 1024 * 1024) : null
  const rows: unknown = log !== null ? log.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : legacy !== null ? JSON.parse(legacy) : []
  if (!Array.isArray(rows)) throw Error('Project conversation records need recovery.')
  const messages = rows.filter(row => {
    if (!row || typeof row !== 'object') throw Error('Project conversation records need recovery.')
    if (typeof row.patch === 'string') return false
    if (typeof row.id !== 'string' || typeof row.role !== 'string' || typeof row.text !== 'string' || typeof row.at !== 'string') throw Error('Project conversation records need recovery.')
    return row.role === 'user' || row.role === 'manager' || row.role === 'assistant'
  }).map(({ id, role, text, at }) => ({ id, role, text, at }))
  const recent = keepWhatFits(messages.slice(-100), message => message).kept as typeof messages
  const ownerMessages = messages.filter(message => message.role === 'user')
  const ownerMessagesSha256 = createHash('sha256').update(JSON.stringify(ownerMessages)).digest('hex')
  const ownerMessageHashes = ownerMessages.map(message => createHash('sha256').update(JSON.stringify(message)).digest('hex'))
  canonicalStored.delivery = stored.delivery ?? null
  let basisStored = canonicalStored
  let archivedHandle: { plans: number; sha256: string; ids: string[]; moreIds?: number; note: string } | undefined
  const archiveRaw = read(ARCHIVE_FILE, PROJECTED_FILE_LIMIT)
  if (archiveRaw !== null) {
    const archive = JSON.parse(archiveRaw) as { version?: unknown; entries?: unknown }
    if (archive.version !== 1 || !isList(archive.entries)) throw Error(`This project's ${ARCHIVE_FILE} is not in a form Damon can read. Nothing was discarded; it is still on disk.`)
    const entries = archive.entries as unknown as { position: number; plan: { id: string } }[]
    const main = (canonicalStored['work-needs.json'] ?? { version: 1, plans: [] }) as Loose
    const mainPlans = (isList(main.plans) ? main.plans : []) as unknown as { id: string }[]
    const shelved = shelvedPlans(mainPlans, entries)
    if (shelved.length) {
      basisStored = { ...canonicalStored, 'work-needs.json': { ...main, plans: mergeArchived(mainPlans, entries) } }
      const ids = shelved.map(p => p.id)
      archivedHandle = { plans: shelved.length, sha256: sha256Of(shelved), ids: ids.slice(-FINISHED_IDS_SHOWN), ...(ids.length > FINISHED_IDS_SHOWN ? { moreIds: ids.length - FINISHED_IDS_SHOWN } : {}), note: ARCHIVED_NOTE }
    }
  }
  basis?.({ stored: basisStored, conversation: { ownerMessagesSha256, ownerMessageHashes } })
  const FINAL = LEVELS.length
  const finishedHandle = (finished: Loose[]): OmittedEntries => {
    const ids = finished.map(entry => entry?.id)
    return { omittedEntries: finished.length, sha256: sha256Of(finished), note: FINISHED_NOTE, ids: ids.slice(-FINISHED_IDS_SHOWN), ...(ids.length > FINISHED_IDS_SHOWN ? { moreIds: ids.length - FINISHED_IDS_SHOWN } : {}) }
  }
  const assemble = (level: number): { context: string; view: Record<string, unknown>; window: unknown[] } => {
    const L = LEVELS[Math.min(level, LEVELS.length - 1)]!
    const openOnly = level >= FINAL
    const view: Record<string, unknown> = { ...stored }
    const omitted: Record<string, OmittedEntries> = { ...omittedEntries }
    if (level > 0) for (const name of PROJECTED_RECORDS) {
      if (canonicalStored[name] === undefined) continue
      const split = openOnly ? splitFinished(name, canonicalStored[name]) : null
      if (split) {
        view[name] = name === 'tasks.json' ? projectRecord(name, split.rest, level).projected : projectText(shapeForTurn(name, split.rest), L.keep)
        if (split.finished.length) omitted[name] = finishedHandle(split.finished); else delete omitted[name]
        continue
      }
      const done = projectRecord(name, shapeForTurn(name, canonicalStored[name]), level)
      view[name] = done.projected
      if (done.omitted) omitted[name] = done.omitted; else delete omitted[name]
    }
    const shrinkNeeds = level >= 2 && canonicalStored['work-needs.json'] !== undefined
    if (shrinkNeeds) {
      const split = openOnly ? splitFinished('work-needs.json', canonicalStored['work-needs.json']) : null
      view['work-needs.json'] = projectText(shapeForTurn('work-needs.json', split ? split.rest : canonicalStored['work-needs.json'], true), L.keep)
      if (split?.finished.length) omitted['work-needs.json'] = finishedHandle(split.finished)
    }
    const window = level === 0 ? recent :(keepWhatFits(messages.slice(-L.messages), message => message).kept as typeof messages)
    const cut = openOnly
      ? 'The project was too large even at the deepest cut, so every finished plan, job, critique and card was left out and only open work travels here; projection.omitted names what was left out. read_in_full reaches everything omitted.'
      : 'The project was too large at the ordinary cut, so the newest jobs and the conversation travel shorter here. read_in_full reaches everything omitted.'
    const context = JSON.stringify({ stored: view, projection: { note: PROJECTION_NOTE, shortened: [...PROJECTED_RECORDS, ...(shrinkNeeds ? ['work-needs.json'] : [])].filter(name => view[name] !== undefined), ...(Object.keys(omitted).length ? { omitted } : {}), ...(archivedHandle ? { archived: { 'work-needs.json': archivedHandle } } : {}), ...(level > 0 ? { level, cut } : {}) }, conversation: { totalMessages: messages.length, omittedEarlierMessages: messages.length - window.length, ownerMessagesSha256, recent: window, note: 'Earlier messages remain on disk. This snapshot is partial when omittedEarlierMessages is nonzero; do not claim to have reviewed omitted history. The owner-message hash detects changed history; it does not expose or establish incorporation of omitted messages.' } })
    return { context, view, window }
  }
  let built = assemble(0)
  for (let level = 1; Buffer.byteLength(built.context) > PROTECTED_CONTEXT_TARGET_BYTES && level < LEVELS.length; level++) built = assemble(level)
  if (Buffer.byteLength(built.context) > PROTECTED_CONTEXT_LIMIT_BYTES) built = assemble(FINAL)
  if (Buffer.byteLength(built.context) > PROTECTED_CONTEXT_LIMIT_BYTES) {
    const sizes = [...Object.entries(built.view).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value))] as const), ['the recent conversation', Buffer.byteLength(JSON.stringify(built.window))] as const]
    const [biggest, bytes] = sizes.sort((a, b) => b[1] - a[1])[0] ?? ['the project records', 0]
    const others = sizes.slice(1, 4).map(([name, size]) => `${name} ${Math.round(size / 1024)} KB`).join(', ')
    const items: { record: string; id: unknown; title: string; bytes: number }[] = []
    const listOf = (value: unknown): unknown => isList(value) ? value : value && typeof value === 'object' ? Object.values(value).find(isList) : undefined
    for (const name of ['work-needs.json', 'tasks.json', 'critiques.json', 'your-turn.json']) {
      const list = name === 'work-needs.json' ? (built.view[name] as { plans?: unknown } | undefined)?.plans : listOf(built.view[name])
      if (!isList(list)) continue
      for (const entry of list) {
        if (!entry || typeof entry !== 'object' || entry.id === undefined) continue
        const title = typeof entry.title === 'string' ? entry.title : typeof (entry.title as { head?: unknown } | undefined)?.head === 'string' ? (entry.title as { head: string }).head : ''
        items.push({ record: name, id: entry.id, title: title.slice(0, 60), bytes: Buffer.byteLength(JSON.stringify(entry)) })
      }
    }
    const heaviest = items.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map(item => `${item.record} ${String(item.id)}${item.title ? ` "${item.title}"` : ''} (${Math.round(item.bytes / 1024)} KB)`).join('; ')
    throw Error(`This project's saved records are too large to hand to a turn safely even with every finished entry left out: the open work alone comes to ${Math.round(Buffer.byteLength(built.context) / 1024)} KB against a ${Math.round(PROTECTED_CONTEXT_LIMIT_BYTES / 1024)} KB limit, and the largest is ${biggest} at ${Math.round(bytes / 1024)} KB${others ? ` (then ${others})` : ''}.${heaviest ? ` The heaviest of the ${items.length} open items: ${heaviest}.` : ''} Nothing was discarded. Finish, drop or shorten open work (or the largest record) before this turn can start.`)
  }
  return requireReviewedText(built.context)
}

export const SCAN_SLICE = 64_000
export const SCAN_OVERLAP = 512
export async function requireReviewedTextInSlices(text: string): Promise<void> {
  for (let i = 0; i < text.length; i += SCAN_SLICE) {
    requireReviewedText(text.slice(Math.max(0, i - SCAN_OVERLAP), i + SCAN_SLICE))
    if (i + SCAN_SLICE < text.length) await new Promise<void>(resolve => setImmediate(resolve))
  }
}
