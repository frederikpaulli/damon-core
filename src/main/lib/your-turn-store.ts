// The owner's list (Your turn). Cards are deduplicated, merged when they are about the same
// job, and closed only as done, not needed or replaced.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { evidenceFile } from '../../shared/file-lanes'
import { naturalWords } from '../../shared/natural-words'
import { connectCard } from '../../shared/connection-requests'
import { canCloseNotNeeded, isOwnCheckFailure, newerCardFor, signInSiteFor } from '../../shared/your-turn'
import { readJson, writeJson } from './json-file'
import { matchesScope } from '../../shared/scope'
import { openItems, titleWithoutDay, privatePageWhat, safeUrl, sameItem, type YourTurnDoor, type YourTurnItem, type YourTurnKind, YOUR_TURN_KINDS } from '../../shared/your-turn'

const FILE = 'your-turn.json'
const DOORS: readonly YourTurnDoor[] = ['accounts', 'connections', 'chat']
const MAX_TITLE = 120
const MAX_WHAT = 4000
const STALE_SEND_MS = 20 * 60 * 1000
const SPLIT = String.fromCharCode(10, 10)

export interface HandedOver {
  key?: string
  knownFault?: YourTurnItem['knownFault']
  projectCheck?: YourTurnItem['projectCheck']
  projectChecks?: YourTurnItem['projectChecks']
  pastCap?: YourTurnItem['pastCap']
  reviewStuck?: YourTurnItem['reviewStuck']
  findingClasses?: YourTurnItem['findingClasses']
  critiqueDecision?: YourTurnItem['critiqueDecision']
  title: string
  what: string
  kind?: string
  file?: string
  url?: string
  text?: string
  by: string
  taskId?: string
  sendBack?: string
  files?: string[]
  opens?: YourTurnItem['opens']
  standard?: YourTurnItem['standard']
  to?: YourTurnItem['to']
}

export class YourTurnStore {
  requestConnection(request: import('../../shared/connection-requests').ConnectionRequest, presets?: import('../../shared/connectors').ConnectorPreset[]): YourTurnItem {
    const { title, what } = connectCard(request, presets)
    const items = this.list()
    const connect = { requestId: request.id, provider: request.provider, ...(request.presetKey ? { presetKey: request.presetKey } : {}) }
    const same = items.find((i) => !i.doneAt && i.connect?.requestId === request.id)
    if (same) {
      Object.assign(same, { title, what, connect, at: this.now() })
      writeJson(this.file, items)
      return same
    }
    const item: YourTurnItem = { id: 'connect:' + request.id, kind: 'connect', title, what, by: 'Damon', at: this.now(), connect }
    items.push(item)
    writeJson(this.file, items)
    return item
  }

  askPrivatePage(input: { askId: string; site: string; url: string; job: string }): YourTurnItem {
    const items = this.list()
    const id = `private-page:${input.askId}`
    const title = `A teammate wants to open ${input.site} for ${input.job}`.slice(0, MAX_TITLE)
    const what = privatePageWhat(input.site, input.job, input.url)
    const same = items.find((i) => i.id === id)
    if (same) {
      Object.assign(same, { title, what, at: this.now() })
      writeJson(this.file, items)
      return same
    }
    const item: YourTurnItem = { id, kind: 'decide', title, what, url: safeUrl(input.url), by: 'Damon', at: this.now(), privatePage: { askId: input.askId, site: input.site } }
    items.push(item)
    writeJson(this.file, items)
    return item
  }
  answerPastCap(id: string, allow: boolean): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt && i.pastCap)
    if (!hit?.pastCap) return null
    hit.pastCap = { ...hit.pastCap, answer: allow ? 'yes' : 'no' }
    hit.doneAt = this.now()
    hit.answeredBy = 'owner'
    writeJson(this.file, items)
    return hit
  }
  answerReviewStuck(id: string, answer: 'keep' | 'back' | 'again'): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt && i.reviewStuck)
    if (!hit?.reviewStuck) return null
    hit.reviewStuck = { ...hit.reviewStuck, answer }
    hit.doneAt = this.now()
    hit.answeredBy = 'owner'
    writeJson(this.file, items)
    return hit
  }
  closePrivatePage(askId: string, by: 'owner' | 'code'): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.privatePage?.askId === askId && !i.doneAt)
    if (!hit) return null
    hit.doneAt = this.now()
    hit.answeredBy = by
    writeJson(this.file, items)
    return hit
  }

  connected(requestIds: string[]): YourTurnItem[] {
    const items = this.list()
    const hits = items.filter((i) => !i.doneAt && i.connect && requestIds.includes(i.connect.requestId))
    if (hits.length === 0) return []
    for (const hit of hits) hit.doneAt = this.now()
    writeJson(this.file, items)
    return hits
  }

  syncNeeds(cards: import('../../shared/work-needs').NeedCard[]): void {
    const items = this.list().filter(i => !i.need)
    const needItems: YourTurnItem[] = []
    for (const card of cards) {
      const id = `need:${card.id}`
      const site = signInSiteFor(`${card.title} ${card.why}`)
      if (site) {
        const first = items.find((i) => i.need && i.kind === 'login' && i.url === site && !i.doneAt)
        if (first) { first.also = [...(first.also ?? []), card]; continue }
      }
      const host = site ? new URL(site).host.replace(/^www\./, '') : ''
      const item: YourTurnItem = {
        id, need: card,
        title: site ? `Sign in to ${host} in the team's browser` : card.title,
        what: site ? `Damon needs the team's browser signed in to ${host} for "${card.deliverable}". Press "Open the team's browser here", sign in on the page that opens, come back and press Done. Damon checks the page itself before it continues.${SPLIT}The team asked: ${card.why}` : card.why,
        kind: site ? 'login' : 'decide', ...(site ? { url: site } : {}), by: 'Damon', at: this.now()
      }
      const asked = site ? undefined : needItems.find((n) => sameQuestion(item, n))
      if (asked) { asked.also = [...(asked.also ?? []), card]; continue }
      items.push(item)
      if (!site) needItems.push(item)
    }
    for (const need of needItems) {
      for (const plain of items) {
        if (!plain.doneAt && isPlainQuestion(plain) && sameQuestion(plain, need)) {
          plain.doneAt = this.now()
          plain.foldedInto = need.id
        }
      }
      const folded = items.filter((i) => i.foldedInto === need.id)
      if (folded.length) need.what = [need.what, ...folded.map((f) => `Asked earlier as "${f.title}": ${f.what}`)].join('\n\n').slice(0, MAX_WHAT)
    }
    writeJson(this.file, items)
  }
  private readonly file: string

  constructor(stateDir: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.file = join(stateDir, FILE)
  }

  list(): YourTurnItem[] {
    const raw = readJson<unknown>(this.file, [])
    const items = Array.isArray(raw) ? (raw as YourTurnItem[]).filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string') : []
    const now = Date.parse(this.now())
    for (const i of items) {
      if (i.sendingAt && now - Date.parse(i.sendingAt) > STALE_SEND_MS) {
        delete i.sendingAt
        i.sendFailed = 'Damon lost track of this send. Check the thread before sending again.'
      }
    }
    return items
  }

  edit(id: string, text: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit) return null
    const words = naturalWords(text).slice(0, 4000)
    if (!words) return null
    if (hit.original === undefined) hit.original = hit.text ?? ''
    hit.text = words
    hit.editedAt = this.now()
    delete hit.sendFailed
    writeJson(this.file, items)
    return hit
  }

  sending(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit || hit.sendingAt) return null
    hit.sendingAt = this.now()
    delete hit.sendFailed
    writeJson(this.file, items)
    return hit
  }

  sendFailed(id: string, reason: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    delete hit.sendingAt
    delete hit.waitingOn
    hit.sendFailed = reason.trim().slice(0, MAX_WHAT)
    writeJson(this.file, items)
    return hit
  }

  applying(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit || hit.fillingAt) return null
    hit.fillingAt = this.now()
    delete hit.fillFailed
    delete hit.press
    writeJson(this.file, items)
    return hit
  }

  fillFailed(id: string, reason: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    delete hit.fillingAt
    delete hit.waitingOn
    hit.fillFailed = reason.trim().slice(0, MAX_WHAT)
    delete hit.fillChecks
    delete hit.readyToSubmit
    delete hit.fillShots
    writeJson(this.file, items)
    return hit
  }

  waiting(id: string, reason: string | null, ready?: { contentAt?: string; workStartedAt?: string }): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit) return null
    const next = reason?.trim().slice(0, MAX_WHAT) || undefined
    const outward = hit.kind === 'submit' || hit.kind === 'send'
    const firstReady = outward && !next && !hit.readyAt && ready !== undefined
    const reheld = outward && !!next && !!hit.readyAt && !hit.reheldAt
    if ((hit.waitingOn ?? undefined) === next && !firstReady && !reheld) return null
    if (firstReady) {
      hit.readyAt = new Date().toISOString()
      if (ready!.contentAt) hit.contentAt = ready!.contentAt
      if (ready!.workStartedAt) hit.workStartedAt = ready!.workStartedAt
    }
    if (reheld) hit.reheldAt = new Date().toISOString()
    if (next) {
      hit.waitingOn = next
      delete hit.fillFailed
      delete hit.sendFailed
    } else delete hit.waitingOn
    writeJson(this.file, items)
    return hit
  }

  reopenedBy(writes: string[]): boolean {
    if (!writes.length) return false
    const items = this.list()
    let hit = false
    for (const i of items) {
      if (i.doneAt || !i.readyAt || (i.kind !== 'submit' && i.kind !== 'send')) continue
      const files = [...(i.files ?? []), ...(i.file ? [i.file] : [])].map((f) => f.replace(/\\/g, '/'))
      if (files.some((f) => matchesScope(writes, f))) { i.reopened = (i.reopened ?? 0) + 1; hit = true }
    }
    if (hit) writeJson(this.file, items)
    return hit
  }

  checkCleared(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    const apply = isOwnCheckFailure(hit.fillFailed), send = isOwnCheckFailure(hit.sendFailed)
    if (!apply && !send) return null
    if (apply) delete hit.fillFailed
    if (send) delete hit.sendFailed
    writeJson(this.file, items)
    return hit
  }

  clearFailure(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    delete hit.fillFailed
    delete hit.sendFailed
    writeJson(this.file, items)
    return hit
  }

  notes(id: string, notes: string[]): boolean {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit) return false
    const next = [...new Set(notes.map((n) => n.trim().slice(0, 400)).filter(Boolean))].slice(0, 8)
    if (JSON.stringify(hit.notes ?? []) === JSON.stringify(next)) return false
    if (next.length) hit.notes = next
    else delete hit.notes
    writeJson(this.file, items)
    return true
  }

  press(id: string, press: YourTurnItem['press'] | null): boolean {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return false
    if (JSON.stringify(hit.press ?? null) === JSON.stringify(press ?? null)) return false
    if (press) hit.press = press
    else delete hit.press
    writeJson(this.file, items)
    return true
  }

  filled(id: string, shot: string, left: string, verified?: { checks: NonNullable<YourTurnItem['fillChecks']>; ready: boolean; shots: string[] }): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    delete hit.fillingAt
    delete hit.fillFailed
    hit.filledAt = this.now()
    hit.leftToFill = left.trim().slice(0, MAX_WHAT)
    if (shot) hit.shot = shot
    delete hit.fillChecks
    delete hit.readyToSubmit
    delete hit.fillShots
    if (verified) {
      hit.fillChecks = verified.checks.slice(0, 80).map(c => ({ what: c.what.slice(0, 200), ok: c.ok, ...(c.why ? { why: c.why.slice(0, 300) } : {}), ...(c.shows ? { shows: c.shows.slice(0, 200) } : {}), ...(c.upload ? { upload: true } : {}), ...(c.section ? { section: c.section.slice(0, 80) } : {}) }))
      hit.readyToSubmit = verified.ready
      if (verified.shots.length) hit.fillShots = verified.shots.slice(0, 8)
    }
    writeJson(this.file, items)
    return hit
  }

  unfilled(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit || !hit.filledAt) return null
    delete hit.filledAt
    delete hit.leftToFill
    delete hit.fillChecks
    delete hit.readyToSubmit
    delete hit.fillShots
    delete hit.shot
    writeJson(this.file, items)
    return hit
  }

  notYet(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit) return null
    delete hit.filledAt
    delete hit.fillingAt
    delete hit.leftToFill
    delete hit.fillChecks
    delete hit.readyToSubmit
    delete hit.fillShots
    delete hit.shot
    writeJson(this.file, items)
    return hit
  }

  sent(id: string, shot: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    delete hit.sendingAt
    delete hit.sendFailed
    hit.sentAt = this.now()
    hit.doneAt = hit.sentAt
    if (shot) hit.shot = shot
    writeJson(this.file, items)
    return hit
  }

  retitle(id: string, title: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    const next = title.trim().slice(0, MAX_TITLE)
    if (!hit || !next || hit.title === next) return null
    hit.title = next
    writeJson(this.file, items)
    return hit
  }
  attachFiles(id: string, files: string[]): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    const clean = [...new Set(files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean))].slice(0, 12)
    if (!hit || !clean.length || hit.file || hit.files?.length) return null
    if (clean.length === 1) hit.file = clean[0]
    else hit.files = clean
    writeJson(this.file, items)
    return hit
  }
  addFiles(id: string, files: string[]): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit) return null
    const have = [...(hit.files ?? (hit.file ? [hit.file] : []))]
    const fresh = [...new Set(files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean))].filter((f) => !have.some((h) => h.toLowerCase() === f.toLowerCase()))
    if (!fresh.length) return null
    hit.files = [...have, ...fresh].slice(0, 12)
    writeJson(this.file, items)
    return hit
  }
  annotate(id: string, note: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    const original = hit.annotated ? hit.what.slice(hit.what.indexOf(SPLIT) + SPLIT.length) : hit.what
    hit.what = [note, original].join(SPLIT).slice(0, MAX_WHAT)
    hit.annotated = true
    writeJson(this.file, items)
    return hit
  }

  open(): YourTurnItem[] {
    return openItems(this.list())
  }

  add(h: HandedOver): { item: YourTurnItem; added: boolean; answeredAt?: string } {
    const items = this.list()
    const key = h.key?.trim().slice(0, 300) || undefined
    if (key) {
      const answered = items.find((i) => i.key === key && i.doneAt && !i.closedAs && (i.answeredBy === 'owner' || i.answeredBy === 'damon'))
      if (answered) return { item: answered, added: false, answeredAt: answered.doneAt }
    }
    const kind: YourTurnKind = YOUR_TURN_KINDS.includes(h.kind as YourTurnKind) ? (h.kind as YourTurnKind) : 'other'
    const clean = {
      key,
      knownFault: h.knownFault?.taskId ? { taskId: h.knownFault.taskId } : undefined,
      projectCheck: h.projectCheck && /^[a-z0-9][a-z0-9-]{0,39}$/.test(h.projectCheck.name) ? { name: h.projectCheck.name, command: h.projectCheck.command.slice(0, 300) } : undefined,
      projectChecks: h.projectChecks?.length ? h.projectChecks.filter((c) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(c.name)).map((c) => ({ name: c.name, command: c.command.slice(0, 300) })).slice(0, 6) : undefined,
      pastCap: h.pastCap?.root ? { root: h.pastCap.root.slice(0, 80), step: Math.max(1, Math.floor(h.pastCap.step) || 1) } : undefined,
      reviewStuck: h.reviewStuck?.taskId ? { taskId: h.reviewStuck.taskId.slice(0, 80), ...(h.reviewStuck.candidateId && h.reviewStuck.fingerprint ? { candidateId: h.reviewStuck.candidateId.slice(0, 80), fingerprint: h.reviewStuck.fingerprint.slice(0, 128) } : {}) } : undefined,
      critiqueDecision: h.critiqueDecision,
      findingClasses: h.findingClasses?.length ? h.findingClasses.filter((k) => k === 'evidence' || k === 'wording' || k === 'plumbing' || k === 'work').slice(0, 60) : undefined,
      title: (kind === 'submit' || kind === 'send' ? titleWithoutDay(h.title) : h.title).trim().slice(0, MAX_TITLE),
      what: h.what.trim().slice(0, MAX_WHAT),
      kind,
      file: h.file?.trim().replace(/\\/g, '/') || undefined,
      url: safeUrl(h.url),
      text: naturalWords(h.text ?? '').slice(0, 4000) || undefined,
      by: h.by.trim() || 'Damon',
      taskId: h.taskId,
      sendBack: h.sendBack?.trim().slice(0, MAX_WHAT) || undefined,
      files: h.files && h.files.length > 0 ? h.files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean).slice(0, 12) : undefined,
      opens: DOORS.includes(h.opens as YourTurnDoor) ? h.opens : undefined,
      standard: h.standard?.text.trim()
        ? { text: h.standard.text.trim().slice(0, MAX_WHAT), why: h.standard.why?.trim().slice(0, MAX_WHAT) || undefined }
        : undefined,
      to: h.to?.name.trim() ? { name: h.to.name.trim().slice(0, 120), contact: h.to.contact?.trim().slice(0, 400) || undefined } : undefined
    }
    const packageOf = (files?: string[]): string | null => { const f = (files ?? []).find((p) => /^outgoing\//.test(p)); return f ? f.split('/').slice(0, -1).join('/') : null }
    const folder = clean.kind === 'submit' ? packageOf(clean.files) : null
    const sameAction = clean.kind === 'submit'
      ? (folder ? items.find((i) => !i.doneAt && i.kind === 'submit' && packageOf(i.files) === folder) : undefined)
      : undefined
    const sameJob = (clean.taskId ? items.find((i) => !i.doneAt && i.taskId === clean.taskId) : undefined) ?? sameAction
    if (sameJob && !sameItem(sameJob, clean)) {
      const decide = clean.kind === 'decide' ? clean : sameJob.kind === 'decide' ? sameJob : null
      const file = clean.file && !evidenceFile(clean.file) ? clean.file : (sameJob.file ?? clean.file)
      Object.assign(sameJob, {
        title: decide ? decide.title : clean.title,
        what: decide ? decide.what : clean.what,
        kind: decide ? 'decide' : clean.kind,
        file,
        files: clean.files?.length ? clean.files : sameJob.files,
        url: clean.url ?? sameJob.url,
        text: clean.text ?? sameJob.text,
        sendBack: decide ? decide.sendBack : undefined,
        findingClasses: decide ? decide.findingClasses : undefined,
        opens: clean.opens ?? sameJob.opens,
        standard: clean.standard ?? sameJob.standard,
        to: clean.to ?? sameJob.to,
        at: this.now()
      })
      writeJson(this.file, items)
      return { item: sameJob, added: false }
    }
    const existing = items.find((i) => !i.doneAt && sameItem(i, clean))
    if (existing) {
      Object.assign(existing, {
        what: clean.what,
        kind: clean.kind,
        by: clean.by,
        url: clean.url ?? existing.url,
        text: clean.text ?? existing.text,
        file: clean.file ?? existing.file,
        files: clean.files ?? existing.files,
        sendBack: clean.sendBack,
        findingClasses: clean.findingClasses ?? existing.findingClasses,
        opens: clean.opens ?? existing.opens,
        standard: clean.standard ?? existing.standard,
        to: clean.to ?? existing.to,
        at: this.now()
      })
      writeJson(this.file, items)
      return { item: existing, added: false }
    }
    const raised = this.now()
    const item: YourTurnItem = { id: randomUUID(), ...clean, at: raised, raisedAt: raised }
    const gated = isPlainQuestion(item) ? items.find((i) => !i.doneAt && i.need && i.kind === 'decide' && sameQuestion(item, i)) : undefined
    if (gated) {
      items.push({ ...item, doneAt: item.at, foldedInto: gated.id })
      writeJson(this.file, items)
      return { item: gated, added: false }
    }
    items.push(item)
    writeJson(this.file, items)
    return { item, added: true }
  }

  caution(taskId: string, text: string, sendBack: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => !i.doneAt && i.taskId === taskId && i.kind !== 'check')
    if (!hit) return null
    hit.caution = text.trim().slice(0, MAX_WHAT)
    hit.sendBack = sendBack.trim().slice(0, MAX_WHAT)
    writeJson(this.file, items)
    return hit
  }

  cautionCard(id: string, text: string): YourTurnItem | null {
    const items = this.list()
    const prefixed = /^[0-9a-f]{8}$/i.test(id) ? items.filter((i) => !i.doneAt && i.id.toLowerCase().startsWith(id.toLowerCase())) : []
    const hit = items.find((i) => i.id === id && !i.doneAt) ?? (prefixed.length === 1 ? prefixed[0] : undefined)
    if (!hit) return null
    const line = text.trim()
    if (!line) return hit
    const have = (hit.caution ?? '').split('\n').map((s) => s.trim())
    if (have.includes(line)) return hit
    hit.caution = [...have.filter(Boolean), line].join('\n').slice(0, MAX_WHAT)
    writeJson(this.file, items)
    return hit
  }

  markPushed(id: string): void {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit || hit.pushedAt) return
    hit.pushedAt = this.now()
    writeJson(this.file, items)
  }

  readyPushed(id: string, checkId: string): boolean {
    const items = this.list()
    const hit = items.find((i) => i.id === id && !i.doneAt)
    if (!hit || hit.readyPushedFor === checkId) return false
    hit.readyPushedFor = checkId
    writeJson(this.file, items)
    return true
  }

  notNeeded(id: string, by: 'owner' | 'damon', why?: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit || !canCloseNotNeeded(hit)) return null
    hit.doneAt = this.now()
    hit.answeredBy = by
    hit.closedAs = 'not-needed'
    if (why?.trim()) hit.caution = [hit.caution, `Closed as no longer needed: ${why.trim().slice(0, 300)}`].filter(Boolean).join('\n').slice(0, MAX_WHAT)
    writeJson(this.file, items)
    return hit
  }

  replaced(id: string, by: 'owner' | 'damon'): { item: YourTurnItem; newer: YourTurnItem } | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    const newer = newerCardFor(hit, items)
    if (!newer) return null
    hit.doneAt = this.now()
    void by
    hit.answeredBy = 'code'
    hit.closedAs = 'replaced'
    hit.replacedBy = newer.id
    delete hit.waitingOn
    hit.caution = [hit.caution, `Replaced by "${newer.title.slice(0, 120)}". Not sent.`].filter(Boolean).join('\n').slice(0, MAX_WHAT)
    writeJson(this.file, items)
    return { item: hit, newer }
  }

  reopenReplaced(id: string): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit || hit.closedAs !== 'replaced' || !hit.doneAt) return null
    delete hit.doneAt
    delete hit.answeredBy
    delete hit.closedAs
    delete hit.replacedBy
    const kept = (hit.caution ?? '').split('\n').filter((l) => !/^Replaced by ".*". Not sent.$/.test(l)).join('\n')
    if (kept) hit.caution = kept
    else delete hit.caution
    writeJson(this.file, items)
    return hit
  }

  done(id: string, by: 'owner' | 'damon' | 'code' = 'code'): YourTurnItem | null {
    const items = this.list()
    const hit = items.find((i) => i.id === id)
    if (!hit) return null
    if (hit.need) return null
    if (!hit.doneAt) {
      hit.doneAt = this.now()
      hit.answeredBy = by
      writeJson(this.file, items)
    }
    return hit
  }

}

function isPlainQuestion(i: YourTurnItem): boolean {
  return i.kind === 'decide' && !i.need && !i.file && !i.files?.length && !i.url && !i.text && !i.sendBack &&
    !i.standard && !i.to && !i.connect && !i.critiqueDecision && !i.privatePage && !i.pastCap
}
const QUESTION_STOP = new Set(['that', 'this', 'with', 'from', 'your', 'have', 'will', 'they', 'them', 'then', 'than', 'when', 'what', 'which', 'would', 'there', 'their', 'about', 'into', 'only', 'also', 'just', 'before', 'after', 'does', 'rather', 'should', 'could', 'were', 'been', 'being', 'each', 'other', 'more', 'most', 'very', 'such', 'here', 'some', 'damon', 'owner', 'answer', 'question', 'recommended', 'recommendation'])
function questionWords(s: string): Set<string> {
  const words = s.toLowerCase().replace(/'s\b/g, '').match(/[a-z0-9æøå]{4,}/g) ?? []
  return new Set(words.filter((w) => !QUESTION_STOP.has(w)).map((w) => w.replace(/s$/, '')))
}
function overlap(A: Set<string>, B: Set<string>): number {
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.max(1, Math.min(A.size, B.size))
}
const questionOf = (i: YourTurnItem): string => i.need?.title ?? i.title
const contextOf = (i: YourTurnItem): string => i.need?.why ?? i.what
function sameQuestion(a: YourTurnItem, b: YourTurnItem): boolean {
  const qa = questionWords(questionOf(a)), qb = questionWords(questionOf(b))
  if (qa.size >= 3 && qb.size >= 3 && overlap(qa, qb) >= 0.6) return true
  const ca = contextOf(a), cb = contextOf(b)
  if (ca.length > 1200 || cb.length > 1200) return false
  const A = questionWords(`${questionOf(a)} ${ca}`), B = questionWords(`${questionOf(b)} ${cb}`)
  return A.size >= 6 && B.size >= 6 && overlap(A, B) >= 0.4
}
