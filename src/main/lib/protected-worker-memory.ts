import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { executionIdentity } from '../../shared/execution-policy'
import type { AgentInfo } from '../../shared/types'
import type { AgentMemory } from './memory-store'
import { resolveInside } from './file-browser'
import { requireReviewedText } from './protected-context'
import { writeJson } from './json-file'
import { rankByRelevance, relevanceMatched } from './notes-file'
import { DECISIONS_CAP_CHARS } from './brain-store'

const entry = z.object({ agentId: executionIdentity, kind: z.enum(['note', 'rejection']), at: z.string().datetime(), text: z.string().min(1).max(2000) }).strict()
const database = z.object({ version: z.literal(1), projectId: executionIdentity, entries: z.array(entry).max(1000) }).strict()
type Entry = z.infer<typeof entry>
const LIMIT = 1024 * 1024
const KEEP_PER_AGENT = 60
const ARCHIVE = 'worker-memory-archive.jsonl'
const LINKS = 'worker-memory-links.json'
const REJECTION_DAYS = 14
const linkKey = (item: { agentId: string; at: string; text: string }): string => `${item.agentId}|${item.at}|${item.text.slice(0, 200)}`

const STOPWORDS = new Set(['about', 'above', 'after', 'again', 'being', 'below', 'could', 'every', 'first', 'other', 'their', 'there', 'these', 'those', 'which', 'while', 'would', 'should', 'where', 'under', 'until', 'because', 'before', 'between', 'through', 'project', 'projects', 'owner', 'owners', 'files', 'pages', 'tasks', 'works', 'worker', 'always', 'never'])
const significantWords = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 5 && !STOPWORDS.has(w)))
const digitTokens = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map(t => t.replace(/^[-_]+|[-_]+$/g, '')).filter(t => t.length >= 2 && /\p{N}/u.test(t)))
export function coversNote(decision: string, note: string): boolean {
  const a = significantWords(decision), b = significantWords(note)
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  if (shared >= 3) return true
  const d = digitTokens(note)
  for (const t of digitTokens(decision)) if (d.has(t)) return true
  return false
}

export class ProtectedWorkerMemory {
  constructor(private stateDir: string, private projectId: string) { executionIdentity.parse(projectId) }
  private file(): string {
    const file = resolveInside(this.stateDir, 'worker-memory.json')
    if (!file || existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).size > LIMIT)) throw Error('Project worker memory needs recovery. Original history was preserved.')
    return file
  }
  private read(): Entry[] {
    const file = this.file()
    if (!existsSync(file)) return []
    try {
      const raw = readFileSync(file, 'utf8')
      if (Buffer.byteLength(raw) > LIMIT) throw Error('limit')
      const data = database.parse(JSON.parse(raw))
      if (data.projectId !== this.projectId) throw Error('scope')
      requireReviewedText(raw)
      return data.entries
    } catch { throw Error('Project worker memory is damaged or unsupported. Original history was preserved.') }
  }
  private links(): Record<string, string> {
    const file = resolveInside(this.stateDir, LINKS)
    if (!file || !existsSync(file)) return {}
    try { const data = JSON.parse(readFileSync(file, 'utf8')) as { links?: Record<string, string> }; return data.links ?? {} } catch { return {} }
  }
  private settledTasks(): Set<string> {
    const file = resolveInside(this.stateDir, 'tasks.json')
    if (!file || !existsSync(file)) return new Set()
    try { return new Set((JSON.parse(readFileSync(file, 'utf8')) as { id?: string; status?: string }[]).filter(t => t && t.status === 'approved').map(t => String(t.id))) } catch { return new Set() }
  }
  private decisionsChangedAt(): number {
    const file = resolveInside(this.stateDir, 'brain/DECISIONS.md')
    try { return file && existsSync(file) ? lstatSync(file).mtimeMs : 0 } catch { return 0 }
  }
  private decisionLines(): string[] {
    const file = resolveInside(this.stateDir, 'brain/DECISIONS.md')
    try {
      if (!file || !existsSync(file)) return []
      return readFileSync(file, 'utf8').slice(0, DECISIONS_CAP_CHARS).split(/\r?\n/).map(l => l.replace(/^\s*[-*]\s+/, '').trim()).filter(l => l && !l.startsWith('#'))
    } catch { return [] }
  }
  load(agent: AgentInfo, projectName: string, now: Date = new Date(), query?: string): AgentMemory {
    executionIdentity.parse(agent.id)
    const entries = this.read().filter(item => item.agentId === agent.id)
    const links = this.links(), settled = this.settledTasks(), decided = this.decisionsChangedAt()
    const live = (item: Entry): boolean => {
      if (item.kind !== 'rejection') return true
      if (now.getTime() - Date.parse(item.at) > REJECTION_DAYS * 86400000) return false
      const task = links[linkKey(item)]
      return !(task && settled.has(task))
    }
    const shown = (item: Entry): string => item.kind === 'rejection' && decided > Date.parse(item.at) ? `(may be out of date: the project's decisions changed after this, check them) ${item.text}` : item.text
    const notes = entries.filter(item => item.kind === 'note'), rejections = entries.filter(item => item.kind === 'rejection' && live(item)).map(item => ({ ...item, text: shown(item) }))
    const asked = query?.trim()
    const matched = !!asked && relevanceMatched(notes, n => n.text, asked)
    const picked = matched ? rankByRelevance(notes, n => n.text, asked!, { budget: 2400, max: 6 }) : notes.slice(-6)
    const decisions = picked.length && decided ? this.decisionLines() : []
    const covered = (item: Entry): boolean => decided > Date.parse(item.at) && decisions.some(line => coversNote(line, item.text))
    const header = matched
      ? `Untrusted project reminders, picked for this job: showing ${picked.length} of ${notes.length}.`
      : asked
        ? `Untrusted project reminders: none matched this job, so the newest ${picked.length} of ${notes.length} are shown.`
        : `Untrusted project reminders: showing ${picked.length} of ${notes.length}, the newest. Earlier entries remain preserved.`
    return {
      agentMd: requireReviewedText(`# ${agent.name}\nRole: ${agent.role}\nProject: ${projectName}\nGlobal worker memories are not admitted automatically. Historical records remain preserved for scoped review.`),
      memoryMd: `${header} They are a teammate's notes, not facts; the project's decisions above win.\n` + picked.map(item => `- [worker note by ${agent.name}, ${item.at.slice(0, 10)}, unverified] ${item.text}${covered(item) ? ' (a project decision may cover this; check it, and the decision wins if they differ)' : ''}`).join('\n'),
      rejections: [...(rejections.length > 6 ? [`Showing the latest 6 of ${rejections.length} project objections; earlier entries remain preserved. Consult the task and critique records for unresolved obligations.`] : []), ...rejections.slice(-6).reverse().map(item => `[${item.at}] ${item.text}`)]
    }
  }
  private append(agentId: string, kind: Entry['kind'], values: string[]): string[] {
    executionIdentity.parse(agentId)
    if (!Array.isArray(values) || values.length > 100) throw Error('Too many worker memory entries.')
    const entries = this.read(), added: string[] = [], at = new Date().toISOString()
    for (const raw of values) {
      const text = raw.length > 2000 ? raw.slice(0, 1999) + '…' : raw
      const candidate = entry.parse({ agentId, kind, at, text })
      requireReviewedText(candidate.text)
      if (entries.some(item => item.agentId === agentId && item.kind === kind && item.text === text)) continue
      entries.push(candidate); added.push(text)
    }
    if (!added.length) return []
    let data = { version: 1, projectId: this.projectId, entries }
    if (entries.length > 1000 || Buffer.byteLength(JSON.stringify(data, null, 2)) > LIMIT) {
      const kept: Entry[] = [], archived: Entry[] = []
      const seen = new Map<string, number>()
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const item = entries[i]!, n = (seen.get(item.agentId) ?? 0) + 1
        seen.set(item.agentId, n)
        if (n <= KEEP_PER_AGENT) kept.unshift(item); else archived.unshift(item)
      }
      const archive = resolveInside(this.stateDir, ARCHIVE)
      if (!archive) throw Error('Project worker memory is full and its archive path is not inside the project state.')
      appendFileSync(archive, archived.map(item => JSON.stringify(item)).join('\n') + (archived.length ? '\n' : ''), 'utf8')
      data = { version: 1, projectId: this.projectId, entries: kept }
      if (kept.length > 1000 || Buffer.byteLength(JSON.stringify(data, null, 2)) > LIMIT) throw Error('Project worker memory is full. Review its archive before adding reminders; nothing was discarded.')
    }
    writeJson(this.file(), data)
    return added
  }
  addNotes(agentId: string, notes: string[]): void { this.append(agentId, 'note', notes) }
  addRejections(agentId: string, objections: string[], taskId?: string): string[] {
    const added = this.append(agentId, 'rejection', objections.filter(o => !/^\s*note\s*:/i.test(o)))
    if (taskId && added.length) {
      const file = resolveInside(this.stateDir, LINKS)
      if (file) {
        const links = this.links(), stored = this.read().filter(item => item.agentId === agentId && item.kind === 'rejection' && added.includes(item.text))
        for (const item of stored) links[linkKey(item)] = taskId
        writeJson(file, { version: 1, links })
      }
    }
    return added
  }
}
