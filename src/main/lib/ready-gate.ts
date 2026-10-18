// Decides which check lane covers a Your turn card and whether it has passed on the files
// the card sends.
import { createHash } from 'node:crypto'
import { becameReady, readyCheckFor, readyGate } from '../../shared/your-turn'
import { isBackupName } from '../../shared/outgoing'
import { sentFiles, type OutwardCard } from './critique-store'
import { PACKAGE_SCENARIOS, formAnswers, isFormSheet, isPackageScenario } from '../../shared/outgoing'
import type { PackageEvidence } from '../../shared/work-needs'

export function cardSentFiles(files: string[]): string[] {
  const names = files.map(f => f.replace(/\\/g, '/').split('/').pop() ?? f)
  return sentFiles(files).filter(f => !isBackupName(f.replace(/\\/g, '/').split('/').pop() ?? f, names))
}

export function outwardCardOf(kind: string | undefined, files: string[]): OutwardCard | undefined {
  if (kind !== 'submit' && kind !== 'send') return undefined
  return { files, sent: cardSentFiles(files) }
}

export const PACKAGE_OUTWARD_CHECK = { isOutward: isPackageScenario, required: PACKAGE_SCENARIOS.map(s => s.id) as readonly string[] }

export interface ReadyLane { id: string; scope: string; files: string[]; reports: unknown[]; context?: unknown }
export interface ReadyOn { passedId?: string; outstandingId?: string; key?: string }

export const readyWords = (title: string): string => `Ready: ${title}. Open Your turn.`

export function laneReadyKey(lane: ReadyLane): string {
  const ctx = lane.context
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return lane.id
  const { observed: _observed, ...rest } = ctx as Record<string, unknown>
  void _observed
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

export function readyOn(live: ReadyLane[], card: { files: string[]; sent?: string[] }, clear: (lane: ReadyLane) => boolean, cardKey: () => string): ReadyOn {
  const on = readyCheckFor(live, card, clear)
  if (!on) return { key: 'card:' + cardKey() }
  const lane = live.find(x => x.id === on.passedId)
  return lane ? { ...on, key: laneReadyKey(lane) } : on
}

export function ownPackagePlans<T extends { outputs: string[] }>(plans: T[], cardFiles: string[], folderOf: (file: string) => string | undefined): T[] {
  const folders = (files: string[]): Set<string> => new Set(files.map(f => folderOf(f.replace(/\\/g, '/'))?.toLowerCase()).filter((f): f is string => !!f))
  const card = folders(cardFiles)
  if (!card.size) return plans
  return plans.filter(p => {
    const own = folders(p.outputs)
    return own.size === 0 || [...own].some(f => card.has(f))
  })
}

export function cardActionScope(h: { taskId?: string }, paths: string[]): string {
  return 'owner-action:' + (h.taskId ?? 'files-' + createHash('sha256').update([...paths].sort().join('\n')).digest('hex').slice(0, 12))
}
export const cardPaths = (h: { file?: string; files?: string[] }): string[] => (h.files ?? (h.file ? [h.file] : [])).map(f => f.replace(/\\/g, '/').toLowerCase().replace(/\/$/, ''))

export function zombieLanes<T extends { id: string; scope: string; files: string[]; retired?: unknown; expiresAt?: string }>(live: T[], cards: { taskId?: string; file?: string; files?: string[] }[], now: number, passed: (lane: T) => boolean): { id: string; reason: string }[] {
  const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
  const open = cards.map(c => ({ paths: cardPaths(c), scope: cardActionScope(c, cardPaths(c)) }))
  const scopes = new Set(open.map(c => c.scope))
  const lanes = live.filter(x => !x.retired)
  const own = lanes.filter(x => scopes.has(x.scope))
  const out: { id: string; reason: string }[] = []
  for (const x of lanes) {
    if (!x.scope.startsWith('owner-action:') || scopes.has(x.scope)) continue
    const files = x.files.map(norm)
    const touched = open.filter(c => c.paths.some(p => files.includes(p)))
    const stem = (p: string): string => p.replace(/\.[a-z0-9]{1,5}$/, '')
    const beside = (c: { paths: string[] }): string[] => files.filter(f => !c.paths.includes(f) && c.paths.some(p => stem(p) === stem(f)))
    const covered = touched.length > 0 && touched.every(c => { const o = own.find(l => l.scope === c.scope); return !!o && [...c.paths.filter(p => files.includes(p)), ...beside(c)].every(p => o.files.some(g => norm(g) === p)) })
    if (covered) { out.push({ id: x.id, reason: `Set aside: ${touched.map(c => c.scope).join(', ')} ${touched.length === 1 ? 'is the card\'s own check and covers' : 'are the cards\' own checks and cover'} every file of ${touched.length === 1 ? 'that card' : 'those cards'} this older lane covered.` }); continue }
    const expired = !!x.expiresAt && Date.parse(x.expiresAt) <= now && !passed(x)
    const onlyCheck = open.some(c => c.paths.length > 0 && !own.some(o => o.scope === c.scope) && c.paths.every(p => files.includes(p)))
    if (expired && !onlyCheck) out.push({ id: x.id, reason: 'Set aside: its window ran out without a pass, and no open card is checked by it.' })
  }
  return out
}

export function clearedOnAPassedCheck(block: string | null, key: string | undefined): boolean {
  return !block && !!key && !key.startsWith('card:')
}
export function outwardGate(kind: string | undefined, block: string | null, on: () => ReadyOn): { block: string | null; key?: string } {
  if ((kind !== 'submit' && kind !== 'send') || block) return { block }
  const ready = on()
  if (!ready.passedId && !ready.outstandingId) return { block, key: ready.key }
  return { block: readyGate({ block, outward: true, passedId: ready.passedId, outstandingId: ready.outstandingId }), key: ready.key }
}

export interface PushStore { readyPushed(id: string, key: string): boolean }

export function pushIfTurnedReady(yours: PushStore, item: { id: string; title: string; waitingOn?: string }, block: string | null, key: string | undefined, tell: (words: string) => void): boolean {
  if (!key || !becameReady(item, { waitingOn: block ?? undefined })) return false
  if (!yours.readyPushed(item.id, key)) return false
  tell(readyWords(item.title))
  return true
}

export function packageEvidenceFor(deps: { leaves: (file: string) => boolean; currentHash: (file: string) => string | undefined; text: (file: string) => string | undefined; onCard?: (file: string) => boolean }): PackageEvidence {
  return (file, hash) => {
    if (deps.leaves(file)) return hash
    if (!isFormSheet(file) || (deps.onCard && !deps.onCard(file))) return undefined
    if (deps.currentHash(file) !== hash) return hash
    return formSheetKey(deps.text(file)) ?? hash
  }
}
export function formSheetKey(text: string | undefined): string | undefined {
  const fa = text === undefined ? undefined : formAnswers(text)
  return fa ? 'answers:' + createHash('sha256').update(fa.answers).digest('hex') : undefined
}
export function formSheetKeys(files: string[], deps: { currentHash: (file: string) => string | undefined; text: (file: string) => string | undefined }): { file: string; key: string }[] {
  return files.map(f => f.replace(/\\/g, '/')).filter(isFormSheet).map(file => ({ file, key: formSheetKey(deps.text(file)) ?? deps.currentHash(file) ?? 'missing' }))
}

export interface PackageBasisShape { protocol?: number; facts?: string; environment?: unknown; files?: { file: string; hash: string }[]; requirements?: unknown; needs?: unknown; needsOn?: string; formSheets?: unknown; prerequisites?: unknown; unreadable?: unknown }
export function packageBasisUnchanged(o: PackageBasisShape, now: PackageBasisShape & { files: { file: string; hash: string }[] }, deps: {
  needsStillAtLastReport: () => boolean
  sameNeedsByLeaves: (old: PackageBasisShape) => boolean
}): boolean {
  const sent = new Set(now.files.map(f => f.file))
  const oldSent = (o.files ?? []).filter(f => sent.has(f.file))
  const sameSetting = (o.protocol !== 2 && o.protocol !== 3) || (o.facts === now.facts && JSON.stringify(o.environment) === JSON.stringify(now.environment))
  const migrating = o.protocol === 2 && now.protocol === 3
  const reqs = (x: unknown): string[] => Array.isArray(x) ? x.map(r => JSON.stringify(r)) : []
  const sameRequirements = migrating ? reqs(now.requirements).every(r => reqs(o.requirements).includes(r)) : JSON.stringify(o.requirements) === JSON.stringify(now.requirements)
  const sameNeeds = migrating ? deps.needsStillAtLastReport() : now.needsOn === 'leaves' ? deps.sameNeedsByLeaves(o) : JSON.stringify(o.needs) === JSON.stringify(now.needs)
  const samePrerequisites = migrating ? reqs(now.prerequisites).every(r => reqs(o.prerequisites).includes(r)) : JSON.stringify(o.prerequisites) === JSON.stringify(now.prerequisites)
  const sameForms = o.formSheets === undefined || JSON.stringify(o.formSheets) === JSON.stringify(now.formSheets)
  return sameSetting && JSON.stringify(oldSent) === JSON.stringify(now.files) && sameRequirements && sameNeeds && samePrerequisites && sameForms && JSON.stringify(o.unreadable) === JSON.stringify(now.unreadable)
}
