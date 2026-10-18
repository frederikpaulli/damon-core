// The final check (critique) on work that will leave the project: obligations, their
// reports, and which findings hold a card back.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { isOwnerConfirmation } from '../../shared/critic-reach'
import { CRITIQUE_RUN_CAP, DECISION_NOT_ASKED, DECISION_UNKNOWN } from '../../shared/your-turn'
export { CRITIQUE_RUN_CAP }
import { arguesAKeptDecision, adviceOnACard } from '../../shared/product-critic'
import { namesADecision } from '../../shared/product-critic'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readJson, writeJson } from './json-file'
import { parseCriticReport, type CriticReport } from '../../shared/product-critic'
import type { ScenarioResult } from '../../shared/intended-work'
import { fileRole, type FileRole } from '../../shared/file-role'
import { blockedCheckHolds, filedOnlyInUnsentFiles, formAnswers, isBookkeepingCheck, isFormSheet, notesHeadings, onlyEditExtent, onlyStyle, placeInAnswers, placeInAnswersText, placeNamesNotesHeading, quotesSentOutsideSection, reportsFault, sectionUnder, withBeside, isPackageScenario, namesASentFile, namesSentFile, outsideFiles, packageFindingHolds, quotesASentFile, scenarioHolds, sentBeside, wordsHold } from '../../shared/outgoing'

export { outsideFiles }
const OWNER_SHEET = /^(?:.*[-_.])?(?:submission|how-to|readme|notes|checklist|tracker|prep|brief|review|request|intel|research)(?:[-_.].*)?\.(?:md|html?|txt)$/i
export function isOwnerSheet(file: string): boolean { return OWNER_SHEET.test(file.replace(/\\/g, '/').split('/').pop() ?? file) }
export function sentFiles(files: string[]): string[] {
  const sent = files.filter(f => !OWNER_SHEET.test(f.split('/').pop() ?? f))
  return sent.length ? sent : files
}
export const DAMON_RECORD = /\b(?:attention cards?|your turn|owner'?s list|tracker entr(?:y|ies))\b/i
export interface OutwardCard { files: string[]; sent: string[] }
export function findingKey(f: { where: string; what: string }): string {
  return 'finding-' + createHash('sha256').update(f.where + '\n' + f.what).digest('hex').slice(0, 16)
}

let onWhatLeaves = true
export function judgePackagesOnWhatLeaves(on: boolean): void { onWhatLeaves = on }
export const STYLE_NOTE = 'Your team\u2019s final check on the wording, yours to decide (it does not hold this card): '
export function isPackageScope(scope: string): boolean { return (scope ?? '').startsWith('owner-action:') }
export { namesSentFile }
const firstFile = (text: string): string | undefined => (text ?? '').match(/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5}\b/)?.[0]
const DAMONS_OWN: ReadonlySet<FileRole> = new Set<FileRole>(['record', 'view', 'evidence'])

export interface FindingOrigin { failed: string[]; evidence: string[] }
const originIn = (r: { checks: ScenarioResult[] }): FindingOrigin => {
  const failed = r.checks.filter(c => c.status !== 'pass' && !c.id.startsWith('finding-'))
  return { failed: failed.map(c => c.id), evidence: failed.flatMap(c => c.evidence ?? []).slice(0, 20) }
}
const journalOriginCache = new Map<string, { stamp: string; scopes: Map<string, Map<string, FindingOrigin>> }>()
export interface DecisionHold { at: string; line: string; words: string[]; files: string[] }
export interface CritiqueObligation {
  id: string
  scope: string
  basis: string
  taskIds: string[]
  files: string[]
  context?: unknown
  tasks?: import('../../shared/types').TaskInfo[]
  carriedFindings?: CriticReport['findings']
  parkedForOwner?: CriticReport['findings']
  carriedChallenges?: string[]
  carriedOrigins?: Record<string, FindingOrigin>
  releasedChallenges?: string[]
  observations?: { file: string; hash: string }[]
  expiresAt?: string
  recheckDue?: string
  decisionHold?: DecisionHold
  ownerDecisions?: { challenge: string; decision: 'keep' | 'send-back'; at: string; by?: 'owner' | 'damon' }[]
  repairs?: { findingId: string; taskId: string; owner: string; at: string }[]
  createdAt: string
  reports: { at: string; taskId: string; raw: string; parsed: CriticReport; checks: ScenarioResult[]; problems: string[]; decisions?: string; decisionLines?: string; model?: string }[]
  retired?: { at: string; reason: string }
}

export const CRITIQUE_WINDOW_MS = 48 * 60 * 60_000
const legacyIds = new Map<string, { stamp: string; ids: Set<string> }>()

export class CritiqueStore {
  private file: string
  private archiveFile: string
  private journal: string
  private stateDir: string
  constructor(
    stateDir: string,
    private readonly journalLimit = 8 * 1024 * 1024,
    private readonly roleOf: (path: string) => FileRole = (p) => fileRole(p),
    private readonly readText?: (path: string) => string | undefined
  ) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'critiques.json'); this.archiveFile = join(stateDir, 'critiques-archive.json'); this.journal = join(stateDir, 'critiques-archive.jsonl')
  }
  private damonsOwn(f: { where: string; what: string }, sent: string[]): boolean {
    const file = firstFile(f.where)
    return !!file && DAMONS_OWN.has(this.roleOf(file)) && !namesSentFile(f.what, sent)
  }
  private inSheet(item: CritiqueObligation, f: { where: string }): boolean {
    const file = firstFile(f.where)
    return !!file && !outsideFiles(f.where, item.files) && this.roleOf(file) === 'owner-sheet'
  }
  private owedInPackage(item: CritiqueObligation, f: { where: string; what: string }): boolean {
    if (this.packageLane(item)) return !!item.reports.at(-1)?.parsed.findings.some(x => findingKey(x) === findingKey(f)) && !this.packageNote(item, f)
    const sent = sentFiles(item.files)
    return (!outsideFiles(f.where, item.files) && !this.damonsOwn(f, sent)) || namesSentFile(f.what, sent)
  }
  private packageLane(item: CritiqueObligation): boolean { return onWhatLeaves && isPackageScope(item.scope) }
  private packageSent(item: CritiqueObligation): string[] {
    const neverSent = /^(?:.*[-_.])?(?:review|request|intel|notes|tracker|decisions|submission|checklist|readme|how-?to|prep|brief)(?:[-_.].*)?\.(?:md|html?|txt)$/i
    const base = [...new Set([...sentFiles(item.files), ...item.files.filter(f => this.roleOf(f) === 'outward' && !neverSent.test(f.replace(/\\/g, '/').split('/').pop() ?? f))])]
    return [...base, ...sentBeside(base, this.packageTexts(item))]
  }
  private packageTexts(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last) return []
    return [...last.parsed.findings.flatMap(f => [f.where, f.what]), ...last.checks.flatMap(c => [c.observed ?? '', ...(c.evidence ?? [])]), ...last.problems]
  }
  packageFilesFor(scope: string, onCard: string[], exists: (path: string) => boolean): string[] {
    const previous = this.list().find(x => x.scope === scope && !x.retired)
    if (!previous) return withBeside(onCard, [], [], exists)
    const passed = previous.reports.length > 0 && this.blocker(previous, true) === null
    return withBeside(onCard, previous.files, passed ? [] : this.besideFiles(previous), exists)
  }
  private packageHoldSent(item: CritiqueObligation): string[] {
    return this.packageView(item).sent
  }
  private packageView(item: CritiqueObligation, card?: OutwardCard): { sent: string[]; texts: string[] | undefined; answerSheets: { path: string; headings: string[] }[] } {
    const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
    const own = this.packageSent(item)
    const base = [...own, ...(card?.sent ?? []).filter(f => !own.some(o => norm(o) === norm(f)))]
    const sent = [...base]
    const texts: string[] | undefined = this.readText ? [...(this.sentTexts(base) ?? [])] : undefined
    const answerSheets: { path: string; headings: string[] }[] = []
    const sheets = [...new Map([...item.files, ...(card?.files ?? [])].filter(isFormSheet).map(f => [norm(f), f])).values()]
    for (const sheet of sheets) {
      let text: string | undefined
      try { text = this.readText?.(sheet) } catch { text = undefined }
      const fa = text ? formAnswers(text) : undefined
      if (fa) { answerSheets.push({ path: sheet, headings: fa.headings }); texts?.push(fa.answers) }
      else { if (!sent.includes(sheet)) sent.push(sheet); if (text) texts?.push(text) }
    }
    return { sent, texts, answerSheets }
  }
  besideFiles(item: CritiqueObligation): string[] {
    const base = this.packageSent(item).filter(f => item.files.includes(f))
    return sentBeside(base, this.packageTexts(item))
  }
  private sentTexts(sent: string[]): string[] | undefined {
    if (!this.readText) return undefined
    return sent.map(f => { try { return this.readText!(f) } catch { return undefined } }).filter((t): t is string => typeof t === 'string')
  }
  private releasedChecks(item: CritiqueObligation): Set<string> {
    const verdict = new Map<string, { pass: boolean; at: number }>()
    item.reports.forEach((r, i) => {
      for (const c of r.checks) verdict.set(c.id, { pass: c.status === 'pass' && c.evidence.length > 0, at: i })
      for (const f of r.parsed.findings) { const k = findingKey(f), v = verdict.get(k); if (v?.pass && v.at < i) verdict.set(k, { pass: false, at: i }) }
    })
    return new Set([...verdict].filter(([, v]) => v.pass).map(([id]) => id))
  }
  private originOf(item: CritiqueObligation, key: string): FindingOrigin | undefined {
    const raised = [...item.reports].reverse().find(r => r.parsed.findings.some(x => findingKey(x) === key))
    if (raised) return originIn(raised)
    return item.carriedOrigins?.[key] ?? this.journalOrigins(item.scope).get(key)
  }
  private journalOrigins(scope: string): Map<string, FindingOrigin> {
    let stamp = ''
    try { const st = statSync(this.journal); stamp = `${st.size}:${st.mtimeMs}` } catch { return new Map() }
    const known = journalOriginCache.get(this.journal)
    const entry = known?.stamp === stamp ? known : { stamp, scopes: new Map<string, Map<string, FindingOrigin>>() }
    journalOriginCache.set(this.journal, entry)
    let byKey = entry.scopes.get(scope)
    if (!byKey) {
      byKey = new Map()
      for (const x of CritiqueStore.lines(this.journal, scope).filter(o => o.scope === scope)) {
        for (const [k, o] of Object.entries(x.carriedOrigins ?? {})) if (!byKey.has(k)) byKey.set(k, o)
        for (const r of x.reports) for (const f of r.parsed.findings) { const k = findingKey(f); if (!byKey.has(k)) byKey.set(k, originIn(r)) }
      }
      entry.scopes.set(scope, byKey)
    }
    return byKey
  }
  private packageNote(item: CritiqueObligation, f: { where: string; what: string }, view = this.packageView(item)): boolean {
    const { sent, texts } = view
    const key = findingKey(f)
    if (this.releasedChecks(item).has(key)) return true
    if (view.answerSheets.some(s => !outsideFiles(f.where, [s.path]) && /[\w-]+\.(?:md|html?|txt)\b/i.test(f.where) && placeInAnswers(f.where, s.headings))) return false
    if (this.sheetFindingHolds(f, view.answerSheets, sent)) return false
    if (!isPackageScope(item.scope) && onlyEditExtent(f.what) && !quotesASentFile(f.where + '\n' + f.what, texts)) return true
    const origin = this.originOf(item, key)
    const failed = origin?.failed ?? []
    const bookkeeping = failed.length > 0 && failed.every(isBookkeepingCheck)
    const damonsPlace = !/[\w-]+\.[A-Za-z0-9]{1,5}\b/.test((f.where ?? '').replace(/https?:\/\/\S+/gi, ' ')) && (DAMON_RECORD.test(f.where ?? '') || /\bschedules?\b/i.test(f.where ?? ''))
    const unsentFiles = (filedOnlyInUnsentFiles(f.where, sent) || (damonsPlace && !wordsHold(f.what, sent))) && !failed.some(isPackageScenario)
    if (!bookkeeping && !unsentFiles) return false
    const evidence = [
      ...(bookkeeping ? origin?.evidence ?? [] : []),
      ...item.reports.flatMap(r => r.checks.filter(c => c.id === key).flatMap(c => c.evidence ?? []))
    ]
    return !packageFindingHolds(f, sent, { evidence, sentTexts: texts })
  }
  private packageCheckNote(c: ScenarioResult, sent: string[], texts: string[] | undefined, editLane = false, sheets: string[] = []): boolean {
    if (c.status === 'blocked') return !blockedCheckHolds(c, [...sent, ...sheets], texts, { editLane })
    if (isPackageScenario(c.id)) return false
    if (editLane && onlyEditExtent(c.observed ?? '') && !quotesASentFile(c.observed ?? '', texts)) return true
    if (!isBookkeepingCheck(c.id)) return false
    if ((c.evidence ?? []).some(e => !/^https?:/i.test(e) && namesASentFile(e, sent))) return false
    return !quotesASentFile(c.observed ?? '', texts)
  }
  private static lines(path: string, id?: string): CritiqueObligation[] {
    if (!existsSync(path)) return []
    const out: CritiqueObligation[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim() || (id && !line.includes(id))) continue
      try {
        const x = JSON.parse(line) as CritiqueObligation
        if (x && typeof x.id === 'string' && Array.isArray(x.reports) && Array.isArray(x.files) && Array.isArray(x.taskIds)) out.push(x)
      } catch {}
    }
    return out
  }
  private coldFiles(): string[] {
    try { return readdirSync(this.stateDir).filter(f => /^critiques-archive-cold-.*\.jsonl$/.test(f)).sort().reverse().map(f => join(this.stateDir, f)) } catch { return [] }
  }
  private append(items: CritiqueObligation[]): void {
    if (!items.length) return
    appendFileSync(this.journal, items.map(x => JSON.stringify(x)).join('\n') + '\n')
    try {
      if (statSync(this.journal).size > this.journalLimit) renameSync(this.journal, join(this.stateDir, `critiques-archive-cold-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`))
    } catch {}
  }
  private findArchived(id: string): CritiqueObligation | undefined {
    for (const path of [this.journal, ...this.coldFiles()]) {
      const hit = CritiqueStore.lines(path, id).reverse().find(x => x.id === id)
      if (hit) return hit
    }
    if (!existsSync(this.archiveFile)) return undefined
    try {
      const st = statSync(this.archiveFile), stamp = `${st.size}:${st.mtimeMs}`, known = legacyIds.get(this.archiveFile)
      if (known?.stamp === stamp && !known.ids.has(id)) return undefined
      const all = CritiqueStore.shape(readJson<unknown>(this.archiveFile, []))
      legacyIds.set(this.archiveFile, { stamp, ids: new Set(all.map(x => x.id)) })
      return all.find(x => x.id === id)
    } catch { return undefined }
  }
  private static shape(data: unknown): CritiqueObligation[] {
    if (!Array.isArray(data) || data.some(x => !x || typeof x.id !== 'string' || !Array.isArray(x.reports) || !Array.isArray(x.files) || !Array.isArray(x.taskIds))) throw new Error('Critique history is unreadable; readiness cannot be established.')
    return data
  }
  list(): CritiqueObligation[] {
    if (!existsSync(this.file)) return []
    return CritiqueStore.shape(JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')))
  }
  archived(): CritiqueObligation[] {
    let old: CritiqueObligation[] = []
    if (existsSync(this.archiveFile)) { try { old = CritiqueStore.shape(readJson<unknown>(this.archiveFile, [])) } catch { old = [] } }
    const byId = new Map<string, CritiqueObligation>()
    for (const x of [...old, ...[...this.coldFiles()].reverse().flatMap(p => CritiqueStore.lines(p)), ...CritiqueStore.lines(this.journal)]) byId.set(x.id, x)
    return [...byId.values()]
  }
  get(id: string): CritiqueObligation | undefined {
    return this.list().find(x => x.id === id) ?? this.findArchived(id)
  }
  private save(all: CritiqueObligation[]): void {
    const retired = all.filter(x => x.retired), live = all.filter(x => !x.retired)
    this.append(retired)
    writeJson(this.file, live)
  }
  ensure(scope: string, basis: unknown, taskIds: string[], files: string[], tasks?: import('../../shared/types').TaskInfo[]): CritiqueObligation {
    const key = createHash('sha256').update(JSON.stringify(basis)).digest('hex')
    const all = this.list()
    const existing = all.find(x => x.scope === scope && x.basis === key && !x.retired)
    if (existing && (!existing.expiresAt || Date.parse(existing.expiresAt) > Date.now())) return existing
    if (existing && this.passedPackage(existing)) {
      existing.expiresAt = new Date(Date.now() + CRITIQUE_WINDOW_MS).toISOString()
      existing.recheckDue ??= new Date().toISOString()
      this.save(all)
      return existing
    }
    if (existing && !existing.reports.length) { existing.expiresAt = new Date(Date.now() + CRITIQUE_WINDOW_MS).toISOString(); this.save(all); return existing }
    const previous = all.filter(x => x.scope === scope && !x.retired)
    const carriedFindings = previous.flatMap(x => [...(x.carriedFindings ?? []), ...x.reports.flatMap(r => r.parsed.findings)])
    const carriedChallenges = previous.flatMap(x => [...(x.carriedChallenges ?? []), ...x.reports.flatMap(r => r.parsed.forTheOwner)])
    for (const prior of previous) prior.retired = { at: new Date().toISOString(), reason: 'Replaced by a changed workflow basis; findings and owner challenges carried forward.' }
    const ownerDecisions = previous.flatMap(x => (x.ownerDecisions ?? []).filter(d => d.by !== 'damon'))
    void tasks
    const item: CritiqueObligation = { expiresAt: new Date(Date.now() + CRITIQUE_WINDOW_MS).toISOString(), context: basis, carriedFindings, carriedChallenges, ownerDecisions, id: randomUUID(), scope, basis: key, taskIds, files, createdAt: new Date().toISOString(), reports: [] }
    item.repairs = previous.flatMap(x => x.repairs ?? [])
    const origins: Record<string, FindingOrigin> = {}
    for (const x of previous) {
      for (const [k, o] of Object.entries(x.carriedOrigins ?? {})) origins[k] ??= o
      for (const r of x.reports) for (const f of r.parsed.findings) origins[findingKey(f)] ??= originIn(r)
    }
    if (Object.keys(origins).length) item.carriedOrigins = origins
    all.push(item); this.save(all); return item
  }
  retire(items: { id: string; reason: string }[]): number {
    if (!items.length) return 0
    const all = this.list()
    let n = 0
    for (const it of items) { const x = all.find(o => o.id === it.id && !o.retired); if (x) { x.retired = { at: new Date().toISOString(), reason: it.reason }; n++ } }
    if (n) this.save(all)
    return n
  }
  adoptBasis(scope: string, basis: unknown, unchanged: (old: unknown) => boolean): boolean {
    const all = this.list()
    const live = all.find(x => x.scope === scope && !x.retired)
    if (!live || !live.context || typeof live.context !== 'object') return false
    if (live.basis === createHash('sha256').update(JSON.stringify(basis)).digest('hex')) return false
    if (!unchanged(live.context)) return false
    live.context = basis
    live.basis = createHash('sha256').update(JSON.stringify(basis)).digest('hex')
    this.save(all)
    return true
  }
  record(id: string, taskId: string, raw: string, checks: ScenarioResult[], problems: string[], observations: { file: string; hash: string }[] = [], volatile = false, decisionsSha?: string, model?: string): CritiqueObligation {
    const live = this.list(), inLive = live.find(x => x.id === id)
    const item = inLive ?? this.findArchived(id)
    if (!item) throw new Error('This critique obligation is unavailable.')
    item.observations = [...new Map([...(item.observations ?? []), ...observations].map(f => [f.file, f])).values()]
    if (item.context && typeof item.context === 'object' && !Array.isArray(item.context) && 'observed' in item.context) {
      item.context = { ...item.context, observed: item.observations }
      item.basis = createHash('sha256').update(JSON.stringify(item.context)).digest('hex')
    }
    if (volatile) item.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    delete item.recheckDue
    delete item.decisionHold
    item.reports.push({ at: new Date().toISOString(), taskId, raw, parsed: parseCriticReport(raw), checks, problems, ...(decisionsSha ? { decisions: decisionsSha } : {}), ...(model ? { model } : {}) })
    if (inLive) this.save(live); else this.append([item])
    return item
  }
  decisionsMoved(item: CritiqueObligation, currentSha: string): boolean {
    const last = item.reports.at(-1)
    return !!last?.decisions && last.decisions !== currentSha
  }
  decisionLinesMoved(item: CritiqueObligation, linesSha: string, wholeSha: string): boolean {
    const last = item.reports.at(-1)
    if (!last?.decisions) return false
    const moved = last.decisionLines ? last.decisionLines !== linesSha : last.decisions !== wholeSha
    if (last.decisionLines !== linesSha) {
      const all = this.list(), live = all.find(x => x.id === item.id && !x.retired)?.reports.at(-1)
      if (live) { live.decisionLines = linesSha; this.save(all) }
    }
    return moved
  }
  holdOnDecisions(id: string, hold: DecisionHold): boolean {
    const all = this.list(), live = all.find(x => x.id === id && !x.retired)
    if (!live || !live.reports.length) return false
    live.decisionHold = hold
    this.save(all)
    return true
  }
  decisionHeld(item: CritiqueObligation): boolean { return !!item.decisionHold }
  linkedElsewhere(item: CritiqueObligation, elsewhere: (text: string, evidence: string[]) => string | null): { check: string; taskId: string }[] {
    const last = item.reports.at(-1); if (!last) return []
    return last.checks.filter(c => c.status !== 'pass').flatMap(c => { const check = `${c.id}: ${c.observed ?? ''}`; const taskId = elsewhere(check, c.evidence ?? []); return taskId ? [{ check, taskId }] : [] })
  }
  notesElsewhere(item: CritiqueObligation): { note: string; job: string }[] {
    const notes = (item.reports.at(-1) as { parsed?: { notes?: string[] } } | undefined)?.parsed?.notes ?? []
    return notes.flatMap(n => { const m = /belongs elsewhere:\s*job\s+([0-9a-f]{6,})/i.exec(n); return m ? [{ note: n, job: m[1]!.toLowerCase() }] : [] })
  }
  blocker(item: CritiqueObligation, forOwnerCard = false, elsewhere?: (text: string, evidence: string[]) => string | null, card?: OutwardCard): string | null {
    if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now() && !this.passedPackage(item)) return item.reports.length ? 'External observations have expired; inspect the live source again.' : null
    return this.blockerInWindow(item, forOwnerCard, elsewhere, card)
  }
  passedPackage(item: CritiqueObligation): boolean {
    const last = item.reports.at(-1)
    return !!last && !item.retired && this.packageLane(item) && this.packageBlocker(item, last) === null
  }
  private blockerInWindow(item: CritiqueObligation, forOwnerCard: boolean, elsewhere?: (text: string, evidence: string[]) => string | null, card?: OutwardCard): string | null {
    if (item.retired) return 'This critique covers an older workflow basis. Check the current obligation.'
    const last = item.reports.at(-1)
    if (!last) return `Workflow critique is outstanding (${item.id}).`
    if (item.decisionHold) {
      const held = `Workflow critique is outstanding (${item.id}): ${item.decisionHold.line}`
      const rest = this.blockerInWindow({ ...item, decisionHold: undefined }, forOwnerCard, elsewhere, card)
      return rest ? `${held}; ${rest}` : held
    }
    const p = last.parsed
    if (this.packageLane(item)) return this.packageBlocker(item, last, elsewhere)
    if (forOwnerCard && card && onWhatLeaves) return this.packageBlocker(item, last, elsewhere, card)
    const sent = sentFiles(item.files)
    const sentOnly = forOwnerCard
    const mgrPkg = !forOwnerCard && this.packageLane(item)
    const outsideText = (text: string): boolean => outsideFiles(text, sent)
    const namesSent = (raw: string): boolean => namesSentFile(raw, sent)
    const outsideFinding = (f: { where: string; what: string }): boolean => outsideFiles(f.where, sent) && !(sentOnly && namesSent(f.what))
    const outside = new Set(this.findings(item).filter(outsideFinding).map(f => findingKey(f)))
    const explained = sentOnly && p.findings.length > 0 && p.findings.every(outsideFinding)
    const citesOnlyUnsent = (checkId: string): boolean => {
      const finding = this.findings(item).find(f => findingKey(f) === checkId)
      const evidence = last.checks.find(c => c.id === checkId)?.evidence ?? []
      return !!finding && !/[\w-]+\.(?:md|html?|pdf|json|csv|txt|docx?)\b/i.test(finding.where) && evidence.length > 0 && evidence.every(e => !/^https?:/i.test(e) && outsideFiles(e, sent))
    }
    const blockedOnlyOutside = (checkId: string): boolean => {
      if (last.checks.find(c => c.id === checkId)?.status !== 'blocked') return false
      const unread = last.problems.filter(x => x.startsWith(checkId + ': evidence was not independently inspected: ')).map(x => x.slice((checkId + ': evidence was not independently inspected: ').length))
      return unread.length > 0 && unread.every(e => !/^https?:/i.test(e) && outsideFiles(e, sent))
    }
    const recordish = (e: string): boolean => DAMON_RECORD.test(e) || /^(?:(?:record|tracker)\s+)?[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(e.trim())
    const citesOnlyRecords = (checkId: string): boolean => {
      const evidence = last.checks.find(c => c.id === checkId)?.evidence ?? []
      return evidence.some(recordish) && evidence.every(e => !/^https?:/i.test(e) && (recordish(e) || outsideFiles(e, sent)))
    }
    const inARecord = (checkId: string): boolean => {
      const f = this.findings(item).find(x => findingKey(x) === checkId)
      return !!f && DAMON_RECORD.test(f.where) && !namesSent(`${f.where} ${f.what}`)
    }
    const evidencedOnlyOutside = (checkId: string): boolean => {
      const evidence = last.checks.find(c => c.id === checkId)?.evidence ?? []
      if (!evidence.length || !evidence.every(e => !/^https?:/i.test(e) && (recordish(e) || outsideFiles(e, sent)))) return false
      const finding = this.findings(item).find(f => findingKey(f) === checkId)
      return !finding || outsideFiles(finding.where, sent)
    }
    const excluded = (checkId: string): boolean => sentOnly && (outside.has(checkId) || citesOnlyRecords(checkId) || inARecord(checkId) || evidencedOnlyOutside(checkId) || (explained && !checkId.startsWith('finding-')) || (checkId.startsWith('finding-') && (citesOnlyUnsent(checkId) || blockedOnlyOutside(checkId))))
    const damonsOwnCheck = (checkId: string): boolean => {
      if (!mgrPkg) return false
      const finding = this.findings(item).find(f => findingKey(f) === checkId)
      if (finding) return this.damonsOwn(finding, sent)
      const evidence = last.checks.find(c => c.id === checkId)?.evidence ?? []
      return evidence.length > 0 && evidence.every(e => { const file = firstFile(e); return !/^https?:/i.test(e) && (recordish(e) || (!!file && file.length >= e.trim().length - 2 && DAMONS_OWN.has(this.roleOf(file)))) })
    }
    const checkOf = (problem: string): string => problem.slice(0, Math.max(0, problem.indexOf(': ')))
    if (!p.answered || !p.looked || p.droppedAsUnsupported || p.overCap || !last.checks.length || last.problems.some(x => !/^.+: fail:/.test(x) && !outsideText(x) && !excluded(checkOf(x)) && !damonsOwnCheck(checkOf(x)))) return `Workflow critique is incomplete (${item.id}). ${last.problems.join('; ')}`
    const failing = last.checks.filter(c => c.status !== 'pass' && !outside.has(c.id) && !excluded(c.id) && !outsideText(c.observed ?? '') && !damonsOwnCheck(c.id) && !(elsewhere && elsewhere(`${c.id}: ${c.observed ?? ''}`, c.evidence ?? [])))
    if (failing.length) return `The critic completed its checks and found unresolved failures (${item.id}): ${last.problems.filter(p => !/^finding-[0-9a-f]+: /.test(p) || failing.some(c => p.startsWith(c.id + ': '))).join('; ')}`
    const cardHolds = (f: { where: string; what: string }): boolean => !outsideFinding(f) && !excluded(findingKey(f))
    for (const finding of this.openFindings(item).filter(f => !sentOnly || cardHolds(f))) {
      if (!last.checks.some(c => c.id === findingKey(finding) && c.status === 'pass' && c.evidence.length)) return `Previous finding still needs an explicit recheck: ${finding.where}: ${finding.what}`
    }
    const challenges = this.challenges(item)
    if (challenges.length) return `Owner decision required: ${challenges.join('; ')}`
    const own = p.findings.filter(f => sentOnly ? cardHolds(f) : mgrPkg ? this.owedInPackage(item, f) : !outsideFiles(f.where, item.files))
    if (own.length) return `Workflow defects remain: ${own.map(f => `${f.impact}: ${f.where}: ${f.what}`).join('; ')}`
    return null
  }
  private packageBlocker(item: CritiqueObligation, last: CritiqueObligation['reports'][number], elsewhere?: (text: string, evidence: string[]) => string | null, card?: OutwardCard): string | null {
    const p = last.parsed
    const editLane = !isPackageScope(item.scope)
    const notLooked = !p.looked && !(editLane && !reportsFault(p.whyNotLooked ?? '', { editLane: true }))
    if (!p.answered || notLooked || p.droppedAsUnsupported || p.overCap || !last.checks.length) return `Workflow critique is incomplete (${item.id}). ${last.problems.join('; ')}`
    const told = ((item.context as { unreadable?: unknown } | undefined)?.unreadable as string[] | undefined ?? []).map(f => String(f).replace(/\\/g, '/').toLowerCase())
    const full = this.packageView(item, card)
    const view = { ...full, sent: full.sent.filter(f => !told.includes(f.replace(/\\/g, '/').toLowerCase())) }
    const { sent, texts } = view
    const leaves = card?.sent?.length ? card.sent : sent
    const note = (f: { where: string; what: string }): boolean => this.packageNote(item, f, view)
    const checkOf = (problem: string): string => problem.slice(0, Math.max(0, problem.indexOf(': ')))
    const checkById = (id: string): ScenarioResult | undefined => last.checks.find(c => c.id === id)
    const sheets = view.answerSheets.map(s => s.path)
    const released = (id: string): boolean => {
      if (isPackageScenario(id)) return false
      const c = checkById(id)
      if (id.startsWith('finding-')) {
        if (!c) return true
        if (editLane && c.status !== 'pass' && this.onlyDamonRecords(item, c) && this.recordCheckSaysNothingSent(item, c, texts, leaves)) return true
        if (c.status === 'blocked') return this.packageCheckNote(c, sent, texts, editLane, sheets)
        if (editLane && c.status === 'fail' && onlyEditExtent(c.observed ?? '') && !quotesASentFile(c.observed ?? '', texts)) return true
        if (c.status === 'fail' && this.styleOnlyCheck(item, c)) return true
        return !(c.evidence ?? []).some(e => !/^https?:/i.test(e) && namesASentFile(e, sent)) && !quotesASentFile(c.observed ?? '', texts) && !namesSentFile(c.observed ?? '', sent)
      }
      if (editLane && c && c.status !== 'pass' && this.onlyDamonRecords(item, c) && this.recordCheckSaysNothingSent(item, c, texts, leaves)) return true
      return !!c && this.packageCheckNote(c, sent, texts, editLane, sheets)
    }
    const toldCannotRead = new Set(((item.context as { unreadable?: unknown } | undefined)?.unreadable as string[] | undefined ?? []).map(f => String(f).replace(/\\/g, '/').toLowerCase()))
    const sentNamed = (text: string): string[] => [...(text ?? '').replace(/https?:\/\/\S+/gi, ' ').matchAll(/[\w.-]+(?:\/[\w.-]+)*\.(?:md|html?|pdf|json|csv|txt|docx?)\b/gi)].map(m => m[0].replace(/\\/g, '/').toLowerCase()).filter(n => !outsideFiles(n, sent) && ![...toldCannotRead].some(u => u === n || u.endsWith('/' + n)))
    const UNREAD = /(?:could ?n[o\u2019']t|cannot|can[\u2019']t|unable to|refused|not (?:read|opened|inspected|inspectable|readable)|outside (?:the|my) (?:inputs?|scope)|unread|never (?:read|opened))/i
    const unreadSent = (problem: string): boolean => {
      if (editLane) return false
      const unread = /: evidence was not independently inspected: (.+)$/.exec(problem)?.[1]
      if (unread !== undefined) return !/^https?:/i.test(unread) && sentNamed(unread).length > 0
      const check = checkById(checkOf(problem))
      if (!check || check.status === 'pass') return false
      return (check.observed ?? '').split(/(?<=[.;!?])\s+/).some(s => UNREAD.test(s) && sentNamed(s).length > 0)
    }
    const passedUnread = (problem: string): boolean => /: evidence was not independently inspected: /.test(problem) && checkById(checkOf(problem))?.status === 'pass'
    const unreadRecord = (problem: string): boolean => {
      const m = /^([^:]+): evidence was not independently inspected: (.+)$/.exec(problem)
      if (!m || !(isBookkeepingCheck(m[1]!) || m[1]!.startsWith('finding-'))) return false
      const what = m[2]!.replace(/https?:\/\/\S+/gi, ' ')
      return !/[\w-]+\.[A-Za-z0-9]{1,5}\b/.test(what) && (DAMON_RECORD.test(what) || /\bschedules?\b/i.test(what))
    }
    if (last.problems.some(x => unreadSent(x) || (!passedUnread(x) && !unreadRecord(x) && !/^.+: fail:/.test(x) && !released(checkOf(x))))) return `Workflow critique is incomplete (${item.id}). ${last.problems.join('; ')}`
    const failing = last.checks.filter(c => c.status !== 'pass' && (isPackageScenario(c.id) || (!released(c.id) && !(elsewhere && elsewhere(`${c.id}: ${c.observed ?? ''}`, c.evidence ?? [])))))
    if (failing.length) {
      const lines = last.problems.filter(x => failing.some(c => x.startsWith(c.id + ': ')))
      const unnamed = failing.filter(c => !lines.some(x => x.startsWith(c.id + ': '))).map(c => `${c.id}: ${c.status}: ${c.observed ?? ''}`)
      return `The critic completed its checks and found unresolved failures (${item.id}): ${[...lines, ...unnamed].join('; ')}`
    }
    const challenges = this.challenges(item)
    if (challenges.length) return `Owner decision required: ${challenges.join('; ')}`
    const recordFinding = (f: { where: string; what: string }): boolean => editLane && this.damonRecordRef(f.where ?? '') && !last.checks.some(c => isPackageScenario(c.id) && c.status !== 'pass') && !quotesASentFile(`${f.where}\n${f.what}`, texts) && !wordsHold(f.what, leaves)
    const own = p.findings.filter(f => !note(f) && !onlyStyle(f.what) && !this.sheetLine(item, f, view, card) && !recordFinding(f))
    if (own.length) return `Workflow defects remain: ${own.map(f => `${f.impact}: ${f.where}: ${f.what}`).join('; ')}`
    return null
  }
  private styleOnlyCheck(item: CritiqueObligation, c: ScenarioResult): boolean {
    if (!c.id.startsWith('finding-')) return false
    const finding = this.findings(item).find(f => findingKey(f) === c.id)
    return onlyStyle(c.observed ?? '', finding?.what ?? '')
  }
  private damonRecordRef(e: string): boolean {
    return !/https?:\/\//i.test(e) && !/[\w-]+\.[A-Za-z0-9]{1,5}\b/.test(e.replace(/\b(?:yours|critique):[0-9a-f-]+/gi, ' ')) && (DAMON_RECORD.test(e) || /\b(?:yours|critique):[0-9a-f]{8}/i.test(e) || /\bcard [0-9a-f]{8}\b/i.test(e))
  }
  private sheetFindingHolds(f: { where: string; what: string }, sheets: { path: string; headings: string[] }[], sent: string[]): boolean {
    const sheet = sheets.find(s => !outsideFiles(f.where, [s.path]) && /[\w-]+\.(?:md|html?|txt)\b/i.test(f.where))
    if (!sheet) return false
    let text: string | undefined
    try { text = this.readText?.(sheet.path) } catch { text = undefined }
    const fa = text ? formAnswers(text) : undefined
    if (!fa || placeInAnswersText(f.where, fa.answers)) return true
    return wordsHold(f.what, sent) || wordsHold(f.where, sent)
  }
  private recordCheckSaysNothingSent(item: CritiqueObligation, c: ScenarioResult, texts: string[] | undefined, sent: string[]): boolean {
    const finding = c.id.startsWith('finding-') ? this.findings(item).find(f => findingKey(f) === c.id) : undefined
    const said = [c.observed ?? '', finding?.what ?? ''].join('\n')
    return !quotesASentFile(said, texts) && !wordsHold(said, sent)
  }
  private onlyDamonRecords(item: CritiqueObligation, c: ScenarioResult): boolean {
    const record = (e: string): boolean => this.damonRecordRef(e)
    const evidence = c.evidence ?? []
    if (!evidence.length || !evidence.every(record)) return false
    if (!c.id.startsWith('finding-')) return true
    const finding = this.findings(item).find(f => findingKey(f) === c.id)
    return !finding || record(finding.where ?? '')
  }
  private sheetLine(item: CritiqueObligation, f: { impact?: string; where: string; what: string }, view: { sent: string[]; texts: string[] | undefined; answerSheets: { path: string; headings: string[] }[] }, card?: OutwardCard): boolean {
    if (!/^(?:low|medium)$/i.test((f.impact ?? '').trim())) return false
    const file = firstFile(f.where)
    if (!file || !isFormSheet(file)) return false
    const norm = (x: string): string => x.replace(/\\/g, '/').toLowerCase()
    const onCard = [...item.files, ...(card?.files ?? [])].find(x => norm(x) === norm(file) || norm(x).endsWith('/' + norm(file)))
    if (!onCard) return false
    const sheet = view.answerSheets.find(s => norm(s.path) === norm(onCard))
    if (!sheet || placeInAnswers(f.where, sheet.headings)) return false
    let answers: string | undefined, text: string | undefined
    try { text = this.readText?.(onCard); answers = text ? formAnswers(text)?.answers : undefined } catch { answers = undefined }
    if (answers === undefined || quotesASentFile(`${f.where}\n${f.what}`, [answers])) return false
    if (namesSentFile(f.what, view.sent) || namesSentFile(f.where, view.sent)) return false
    if (placeInAnswersText(f.where, answers)) return false
    const heading = placeNamesNotesHeading(f.where, notesHeadings(text ?? ''))
    if (!heading) return false
    if (quotesSentOutsideSection(`${f.where}\n${f.what}`, view.texts, sectionUnder(text ?? '', heading))) return false
    if (wordsHold(f.what, view.sent) || wordsHold(f.where, view.sent)) return false
    const failed = this.originOf(item, findingKey(f))?.failed ?? []
    return !failed.some(isPackageScenario)
  }
  styleNotes(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last) return []
    const sent = sentFiles(item.files)
    const inSent = (text: string, evidence: string[] = []): boolean => namesASentFile(text, sent) || namesSentFile(text, sent) || evidence.some(e => !/^https?:/i.test(e) && namesASentFile(e, sent))
    const checks = last.checks.filter(c => c.status === 'fail' && this.styleOnlyCheck(item, c) && inSent(c.observed ?? '', c.evidence ?? [])).map(c => c.observed ?? '')
    const found = last.parsed.findings.filter(f => onlyStyle(f.what) && inSent(`${f.where} ${f.what}`)).map(f => `${f.where}: ${f.what}`)
    return [...new Set([...checks, ...found])].slice(0, 3).map(line => `${STYLE_NOTE}${line}`)
  }
  findings(item: CritiqueObligation): CriticReport['findings'] {
    return [...new Map([...(item.carriedFindings ?? []), ...item.reports.flatMap(r => r.parsed.findings)].map(f => [findingKey(f), f])).values()]
  }
  findingsInScope(item: CritiqueObligation): CriticReport['findings'] {
    return this.findings(item).filter(f => !outsideFiles(f.where, item.files))
  }
  citedFilesMoved(item: CritiqueObligation, root: string): boolean {
    const last = item.reports.at(-1)
    if (!last) return false
    const at = Date.parse(last.at)
    if (!Number.isFinite(at)) return false
    const fileIn = (text: string): string[] => [...(text ?? '').matchAll(/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5}\b/g)].map(m => m[0])
    const failing = last.checks.filter(c => c.status !== 'pass')
    const pkg = this.packageLane(item)
    const sent = sentFiles(item.files)
    const owedFile = (file: string): boolean => !outsideFiles(file, item.files) && !DAMONS_OWN.has(this.roleOf(file))
    const cited = new Set([
      ...last.parsed.findings.filter(f => !pkg || this.owedInPackage(item, f)).flatMap(f => fileIn(f.where).slice(0, 1)),
      ...failing.flatMap(c => c.evidence.filter(e => !/^https?:/i.test(e)).flatMap(fileIn)).filter(file => !pkg || owedFile(file) || !outsideFiles(file, sent))
    ])
    for (const file of cited) {
      try { if (statSync(join(root, ...file.split('/'))).mtimeMs > at) return true } catch {}
    }
    return false
  }
  openFindings(item: CritiqueObligation): CriticReport['findings'] {
    const passed = new Set(item.reports.flatMap(r => r.checks.filter(c => c.status === 'pass' && c.evidence.length).map(c => c.id)))
    const raised = [...new Map([...(item.carriedFindings ?? []), ...item.reports.slice(0, -1).flatMap(r => r.parsed.findings)].map(f => [findingKey(f), f])).values()]
    const owed = (f: { where: string; what: string }): boolean => this.packageLane(item) ? this.owedInPackage(item, f) : !outsideFiles(f.where, item.files)
    return raised.filter(f => owed(f) && !passed.has(findingKey(f)))
  }
  findingsToRecheck(item: CritiqueObligation): CriticReport['findings'] {
    const all = this.findings(item)
    return this.packageLane(item) ? all.filter(f => this.owedInPackage(item, f)) : all
  }
  teamNotes(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last || !this.packageLane(item)) return []
    const view = this.packageView(item), { sent, texts } = view
    const scenarios = last.checks.filter(c => c.status !== 'pass' && !c.id.startsWith('finding-') && this.packageCheckNote(c, sent, texts, false, view.answerSheets.map(s => s.path))).map(c => `${c.id}: ${c.observed ?? ''}`)
    const notes = last.parsed.findings.filter(f => this.packageNote(item, f, view) && (!outsideFiles(f.where, item.files) || this.damonsOwn(f, sentFiles(item.files))) && !this.inSheet(item, f))
    const now = new Set(last.parsed.findings.map(f => findingKey(f))), passed = this.releasedChecks(item)
    const earlier = [...new Map([...(item.carriedFindings ?? []), ...item.reports.slice(0, -1).flatMap(r => r.parsed.findings)].map(f => [findingKey(f), f])).values()]
      .filter(f => !now.has(findingKey(f)) && !passed.has(findingKey(f)))
    return [...scenarios, ...notes.map(f => `${f.where}: ${f.what}`), ...earlier.map(f => `earlier check said: ${f.where}: ${f.what}; not re-raised`)].slice(0, Math.max(8, scenarios.length))
  }
  outsideNotes(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last || !this.packageLane(item)) return []
    const sent = sentFiles(item.files)
    return last.parsed.findings.filter(f => outsideFiles(f.where, item.files) && !this.damonsOwn(f, sent) && !namesSentFile(f.what, sent) && this.packageNote(item, f)).map(f => `${f.where}: ${f.what}`).slice(0, 8)
  }
  sheetCautions(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last || !this.packageLane(item)) return []
    return last.parsed.findings.filter(f => this.inSheet(item, f)).map(f => `Damon's check on ${firstFile(f.where)} (for you, not sent): ${f.what}`).slice(0, 3)
  }
  sheetFixes(item: CritiqueObligation): string[] {
    const last = item.reports.at(-1)
    if (!last || !this.packageLane(item)) return []
    return last.parsed.findings.filter(f => this.inSheet(item, f)).map(f => `${firstFile(f.where)}: ${f.what}`).slice(0, 8)
  }
  linkRepair(id: string, findingId: string, taskId: string, owner: string): void {
    const all = this.list(), item = all.find(x => x.id === id && !x.retired)
    if (!item || !this.findings(item).some(f => findingKey(f) === findingId)) throw new Error('Unknown current finding.')
    item.repairs = [...(item.repairs ?? []).filter(r => r.findingId !== findingId), { findingId, taskId, owner, at: new Date().toISOString() }]
    this.save(all)
  }
  parkForOwner(id: string, files: string[]): CriticReport['findings'] {
    const all = this.list(), item = all.find(x => x.id === id && !x.retired)
    if (!item) throw new Error('This critique obligation is unavailable.')
    const paths = files.map(f => f.replace(/\\/g, '/').toLowerCase()).filter(Boolean)
    if (!paths.length) return []
    const about = (f: { where: string }): boolean => {
      const where = (f.where ?? '').replace(/\\/g, '/').toLowerCase()
      return paths.some(p => where.includes(p))
    }
    const moving = (item.carriedFindings ?? []).filter(about)
    if (!moving.length) return item.parkedForOwner ?? []
    item.carriedFindings = (item.carriedFindings ?? []).filter(f => !about(f))
    const known = new Set((item.parkedForOwner ?? []).map(f => findingKey(f)))
    item.parkedForOwner = [...(item.parkedForOwner ?? []), ...moving.filter(f => !known.has(findingKey(f)))]
    this.save(all)
    return item.parkedForOwner
  }

  requireOwnerCheck(id: string, challenges: string[]): CritiqueObligation {
    const all = this.list(), item = all.find(x => x.id === id && !x.retired)
    if (!item) throw new Error('This critique obligation is unavailable.')
    const known = new Set(item.carriedChallenges ?? [])
    const fresh = challenges.filter(c => c.trim() && !known.has(c))
    if (!fresh.length) return item
    item.carriedChallenges = [...(item.carriedChallenges ?? []), ...fresh]
    this.save(all)
    return item
  }

  challenges(item: CritiqueObligation): string[] {
    const released = new Set(item.releasedChallenges ?? [])
    const kept = (item.ownerDecisions ?? []).filter(d => d.decision === 'keep').map(d => d.challenge)
    return [...new Set([...(item.carriedChallenges ?? []), ...item.reports.flatMap(r => r.parsed.forTheOwner)])].filter(c => (isOwnerConfirmation(c) || namesADecision(c)) && !adviceOnACard(c) && !released.has(c) && !item.ownerDecisions?.some(d => d.challenge === c) && !(kept.length && arguesAKeptDecision(c, kept)))
  }
  optionalNotes(item: CritiqueObligation): string[] {
    const released = new Set(item.releasedChallenges ?? [])
    const last = item.reports.at(-1)
    if (!last) return []
    return [...new Set(last.parsed.notes ?? [])].filter(c => !isOwnerConfirmation(c) && !adviceOnACard(c) && !released.has(c)).slice(0, 2)
  }
  cardAdvice(item: CritiqueObligation): { card: string; line: string }[] {
    const released = new Set(item.releasedChallenges ?? [])
    const out: { card: string; line: string }[] = []
    for (const line of new Set([...(item.carriedChallenges ?? []), ...item.reports.flatMap(r => r.parsed.forTheOwner)])) {
      const card = adviceOnACard(line)
      if (card && !released.has(line)) out.push({ card, line })
    }
    return out
  }
  releaseOwnerCheck(id: string, challenges: string[]): void {
    const all = this.list(), item = all.find(x => x.id === id && !x.retired)
    if (!item) return
    const known = new Set(item.releasedChallenges ?? [])
    const fresh = challenges.filter(c => c.trim() && !known.has(c))
    if (!fresh.length) return
    item.releasedChallenges = [...(item.releasedChallenges ?? []), ...fresh]
    this.save(all)
  }
  sendBackOwnerDecision(id: string, challenge: string, by: 'owner' | 'damon' = 'owner'): void {
    const all = this.list(), origin = this.get(id)
    if (!origin) return
    const item = all.find(x => x.scope === origin.scope && !x.retired) ?? origin
    if (item.ownerDecisions?.some(d => d.challenge === challenge)) return
    item.ownerDecisions ??= []
    item.ownerDecisions.push({ challenge, decision: 'send-back', at: new Date().toISOString(), by })
    this.save(all)
  }
  keepOwnerDecision(id: string, challenge: string): void {
    const all = this.list(), origin = this.get(id)
    if (!origin) throw new Error(DECISION_UNKNOWN)
    const item = all.find(x => x.scope === origin.scope && !x.retired)
    if (!item || !this.challenges(item).includes(challenge)) throw new Error(DECISION_NOT_ASKED)
    item.ownerDecisions ??= []
    item.ownerDecisions.push({ challenge, decision: 'keep', at: new Date().toISOString() })
    this.save(all)
  }
  brief(): string {
    const pending = this.list().filter(x => !x.retired && this.blocker(x))
    return pending.length ? `Outstanding workflow critiques (durable, not completed by assigning an agent):\n${pending.map(x => JSON.stringify({ id: x.id, scope: x.scope, files: x.files, tasks: x.taskIds, blocker: this.blocker(x) })).join('\n')}\nCall run_workflow_critique with the outstanding ID. Finding defects completes an audit, not the product. Fix and recheck before release.` : ''
  }
}
