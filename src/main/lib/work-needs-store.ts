import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { readJson, writeJson } from './json-file'
import { matchesScope } from '../../shared/scope'
import type { TaskInfo } from '../../shared/types'
import { citedSections, needsBrief, sectionsText, unresolvedOwnerNeeds, type DeliverablePlan, type NeedEvidence, type NeedReply, type PlanInput, type WorkNeed } from '../../shared/work-needs'
import { ARCHIVE_FILE, archivable, latestEntries, mergeArchived, type ArchivedPlanEntry, type ArchiveRefs, type PlanArchive } from './work-needs-archive'

const listCache = new Map<string, { key: string; plans: DeliverablePlan[] }>()
function statKey(file: string): string | null {
  try { const s = statSync(file); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { return null }
}
const stampCache = new Map<string, { key: string; hash: string }>()
const STAMP_SETTLED_MS = 2000
const PATH_TRUST_MS = 10_000
const realRoots = new Map<string, { at: number; root: string }>()
const checkedPaths = new Map<string, { at: number; target: string }>()
function servesTask(p: DeliverablePlan, task: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>): boolean {
  return Boolean(task.deliverableIds?.includes(p.id)) || p.taskIds.includes(task.id) || p.outputs.some((f) => matchesScope(task.writes ?? [], f))
}

export const FOUNDATION_NOT_RETIRED = 'A project foundation cannot be retired: the jobs on its files wait for its review, and a retired one could never be reviewed. Review it with review_deliverable, or record a new coverage revision.'
export class WorkNeedsStore {
  private file: string
  private archiveFile: string
  constructor(private readonly stateDir: string, readonly projectPath: string, private now = () => new Date().toISOString()) {
    this.file = join(stateDir, 'work-needs.json')
    this.archiveFile = join(stateDir, ARCHIVE_FILE)
  }
  private factsNeedMet(): (planId: string, n: WorkNeed) => boolean {
    return () => false
  }
  list(): DeliverablePlan[] {
    const key = statKey(this.file), archiveKey = statKey(this.archiveFile)
    const both = `${key}|${archiveKey}`
    const known = key || archiveKey ? listCache.get(this.file) : undefined
    if (known && known.key === both) return structuredClone(known.plans)
    const main = this.readMain(), entries = this.readArchive()
    const plans = mergeArchived(main, entries)
    if (key || archiveKey) listCache.set(this.file, { key: both, plans })
    return structuredClone(plans)
  }
  unarchived(): DeliverablePlan[] { return structuredClone(this.readMain()) }
  private readMain(): DeliverablePlan[] {
    const data = readJson<{ version: number; plans: DeliverablePlan[] } | null>(this.file, null)
    if (!data) {
      if (existsSync(this.file)) throw new Error('The saved needs could not be read. They must be recovered before work is marked finished.')
      return []
    }
    if (data.version !== 1 || !Array.isArray(data.plans)) throw new Error('The saved needs use an unsupported format.')
    return data.plans
  }
  private readArchive(): ArchivedPlanEntry[] {
    const data = readJson<PlanArchive | null>(this.archiveFile, null)
    if (!data) {
      if (existsSync(this.archiveFile)) throw new Error('The plan archive could not be read. It must be recovered before work is marked finished.')
      return []
    }
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('The plan archive uses an unsupported format.')
    return data.entries
  }
  private save(plans: DeliverablePlan[]): void {
    listCache.delete(this.file)
    const latest = latestEntries(this.readArchive())
    const inMain = latest.size ? new Set(this.readMain().map(p => p.id)) : new Set<string>()
    const kept = latest.size ? plans.filter(p => { const e = latest.get(p.id); return !e || inMain.has(p.id) || JSON.stringify(e.plan) !== JSON.stringify(p) }) : plans
    writeJson(this.file, { version: 1, plans: kept })
  }
  archiveClosed(refs: ArchiveRefs, now = Date.now(), only?: string[]): string[] {
    const merged = this.list(), main = this.readMain()
    const moving = main.filter(p => (!only || only.includes(p.id)) && archivable(p, refs, now) && this.pending(p).length === 0)
    if (!moving.length) return []
    const at = new Date(now).toISOString()
    const entries: ArchivedPlanEntry[] = [...this.readArchive(), ...moving.map(p => ({ archivedAt: at, position: merged.findIndex(x => x.id === p.id), plan: p }))]
    listCache.delete(this.file)
    writeJson(this.archiveFile, { version: 1, entries } satisfies PlanArchive)
    const ids = new Set(moving.map(p => p.id))
    writeJson(this.file, { version: 1, plans: main.filter(p => !ids.has(p.id)) })
    listCache.delete(this.file)
    return moving.map(p => p.id)
  }
  askQuestions(questions: string[], context: string): void {
    for (const question of questions) {
      const id = `question-${createHash('sha256').update(question.trim().toLowerCase()).digest('hex').slice(0, 16)}`
      if (this.list().some(p => p.id === id)) continue
      this.record({ id, title: 'A question from Damon', context, outputs: [], needs: [{ id: 'answer', title: question, why: context, importance: 'required', input: 'answer', owner: true, sources: ['Damon asked in this project'] }] }, 'root')
    }
  }
  private changed(p: DeliverablePlan): void { p.revision++; p.updatedAt = this.now(); delete p.verified }
  private path(file: string): string {
    if (!file || isAbsolute(file) || /[\x00-\x1f:*?]/.test(file)) throw new Error('Use an exact project-relative file path.')
    const now = Date.now(), pathKey = `${this.projectPath}\n${file}`
    const passed = checkedPaths.get(pathKey)
    if (passed && now - passed.at < PATH_TRUST_MS) return passed.target
    let real = realRoots.get(this.projectPath)
    if (!real || now - real.at >= PATH_TRUST_MS) { real = { at: now, root: realpathSync(this.projectPath) }; realRoots.set(this.projectPath, real) }
    const root = real.root
    const target = resolve(root, file)
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('The file must be inside this project.')
    let cursor = target
    while (!existsSync(cursor)) {
      const parent = resolve(cursor, '..')
      if (parent === cursor) throw new Error('The project folder is unavailable.')
      cursor = parent
    }
    const actual = relative(root, realpathSync(cursor))
    if (actual.startsWith('..') || isAbsolute(actual)) throw new Error('The file resolves outside this project.')
    if (checkedPaths.size > 20_000) checkedPaths.clear()
    checkedPaths.set(pathKey, { at: now, target })
    return target
  }
  stamp(file: string): { file: string; hash: string } {
    const target = this.path(file)
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('The selected file is missing, not a file, or too large to verify (64 MB limit).')
    const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    const known = stampCache.get(target)
    if (known && known.key === key) return { file: file.replace(/\\/g, '/'), hash: known.hash }
    const hash = createHash('sha256').update(readFileSync(target)).digest('hex')
    if (Date.now() - stat.ctimeMs >= STAMP_SETTLED_MS) {
      if (stampCache.size > 20_000) stampCache.clear()
      stampCache.set(target, { key, hash })
    }
    return { file: file.replace(/\\/g, '/'), hash }
  }
  pathFor(file: string): string { return this.path(file) }
  private sectionText(file: string, headings: string[]): string | undefined {
    if (!/\.(?:md|txt|markdown)$/i.test(file)) return undefined
    try { return sectionsText(readFileSync(this.path(file), 'utf8'), headings) } catch { return undefined }
  }
  private withSection(a: NeedEvidence): NeedEvidence {
    const { section: _old, ...rest } = a
    void _old
    if (!a.file || !/\.(?:md|txt|markdown)$/i.test(a.file)) return rest
    let text: string
    try { text = readFileSync(this.path(a.file), 'utf8') } catch { return rest }
    const headings = citedSections(text, `${a.answer ?? ''}\n${a.explanation ?? ''}`)
    const part = headings.length ? sectionsText(text, headings) : undefined
    return part === undefined ? rest : { ...rest, section: { headings, hash: createHash('sha256').update(part).digest('hex') } }
  }
  private answerStands(a: NeedEvidence & { file: string }): boolean {
    if (this.stamp(a.file).hash === a.hash) return true
    if (!a.section) return false
    const part = this.sectionText(a.file, a.section.headings)
    return part !== undefined && createHash('sha256').update(part).digest('hex') === a.section.hash
  }
  restamp(files: string[], by: string, what = 'A reviewed version of the chosen file landed; the answer follows it', back = false): number {
    const wanted = new Set(files.map(f => f.replace(/\\/g, '/').toLowerCase()))
    const plans = this.list()
    let count = 0
    for (const p of plans) for (const n of p.needs) {
      if (!n.answer?.file || n.retired) continue
      if (!wanted.has(n.answer.file.replace(/\\/g, '/').toLowerCase())) continue
      try {
        const stamp = this.stamp(n.answer.file)
        if (stamp.hash === n.answer.hash) continue
        if (back && !n.history.some(h => h.answer?.hash === stamp.hash)) continue
        n.answer = this.withSection({ ...n.answer, ...stamp })
        n.revision++
        n.history.push({ at: this.now(), by, what, answer: n.answer, ownerDecision: n.ownerDecision })
        this.changed(p); n.planRevision = p.revision; count++
      } catch {}
    }
    if (count) this.save(plans)
    return count
  }
  record(input: PlanInput, by: string): DeliverablePlan {
    if (new Set(input.needs.map(n => n.id)).size !== input.needs.length) throw new Error('Each need must have a distinct ID.')
    for (const file of input.outputs) this.path(file)
    const plans = this.list()
    let p = plans.find(p => p.id === input.id)
    const isNew = !p
    if (!p) {
      p = { ...input, outputs: [...new Set(input.outputs)], taskIds: input.taskIds ?? [], needs: [], revision: 0, updatedAt: this.now() }
      plans.push(p)
    }
    const before = JSON.stringify(p)
    if (p.context !== input.context && p.needs.some(n => n.ownerDecision)) throw new Error('This context has owner decisions. Record the changed scope as a new deliverable rather than silently reusing those decisions.')
    const moved: WorkNeed[] = []
    for (const definition of input.needs) {
      const old = p.needs.find(n => n.id === definition.id)
      if (old && (old.ownerDecision || old.answer) && JSON.stringify({ ...definition }) !== JSON.stringify({ id: old.id, title: old.title, why: old.why, importance: old.importance, input: old.input, owner: old.owner, sources: old.sources })) {
        throw new Error(`The answered need "${old.title}" cannot be rewritten. Record a distinct new need if the scope changed.`)
      }
      if (old) {
        const previous = JSON.stringify([old.title, old.why, old.importance, old.input, old.owner, old.sources])
        Object.assign(old, definition)
        if (previous !== JSON.stringify([old.title, old.why, old.importance, old.input, old.owner, old.sources])) { old.revision++; moved.push(old) }
      }
      else {
        const added: WorkNeed = { ...definition, revision: 1, history: [{ at: this.now(), by, what: 'Need discovered' }] }
        p.needs.push(added); moved.push(added)
      }
    }
    p.title = input.title; p.context = input.context
    p.outputs = [...new Set(input.outputs.map(f => f.replace(/\\/g, '/')))]
    p.taskIds = [...new Set([...p.taskIds, ...(input.taskIds ?? [])])]
    if (!isNew && before === JSON.stringify(p)) return p
    this.changed(p)
    for (const n of moved) n.planRevision = p.revision
    this.save(plans)
    return p
  }
  private mutate(id: string, needId: string, by: string, what: string, fn: (n: WorkNeed) => void): DeliverablePlan {
    const plans = this.list(), p = plans.find(p => p.id === id), n = p?.needs.find(n => n.id === needId)
    if (!p || !n || n.retired) throw new Error('That need is no longer available. Refresh Your turn.')
    fn(n); n.revision++; n.history.push({ at: this.now(), by, what, answer: n.answer, ownerDecision: n.ownerDecision }); this.changed(p); n.planRevision = p.revision; this.save(plans)
    return p
  }
  reply(id: string, needId: string, reply: NeedReply): DeliverablePlan {
    return this.mutate(id, needId, 'owner', reply.action === 'omit' ? 'Owner chose to omit' : 'Owner supplied input', n => {
      if (reply.revision !== n.revision) throw new Error('This request changed or was already answered. Refresh Your turn.')
      delete n.issue
      if (reply.action === 'omit') {
        if (n.importance === 'required') throw new Error('This is recorded as required. Ask Damon to resolve the requirement before omitting it.')
        n.ownerDecision = 'omitted'; delete n.answer; return
      }
      const value = reply.value?.trim()
      if (!value) throw new Error('Choose a file or write an answer first.')
      if (reply.action === 'file') n.answer = { ...this.stamp(value), explanation: 'Selected by the owner; inspect suitability and incorporation.' }
      else {
        if (n.input === 'file') throw new Error('This request needs a file. Attach one or choose an existing file.')
        n.answer = { answer: value.slice(0, 8000), explanation: 'The owner’s answer.' }
      }
      n.ownerDecision = 'provided'
    })
  }
  supply(id: string, needId: string, evidence: NeedEvidence, by: string): DeliverablePlan {
    return this.mutate(id, needId, by, 'Evidence recorded', n => {
      if (n.ownerDecision) throw new Error('The owner already decided this need. Do not replace their choice.')
      if (!evidence.explanation.trim()) throw new Error('Explain how you inspected this material and why it fits.')
      if (n.input === 'file' && !evidence.file) throw new Error('A file need requires an inspected file.')
      n.answer = evidence.file ? this.withSection({ ...evidence, ...this.stamp(evidence.file) }) : (({ section: _s, ...e }) => { void _s; return e })(evidence)
      delete n.issue
    })
  }
  requestCorrection(id: string, needId: string, reason: string, by: string): DeliverablePlan {
    if (!reason.trim()) throw new Error('Explain what is unsuitable or unclear about the input.')
    return this.mutate(id, needId, by, `Input needs correction: ${reason}`, n => {
      if (n.ownerDecision === 'omitted') throw new Error('The owner chose to omit this optional item. Honour that choice.')
      n.issue = reason; n.owner = true
    })
  }
  retire(id: string, needId: string, reason: string, by: string): DeliverablePlan {
    if (!reason.trim()) throw new Error('Explain the scope change that makes this need obsolete.')
    return this.mutate(id, needId, by, `Retired: ${reason}`, n => {
      if (n.ownerDecision) throw new Error('An owner decision cannot be retired by an agent. Keep its history and record new work separately.')
      n.retired = reason
    })
  }
  active(): DeliverablePlan[] { return this.list().filter((p) => !p.retired) }
  retireDeliverable(id: string, reason: string, by: string): DeliverablePlan {
    if (reason.trim().length < 15) throw new Error('Say in a sentence why this deliverable no longer applies.')
    const plans = this.list()
    const p = plans.find((x) => x.id === id)
    if (!p) throw new Error(`There is no deliverable "${id}". list_deliverables shows the ids.`)
    if (p.retired) return p
    if (p.needs.some((n) => n.ownerDecision && n.ownerDecision !== 'omitted' && !n.retired)) throw new Error('The owner decided something on this deliverable; ask him on his list before retiring it.')
    if (/^coverage-.+-r\d+$/.test(p.id) || p.outputs.some((f) => f.replace(/\\/g, '/').startsWith('damon-coverage/'))) throw new Error(FOUNDATION_NOT_RETIRED)
    if (p.needs.some((n) => n.owner && !n.ownerDecision && !n.retired)) throw new Error('The owner is still asked something on this deliverable; close or answer that first, then retire it.')
    p.retired = { at: this.now(), by, reason: reason.trim() }
    p.revision += 1
    p.updatedAt = this.now()
    this.save(plans)
    return p
  }
  forOwnDeliverables(task: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>): DeliverablePlan[] {
    const own = this.active().filter(p => task.deliverableIds?.includes(p.id) || p.taskIds.includes(task.id))
    return own.length ? own : this.forTask(task)
  }
  forTask(task: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>): DeliverablePlan[] {
    return this.active().filter((p) => servesTask(p, task))
  }
  forTasks(tasks: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>[]): DeliverablePlan[] {
    const plans = this.active()
    const ids = new Set(tasks.flatMap((t) => plans.filter((p) => servesTask(p, t)).map((p) => p.id)))
    return plans.filter((p) => ids.has(p.id))
  }
  cards() {
    const met = this.factsNeedMet()
    const plans = this.active().map(p => ({ ...p, needs: p.needs.filter(n => !met(p.id, n)).map(n => {
      if (n.issue) return { ...n, owner: true, answer: undefined, ownerDecision: undefined, why: `${n.why} ${n.issue}` }
      if (!n.answer?.file || n.ownerDecision === 'omitted') return n
      try { if (this.answerStands({ ...n.answer, file: n.answer.file })) return n } catch {}
      return { ...n, owner: true, answer: undefined, ownerDecision: undefined, why: `${n.why} The previously selected file changed or is unavailable. Please select the intended file again.` }
    }) }))
    return unresolvedOwnerNeeds(plans)
  }
  brief(task?: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>): string { return needsBrief(task ? this.forTask(task) : this.active()) }
  pending(p: DeliverablePlan): string[] {
    const met = this.factsNeedMet()
    return p.needs.filter(n => !n.retired && n.ownerDecision !== 'omitted' && !met(p.id, n)).flatMap(n => {
      if (n.issue) return [`${n.title}: ${n.issue}`]
      if (!n.answer) return [`${n.title}: ${n.owner ? 'awaiting your input' : 'awaiting evidence'}`]
      if (n.answer.file) {
        try { if (!this.answerStands({ ...n.answer, file: n.answer.file })) return [`${n.title}: the selected file changed; inspect and select it again`] }
        catch { return [`${n.title}: the selected file is unavailable`] }
      }
      return []
    })
  }
  reviewSnapshot(task: Pick<TaskInfo, 'id' | 'writes' | 'deliverableIds'>): DeliverablePlan[] {
    const isFolder = (f: string): boolean => { try { return statSync(this.pathFor(f)).isDirectory() } catch { return false } }
    const stampOutput = (p: DeliverablePlan, f: string): { file: string; hash: string } => {
      if (!existsSync(this.path(f))) throw new Error(`${f} is listed as an output of "${p.title}" but is not in the project folder${task.writes?.length && !task.writes.some(w => w.replace(/\\/g, '/').toLowerCase() === f.replace(/\\/g, '/').toLowerCase()) ? ', and this job was not allowed to write it' : ''}. This is Damon's own record, not a finding about the work: give that file to a job that may write it, or take it off the deliverable, then approve again.`)
      return this.stamp(f)
    }
    return this.forOwnDeliverables(task).map(p => ({ ...p, verified: { revision: p.revision, files: p.outputs.filter(f => !isFolder(f)).map(f => stampOutput(p, f)), by: '', at: this.now() } }))
  }
  confirmReview(snapshots: DeliverablePlan[], by: string): void {
    const plans = this.list()
    for (const snapshot of snapshots) {
      const p = plans.find(p => p.id === snapshot.id)
      if (!p || p.revision !== snapshot.revision) throw new Error(`Inputs changed during the review of "${p?.title ?? 'this deliverable'}". Review the current deliverable again.`)
      const open = this.pending(p)
      if (open.length) throw new Error(`"${p.title}" still has: ${open.join('; ')}. Record that evidence (supply_need), then approve again.`)
      if (!snapshot.verified || snapshot.verified.files.some(f => this.stamp(f.file).hash !== f.hash)) throw new Error('An output changed while it was reviewed. Review the current files again.')
      p.verified = { ...snapshot.verified, by, at: this.now() }
    }
    this.save(plans)
  }
  carryReview(fromId: string, toId: string, by: string): boolean {
    const plans = this.list()
    const from = plans.find(p => p.id === fromId), to = plans.find(p => p.id === toId)
    if (!from?.verified || from.verified.revision !== from.revision || !to || this.pending(to).length) return false
    try { if (from.verified.files.some(f => this.stamp(f.file).hash !== f.hash)) return false } catch { return false }
    let files: { file: string; hash: string }[]
    try { files = to.outputs.map(f => this.stamp(f)) } catch { return false }
    to.verified = { revision: to.revision, files, by: `${by} (carried from ${fromId})`, at: this.now() }
    this.save(plans)
    return true
  }
  blockers(plans: DeliverablePlan[]): string[] {
    return plans.filter(p => !p.retired).flatMap(p => {
      const pending = this.pending(p)
      if (pending.length) return pending.map(s => `${p.title}: ${s}`)
      if (!p.verified || p.verified.revision !== p.revision) return [`${p.title}: the agreed contents have not been reviewed in the final files`]
      try { if (p.verified.files.some(f => this.stamp(f.file).hash !== f.hash)) return [`${p.title}: the final files changed after review`] }
      catch { return [`${p.title}: a final file is unavailable`] }
      return []
    })
  }
  files(): string[] {
    const found: string[] = []
    const visit = (at: string, depth: number): void => {
      if (depth > 6 || found.length >= 600) return
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', 'out', 'dist', 'release', 'damon-shots'].includes(entry.name) || entry.isSymbolicLink()) continue
        const full = join(at, entry.name)
        if (entry.isDirectory()) visit(full, depth + 1)
        else if (entry.isFile()) found.push(relative(this.projectPath, full).replace(/\\/g, '/'))
        if (found.length >= 600) break
      }
    }
    visit(this.projectPath, 0); return found
  }
}
