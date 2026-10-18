// Types and wording for Your turn cards: what each kind means, which buttons it shows,
// and the lead sentence that tells the owner what pressing does.
import { plainForOwner, PLAIN_FALLBACK_NOTICE } from './owner-plain'
export { plainForOwner, PLAIN_FALLBACK_NOTICE }
import { isForOwner } from './escalation'
import { isOwnerConfirmation } from './critic-reach'
import type { TaskInfo } from './types'

export type YourTurnKind = 'send' | 'login' | 'decide' | 'check' | 'pay' | 'sign' | 'submit' | 'connect' | 'other'

export interface YourTurnItem {
  key?: string
  answeredBy?: 'owner' | 'damon' | 'code'
  closedAs?: 'not-needed' | 'replaced'
  replacedBy?: string
  raisedAt?: string
  pushedAt?: string
  readyPushedFor?: string
  readyAt?: string
  contentAt?: string
  workStartedAt?: string
  reheldAt?: string
  reopened?: number
  knownFault?: { taskId: string }
  projectCheck?: { name: string; command: string }
  projectChecks?: { name: string; command: string }[]
  privatePage?: { askId: string; site: string }
  pastCap?: { root: string; step: number; answer?: 'yes' | 'no' }
  reviewStuck?: { taskId: string; candidateId?: string; fingerprint?: string; answer?: 'keep' | 'back' | 'again' }
  findingClasses?: import('./process-objection').FindingClass[]
  connect?: { requestId: string; provider: string; presetKey?: string }
  opens?: YourTurnDoor
  standard?: { text: string; why?: string }
  to?: { name: string; contact?: string }
  critiqueDecision?: { id: string; challenge: string }
  need?: import('./work-needs').NeedCard
  foldedInto?: string
  annotated?: boolean
  also?: import('./work-needs').NeedCard[]
  id: string
  title: string
  what: string
  kind: YourTurnKind
  file?: string
  url?: string
  text?: string
  caution?: string
  by: string
  taskId?: string
  sendBack?: string
  original?: string
  editedAt?: string
  sendingAt?: string
  sendFailed?: string
  sentAt?: string
  shot?: string
  files?: string[]
  fillingAt?: string
  fillFailed?: string
  filledAt?: string
  leftToFill?: string
  fillChecks?: { what: string; ok: boolean; why?: string; shows?: string; upload?: boolean; section?: string }[]
  readyToSubmit?: boolean
  fillShots?: string[]
  waitingOn?: string
  notes?: string[]
  press?: { at: string; state: 'waiting' | 'lapsed'; why?: string }
  at: string
  doneAt?: string
}

export function canSendBack(item: Pick<YourTurnItem, 'standard' | 'doneAt' | 'kind' | 'sendBack'>): boolean {
  return !item.standard && !item.doneAt && item.kind !== 'login' && !(item.kind === 'check' && !item.sendBack)
}

export const NOT_CHECKED_YET = (id: string): string => `Workflow critique is outstanding (${id}).`
export function readyGate(i: { block: string | null; outward: boolean; passedId?: string; outstandingId?: string }): string | null {
  if (i.block || !i.outward || i.passedId) return i.block
  return NOT_CHECKED_YET(i.outstandingId ?? 'package')
}
export function becameReady(before: { waitingOn?: string; readyAt?: string }, after: { waitingOn?: string }): boolean {
  return !after.waitingOn && !!before.waitingOn
}
export function readyCheckFor<L extends { id: string; scope: string; files: string[]; reports: unknown[] }>(
  live: L[],
  card: { files: string[]; sent?: string[] },
  clear: (lane: L) => boolean
): { passedId?: string; outstandingId?: string } | null {
  const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
  const files = card.files.map(norm)
  const sent = (card.sent ?? card.files).map(norm)
  const covers = (x: L, list: string[]): boolean => list.length > 0 && list.every(f => x.files.some(g => norm(g) === f))
  const lane = live.find(x => x.scope.startsWith('owner-action:') && covers(x, files))
  if (!lane) return null
  return lane.reports.length > 0 && clear(lane) ? { passedId: lane.id } : { outstandingId: lane.id }
}
export function critiquesNamedBy(
  blocked: string,
  pending: Array<{ id: string; blocker: string | null; ran?: number }>
): { id: string; ran: number; blocker: string }[] {
  const said = (blocked ?? '').trim()
  if (!said) return []
  const found = pending.filter((p) => p.blocker && said.includes(p.blocker))
  if (!found.length) return []
  let rest = said.replace('Not ready for this action.', '')
  for (const p of found) rest = rest.replace(p.blocker!, '')
  if (rest.replace(/[;\s.]/g, '')) return []
  return found.map((p) => ({ id: p.id, ran: p.ran ?? 0, blocker: p.blocker! }))
}
export function critiqueNamedBy(
  blocked: string,
  pending: Array<{ id: string; blocker: string | null; ran?: number }>
): { id: string; ran: number } | null {
  const all = critiquesNamedBy(blocked, pending)
  return all.length ? { id: all[0]!.id, ran: all[0]!.ran } : null
}

export const CRITIQUE_RUN_CAP = 6
export function critiqueDamonCanRun(
  blocked: string,
  pending: Array<{ id: string; blocker: string | null; ran?: number; moved?: boolean; held?: boolean }>
): string | null {
  const named = critiqueNamedBy(blocked, pending)
  if (!named) return null
  if (named.ran === 0) return named.id
  if (pending.find(p => p.id === named.id)?.held) return named.id
  if (pending.find(p => p.id === named.id)?.moved && (named.ran ?? 0) < CRITIQUE_RUN_CAP) return named.id
  const entry = pending.find(p => p.id === named.id)
  return named.ran < 2 && /Workflow critique is incomplete/.test(entry?.blocker ?? '') ? named.id : null
}

function plainCheckWords(blocker: string): string {
  const said = (blocker ?? '').trim()
  if (!said) return ''
  const body = said
    .replace(
      /^(Workflow critique is (?:outstanding|incomplete)|The critic completed its checks and found unresolved failures|Workflow defects remain|Previous finding still needs an explicit recheck|Owner decision required)[^.:]*[.:]\s*/i,
      ''
    )
    .replace(/(^|;\s*)(outcome|handoff|recovery|finding-[0-9a-f]+)(:\s*(?:blocked|fail|pass))?:\s*/gi, '$1')
    .replace(/\s*;\s*/g, '. ')
    .replace(/workflow critique/gi, 'this check')
    .replace(/review_deliverable|recorded deliverable/gi, 'a recorded piece of work')
    .trim()
  const capped = body.length > 600 ? body.slice(0, 600).replace(/\s+\S*$/, '') + '…' : body
  return capped || said
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
function clockSeconds(at: Date): string {
  return `${clock(at)}:${String(at.getSeconds()).padStart(2, '0')}`
}

export function isUsageLimit(why: string): boolean {
  return /usage limit|rate limit|quota/i.test(why ?? '')
}

export function checkUsageLimited(resetsAt?: string | Date, at: Date = new Date(), tries = 1): string {
  const reset = resetsAt === undefined ? null : (resetsAt instanceof Date ? resetsAt : new Date(resetsAt))
  const usable = reset && !Number.isNaN(reset.getTime()) && reset.getTime() > at.getTime()
  const when = usable ? ` It can run again after your limit resets, around ${clock(reset!)}.` : ''
  const before = usable ? ' before then' : ' yet'
  const often = tries > 1 ? `Tried ${tries} times, last at ${clockSeconds(at)}.` : `Checked at ${clockSeconds(at)}.`
  return (
    'Damon could not run its own final check because your Claude usage limit is reached. This is your account, ' +
    'not this package: nothing is wrong with the work itself.' +
    when +
    ' Pressing again' +
    before +
    ' starts nothing. Nothing has been sent, and nothing is lost. ' +
    often
  )
}

export function checkedBeforeDecisions(at: string): string {
  const d = new Date(at)
  const when = Number.isFinite(d.getTime()) ? `${d.getDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()]} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'an earlier time'
  return `Damon's last check of this package was on ${when}, and your decisions have changed since. If a change bears on what this package says, Damon checks it again before you send.`
}

const CHECK_NOT_CLEAR_OPENING = 'Damon has run its own final check on this package and it did not come back clear'
const CHECK_UNFINISHED_OPENING = 'Damon tried to run its own final check on this package and could not finish it'
export function isOwnCheckFailure(text: string | undefined): boolean {
  const said = (text ?? '').trim()
  return said.startsWith(CHECK_NOT_CLEAR_OPENING) || said.startsWith(CHECK_UNFINISHED_OPENING)
}
export function isCheckNotClear(text: string | undefined): boolean {
  return (text ?? '').trim().startsWith(CHECK_NOT_CLEAR_OPENING)
}

export function checkAnswered(blocker: string, what: 'Send' | 'Submit' = 'Submit'): string {
  return (
    CHECK_NOT_CLEAR_OPENING + ', so Damon will not act in ' +
    'your name yet. What it could not settle: ' +
    plainCheckWords(blocker) +
    ' Damon has been told what it found. Another press cannot change this: the work has to be put right first. ' +
    (what === 'Send' ? 'You can still open the thread and send it yourself.' : 'You can still open the page and submit it by hand.') +
    ' Nothing has been sent, and nothing is lost.'
  )
}

export function checkCouldNotRun(why: string, what: 'Send' | 'Submit', at: Date = new Date(), auto = false): string {
  if (isUsageLimit(why)) return checkUsageLimited(undefined, at)
  const reason = why.split(/\n\s*Partial report:/i)[0]!.replace(/^(The (?:check|reviewer) could not be run:\s*)+/i, '')
  return (
    CHECK_UNFINISHED_OPENING + ': ' +
    plainCheckWords(reason) +
    (auto
      ? ' Nothing has been sent, and nothing is lost. Damon tries the check again by itself in a few minutes.'
      : ` Nothing has been sent, and nothing is lost. Press ${what === 'Send' ? 'Send' : 'Fill it in'} to give the check another go.`) +
    ` Last tried at ${clockSeconds(at)}.`
  )
}

export function sealWaiting(why: string): string {
  const base = (f: string): string => f.trim().replace(/\\/g, '/').split('/').pop() ?? f
  const files = (list: string): string => list.split(',').map(base).filter(Boolean).join(', ')
  const moved = /^changed since checked:\s*(.+)$/i.exec(why ?? '')
  const added = /^not covered by the check that sealed it:\s*(.+)$/i.exec(why ?? '')
  const first = moved
    ? `Damon is checking this package again: ${files(moved[1]!)} changed since its last check.`
    : added
      ? `Damon is checking this package again: ${files(added[1]!)} is new on the card and was not checked yet.`
      : /^a fact it states changed/i.test(why ?? '')
        ? 'Damon is checking this package again: a fact these files state changed in your decisions.'
        : /^its destination changed/i.test(why ?? '')
          ? 'Damon is checking this package again: the address it goes to changed.'
          : /^his profile changed/i.test(why ?? '')
            ? 'Damon is checking this package again: your profile changed since its last check.'
            : /^his profile was not part of the check/i.test(why ?? '')
              ? 'Damon is checking this package again so its check covers your profile too.'
              : /^the \S+ check could not finish|^the \S+ check did not|^Damon's check could not read/i.test(why ?? '')
                ? `Damon is checking this package before it is ready: ${why.replace(/[.\s]+$/, '')}.`
                : 'Damon is checking this package before it is ready.'
  return `${first} It is ready when Damon's own final check passes on the files as they are now. Nothing has been sent, and nothing is lost.`
}
export function gateNoteLines(block: string | null | undefined): string[] {
  const body = (block ?? '').replace(/^Not ready for this action\.\s*/, '').trim()
  if (!body) return []
  const clean = (s: string): string => s
    .replace(/\s*\(\s*[0-9a-f]{8}[0-9a-f-]*\)/gi, '')
    .replace(/(^|;\s*|\.\s+)(?:finding-[0-9a-f]+|outcome|handoff|recovery|s\d+)(?::\s*(?:blocked|fail|pass))?:\s*/gi, '$1')
    .replace(/\b(?:outgoing|attachments)\/[\w./-]*\/([\w.-]+\.(?:md|html?|pdf|txt))\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const out: string[] = []
  for (const part of body.split(/;\s+(?=[A-Z])/)) {
    const p = part.trim()
    let line: string
    const need = /^(.*?):\s*(.*?):\s*awaiting evidence\.?$/i.exec(p)
    if (need) line = `The team recorded "${need[2]}" as something "${need[1]}" needs, and has not supplied it yet.`
    else if (/^Workflow critique is (?:outstanding|incomplete)/i.test(p)) {
      const rest = clean(p.replace(/^Workflow critique is (?:outstanding|incomplete)[^.:]*[.:]?\s*/i, ''))
      line = rest ? `Another of Damon's own checks on these files has not finished: ${rest}` : "Another of Damon's own checks on these files has not finished yet."
    } else if (/^(?:The critic completed its checks and found unresolved failures|Workflow defects remain|Previous finding still needs an explicit recheck)/i.test(p)) {
      line = `Damon's check noted: ${clean(p.replace(/^[^:]*:\s*/, ''))}`
    } else if (/^Owner decision required/i.test(p)) {
      line = `A question from Damon's check: ${clean(p.replace(/^[^:]*:\s*/, ''))}`
    } else if (/^Workflow requirements are unavailable/i.test(p)) {
      line = "One of Damon's older checks on these files names a job that is no longer on record."
    } else line = clean(p)
    line = line.replace(/review_deliverable|recorded deliverable/gi, 'a recorded piece of work').replace(/workflow critique/gi, "Damon's check")
    const capped = line.length > 400 ? line.slice(0, 399).replace(/\s+\S*$/, '') + '…' : line
    if (capped && !out.includes(capped)) out.push(capped)
  }
  return out
}

export function sealRefused(why: string): string {
  const said = (why ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]*$/, '.')
  return `Damon's own final check found a fault in what leaves: ${said} Damon will not act in your name until it is put right, and the team has been told. You can still open the page and submit it by hand. Nothing has been sent, and nothing is lost.`
}
export function pressKept(pressedAt: Date): string {
  return `Damon fills the form in by itself as soon as its own final check passes on these files. You pressed Fill it in at ${clock(pressedAt)}; Damon stops before the form's Submit button, as always. Nothing has been sent, and nothing is lost.`
}
export function pressLapsed(why: 'moved' | 'late' | 'refused', pressedAt: Date): string {
  const reason = why === 'moved'
    ? 'a file changed while Damon was checking it.'
    : why === 'late'
      ? 'Damon’s check took more than an hour.'
      : 'Damon’s check did not pass, and the card says why.'
  return `Your press of Fill it in at ${clock(pressedAt)} was not carried out: ${reason} Press Fill it in again when the card is ready. Nothing has been sent, and nothing is lost.`
}

export function checkStillRunning(startedAt: string | Date, at: Date = new Date()): string {
  const began = startedAt instanceof Date ? startedAt : new Date(startedAt)
  const started = Number.isNaN(began.getTime()) ? '' : ` It started at ${clock(began)} and takes a few minutes.`
  return (
    'Damon is still running its own final check on this package.' +
    started +
    ' When it is done this card says what it found, on its own. ' +
    'Nothing has been sent, and nothing is lost. Looked again at ' +
    clockSeconds(at) +
    '.'
  )
}

export const CHECK_RUNNING =
  'Damon stopped itself: its own final check on this package has not been run yet, and it will not act in your name ' +
  'until it has. Damon has started that check now. It takes a few minutes, and this card says what it found by itself. ' +
  'Nothing has been sent, and nothing is lost.'

export const CHECK_HELD =
  'Everything on this project is on hold, so Damon has not started its own final check on this package. ' +
  'It starts by itself when you press Start. Nothing has been sent, and nothing is lost.'

const FOR_THE_MACHINE = /review_deliverable|workflow critique|recorded deliverable|Workflow requirements are unavailable/i

export function failureForOwner(reason: string): string {
  const said = (reason ?? '').trim()
  if (!said || !FOR_THE_MACHINE.test(said)) return said
  const parts = said.replace(/^Not ready for this action\.\s*/i, '').split(/;\s*/).map((p) => p.trim()).filter(Boolean)
  const lines: string[] = []
  for (const part of parts) {
    if (/Workflow critique is outstanding/i.test(part)) { lines.push("Damon's own final check on this package has not run yet; Damon runs it, not you."); continue }
    const need = /^(.*?):\s*(.*?):\s*awaiting evidence\.?$/i.exec(part)
    if (need) { lines.push(`The team recorded "${need[2]}" as something "${need[1]}" needs, and never supplied it.`); continue }
    if (/review_deliverable|recorded deliverable|Workflow requirements are unavailable/i.test(part)) { lines.push("Damon's own final check on this work has not been run yet, and only Damon can run it."); continue }
    lines.push(part.replace(/[.]$/, ''))
  }
  const unique = [...new Set(lines)]
  return `Damon stopped itself and will not act in your name yet. ${unique.map((l, i) => `${i + 1}. ${l}`).join(' ')} Nothing has been sent, and nothing is lost. Damon deals with these; press the button again when the card no longer shows this.`
}

const SENDABLE: readonly YourTurnKind[] = ['send']

export function canSend(item: YourTurnItem): boolean {
  return SENDABLE.includes(item.kind) && Boolean(item.text?.trim()) && safeUrl(item.url) !== undefined
}

export const SEND_SEAT_READY = false
export function sendHeld(protectedRoute: boolean, seatReady: boolean = SEND_SEAT_READY): boolean { return protectedRoute && !seatReady }
export const SEND_HELD_REASON = 'Damon cannot post messages for you yet. Copy the words, open the thread, paste them and send them yourself, then press Done.'
export const SEND_NOT_PERMITTED = 'Damon may not post messages for you in this project yet. Switch on "Post my messages when I press Send" on the project\'s Limits tab, then press Send again. Or copy the words and send them yourself, then press Done.'
export const SEND_HELD_LEAD = 'Read the message, then copy it into the thread and send it yourself. Done means you sent it.'

export function canFill(item: YourTurnItem): boolean {
  return item.kind === 'submit' && !item.doneAt && safeUrl(item.url) !== undefined
}

export function sendBackMessage(
  item: { title: string; by: string; sendBack?: string; taskId?: string; kind?: YourTurnKind; connect?: { provider: string } },
  note: string
): string {
  const said = note.trim()
  const reason = said ? ` What I am not satisfied with: ${said}` : ''
  const job = item.taskId ? ` Job id: ${item.taskId}.` : ''
  if (item.sendBack) return `${item.sendBack.trim()}${reason}${job}`
  if (item.kind === 'login') {
    return `I did not sign in to ${signInSiteFor(item.title) ?? item.title.trim()}. Carry on without it and say so in your report. Do not ask me to sign in again unless something changes.${job}`
  }
  if (item.kind === 'connect') {
    const what = item.connect?.provider?.trim() || item.title.trim()
    return `I do not want to set ${what} up for this project right now.${reason} Do not ask for it again unless something changes.${job}`
  }
  return `Send "${item.title.trim()}" back to ${item.by.trim() || 'the team'}. I am not satisfied with it.${reason} Have it redone before it comes back to me.${job}`
}

export function editNotice(item: { title: string; text?: string }): string {
  return `You changed the words of "${item.title.trim()}" before sending. They now read, exactly: ${(item.text ?? '').trim()}`
}

export const YOUR_TURN_KINDS: YourTurnKind[] = ['send', 'login', 'decide', 'check', 'pay', 'sign', 'submit', 'connect', 'other']

export const TEAM_QUESTIONS_TITLE = 'Answer Damon before it builds the team'

const SIGN_IN_WORDS = /\b(sign(ed)?[ -]?in|log(ged)?[ -]?in|login|logged into|session (has )?lapsed)\b/i
export function signInSiteFor(text: string): string | undefined {
  if (!SIGN_IN_WORDS.test(text ?? '')) return undefined
  return undefined
}

export function teamQuestionsCard(questions: string[]): { title: string; what: string; kind: YourTurnKind; opens: YourTurnDoor } {
  const lines = questions.map((q) => `- ${q.trim()}`).join('\n')
  return {
    title: TEAM_QUESTIONS_TITLE,
    what: `Damon needs these answered before it puts a team together:\n${lines}\nOpen the chat and answer there. Skip any you want Damon to decide itself; it will say what it assumed.`,
    kind: 'decide',
    opens: 'chat'
  }
}

export function isTeamQuestions(item: { title: string; by: string; doneAt?: string }): boolean {
  return !item.doneAt && item.by === 'Damon' && item.title === TEAM_QUESTIONS_TITLE
}

export const TRUST_TITLE = 'Let the other teammates work in this folder'
const TRUST_TITLES = [TRUST_TITLE, 'Let the other AI accounts work in this folder']

export function isTrustCard(item: { title: string }): boolean {
  return TRUST_TITLES.includes(item.title)
}

export function staleTrustCards<T extends { id: string; title: string }>(open: T[]): T[] {
  return open.filter((i) => isTrustCard(i) && i.title !== TRUST_TITLE)
}

export function kindWords(kind: YourTurnKind): string {
  switch (kind) {
    case 'send':
      return 'Send'
    case 'login':
      return 'Log in'
    case 'decide':
      return 'Decide'
    case 'check':
      return 'Check'
    case 'pay':
      return 'Pay'
    case 'sign':
      return 'Sign'
    case 'submit':
      return 'Submit'
    case 'connect':
      return 'Connect'
    default:
      return 'Do'
  }
}

export type YourTurnDoor = 'accounts' | 'connections' | 'chat'

export function consequenceOf(item: Pick<YourTurnItem, 'kind' | 'standard'>): string | null {
  switch (item.kind) {
    case 'send':
    case 'submit':
    case 'sign':
      return 'Goes out as you'
    case 'pay':
      return 'Spends money'
    case 'connect':
      return 'Gives Damon a key'
    default:
      if (item.standard) return 'Changes how work is judged'
      return null
  }
}

export function openItems(items: YourTurnItem[]): YourTurnItem[] {
  return items.filter((i) => !i.doneAt)
}

export function checkAsks(item: Pick<YourTurnItem, ErrandFields>): boolean {
  return item.kind === 'check' && Boolean(item.projectCheck || item.projectChecks?.length || item.sendBack || /^(?:locked-store|contacts-migration-skipped):/.test(item.key ?? '') || isErrand(item))
}

const NAMED_NOTICE = /^(?:locked-store|contacts-migration-skipped):/
type ErrandFields = 'kind' | 'file' | 'files' | 'key' | 'sendBack' | 'privatePage' | 'pastCap' | 'reviewStuck' | 'critiqueDecision' | 'standard' | 'knownFault' | 'projectCheck' | 'projectChecks' | 'need' | 'connect'
export function isErrand(item: Pick<YourTurnItem, ErrandFields>): boolean {
  return item.kind === 'check' && !item.file && !item.files?.length && !NAMED_NOTICE.test(item.key ?? '') &&
    !item.sendBack && !item.privatePage && !item.pastCap && !item.reviewStuck && !item.critiqueDecision && !item.standard &&
    !item.knownFault && !item.projectCheck && !item.projectChecks?.length && !item.need && !item.connect
}

export function canCloseNotNeeded(item: Pick<YourTurnItem, ErrandFields | 'doneAt'>): boolean {
  return !item.doneAt && isErrand(item)
}

export function notNeededLine(title: string, by: 'owner' | 'damon', why?: string): string {
  const what = `"${title.replace(/\s+/g, ' ').trim().slice(0, 100)}"`
  return by === 'owner'
    ? `You closed ${what} as no longer needed. Damon has not taken it as done.`
    : `I took ${what} off your list as no longer needed${why ? `: ${why.trim().slice(0, 200).replace(/[.\s]+$/, '')}` : ''}. Nothing was taken as done. If you still need it, say so in the chat.`
}
export function notNeededForManager(title: string, by: 'owner' | 'damon'): string {
  return `${by === 'owner' ? 'The owner' : 'You'} closed "${title}" as no longer needed. That is not done: nothing it asked for happened because of it (nothing was sent, started or confirmed). Do not treat it as done, and do not tell the owner it was.`
}
type ReplaceFields = 'id' | 'kind' | 'doneAt' | 'at' | 'raisedAt' | 'file' | 'files' | 'to' | 'sentAt' | 'sendingAt' | 'fillingAt'
const lower = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
function packageFolder(i: Pick<YourTurnItem, 'file' | 'files'>): string {
  const f = i.file ?? i.files?.[0]
  if (!f) return ''
  const parts = lower(f).split('/')
  parts.pop()
  return parts.join('/')
}
export function isOutwardCard(i: Pick<YourTurnItem, 'kind'>): boolean { return i.kind === 'send' || i.kind === 'submit' }
const DAY_SUFFIX = /,\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:man|tirs|ons|tors|fre|lør|søn)dag)?\.?\s*\d{1,2}\.?\s+(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch|ts)?|apr(?:il)?|maj|may|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:t|tember)?|o[ck]t(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-zæøå])\.?(?:\s+\d{4})?\s*$/i
export function titleWithoutDay(title: string): string { return title.replace(DAY_SUFFIX, '').trim() }
export const FOLLOW_UP_TITLE = /follow[- ]?up|thank|reminder|check[- ]?in|\bnote to\b|\bping\b|\bnudge\b/i
export function sameOutgoing(a: Pick<YourTurnItem, ReplaceFields> & { title?: string }, b: Pick<YourTurnItem, ReplaceFields> & { title?: string }): boolean {
  if (!isOutwardCard(a) || !isOutwardCard(b)) return false
  if (FOLLOW_UP_TITLE.test(a.title ?? '') || FOLLOW_UP_TITLE.test(b.title ?? '')) return false
  if (!a.file || !b.file || lower(a.file) !== lower(b.file)) return false
  const fa = packageFolder(a); if (!fa || fa !== packageFolder(b)) return false
  const ta = a.to?.contact?.trim().toLowerCase(), tb = b.to?.contact?.trim().toLowerCase()
  if (ta && tb) return ta === tb
  return a.kind === b.kind
}
export function newerCardFor<T extends Pick<YourTurnItem, ReplaceFields> & { title?: string }>(item: Pick<YourTurnItem, ReplaceFields> & { title?: string }, items: readonly T[]): T | undefined {
  if (item.doneAt || !isOutwardCard(item) || item.sentAt || item.sendingAt || item.fillingAt) return undefined
  const when = (i: Pick<YourTurnItem, 'at' | 'raisedAt'>): string => i.raisedAt ?? i.at
  const newer = items.filter(n => n.id !== item.id && !n.doneAt && sameOutgoing(item, n) && when(n) > when(item))
  return newer.sort((x, y) => when(y).localeCompare(when(x)))[0]
}
export function canCloseReplaced(item: Pick<YourTurnItem, ReplaceFields> & { title?: string }, items: readonly (Pick<YourTurnItem, ReplaceFields> & { title?: string })[]): boolean {
  return newerCardFor(item, items) !== undefined
}
export function replacedRefusal(item: (Pick<YourTurnItem, ReplaceFields> & { title?: string }) | undefined, items: readonly (Pick<YourTurnItem, ReplaceFields> & { title?: string })[]): string | null {
  if (!item) return "there is no card with that id on the owner's list."
  if (item.doneAt) return 'that card is already closed.'
  if (!isOutwardCard(item)) return 'only a Send or Submit card can be closed as replaced.'
  if (item.sentAt || item.sendingAt || item.fillingAt) return 'that card is being sent or was sent, so it cannot be called replaced.'
  if (!newerCardFor(item, items)) return 'no newer open Send or Submit card for the same files exists, so this card stays his to close.'
  return null
}
export function replacedLine(title: string, newerTitle: string, by: 'owner' | 'damon'): string {
  const clean = (t: string): string => `"${t.replace(/\s+/g, ' ').trim().slice(0, 100)}"`
  return by === 'owner'
    ? `You closed ${clean(title)} as replaced by ${clean(newerTitle)}. Damon has not taken it as sent or done.`
    : `I took ${clean(title)} off your list: ${clean(newerTitle)} replaces it. Nothing was taken as sent or done.`
}
export function replacedForManager(title: string, newerTitle: string, by: 'owner' | 'damon'): string {
  return `${by === 'owner' ? 'The owner' : 'You'} closed "${title}" as replaced by "${newerTitle}". That is not done and not sent: nothing it asked for happened because of it. Do not record it as sent or tell the owner it was; the newer card is the one that counts.`
}
const shown = (i: YourTurnItem): boolean => i.kind !== 'check' || checkAsks(i)

export function needsAction(item: YourTurnItem): boolean {
  return shown(item) && !item.waitingOn
}

export function cardsForOwner(open: readonly YourTurnItem[]): number {
  return open.filter(needsAction).length
}

export function privatePageNotice(site: string): string {
  return `A teammate wants to open ${site}`
}
export function privatePageJob(title: string): string {
  return title.replace(/^An? (?:agent|teammate) wants to open \S+ for /, '')
}

export function readyForOwner(o: {
  items: YourTurnItem[]
  blockers?: { resolvedAt?: string }[]
  needs?: number
  tasks?: Pick<TaskInfo, 'status' | 'escalation' | 'result'>[]
}): number {
  return (
    openItems(o.items).filter(needsAction).length +
    (o.blockers ?? []).filter((b) => !b.resolvedAt).length +
    (o.needs ?? 0) +
    (o.tasks ?? []).filter(isForOwner).length
  )
}

export interface YourTurnGroup {
  key: 'do' | 'decide' | 'look' | 'waiting'
  label: string
  items: YourTurnItem[]
}

export function groupItems(items: YourTurnItem[]): YourTurnGroup[] {
  const open = byNewest(openItems(items)).filter((i) => shown(i) && !i.waitingOn)
  const groups: YourTurnGroup[] = [
    { key: 'do', label: 'Do', items: open.filter((i) => i.kind !== 'decide') },
    { key: 'decide', label: 'Decide', items: open.filter((i) => i.kind === 'decide') },
    { key: 'waiting', label: 'Not ready yet', items: byNewest(openItems(items)).filter((i) => shown(i) && Boolean(i.waitingOn)) }
  ]
  return groups.filter((g) => g.items.length > 0)
}

export function byNewest(items: YourTurnItem[]): YourTurnItem[] {
  return [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export function sameItem(
  a: { title: string; file?: string; kind?: string },
  b: { title: string; file?: string; kind?: string }
): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  if (norm(a.title) !== norm(b.title)) return false
  return (a.file ?? '').replace(/\\/g, '/').toLowerCase() === (b.file ?? '').replace(/\\/g, '/').toLowerCase()
}

export function safeUrl(url: string | undefined): string | undefined {
  const s = (url ?? '').trim()
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return undefined
  return s.slice(0, 2000)
}

const OWNER_ACTION = [
  /\bfor you to (send|submit|sign|pay|decide|approve|read|check|review|apply|log in|upload)\b/i,
  /\byou (need|have|will have|'ll have|still have|now need) to\b/i,
  /\byou should (send|submit|sign|pay|apply|upload|log in)\b/i,
  /\b(send|submit|sign|upload|apply|post) (it|them|these|this|that) yourself\b/i,
  /\bready for you\b/i,
  /\b(on|to) your (to-?do )?list\b/i,
  /\byour to-?do\b/i,
  /\bwaiting (on|for) you\b/i,
  /\bover to you\b/i,
  /\byour (turn|move|call)\b/i
]

export function ownerActionMentioned(text: string): boolean {
  return OWNER_ACTION.some((re) => re.test(text))
}

export function ownerActionSentence(text: string): string {
  const plain = text.replace(/[*_`#>]+/g, '')
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/)
  const hit = (sentences.find((s) => ownerActionMentioned(s)) ?? '').trim()
  return hit.length > 220 ? hit.slice(0, 219) + '…' : hit
}

export function yourTurnLine(open: number): string {
  if (open === 0) return ''
  return open === 1 ? '1 job is ready for you.' : `${open} jobs are ready for you.`
}

export interface ExplainLine {
  label: string
  text: string
}
const EXPLAIN = /^(What needs you|Why|What to do|Where|Paste|Then|Damon's reason|Damon’s reason|Keep it|Send it back):\s*(.+)$/i
export function explainLines(what: string): ExplainLine[] | null {
  const lines = what
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const rows: ExplainLine[] = []
  for (const line of lines) {
    const m = line.match(EXPLAIN)
    if (m) rows.push({ label: m[1]!, text: m[2]! })
    else if (rows.length > 0) rows[rows.length - 1]!.text += ' ' + line
    else return null
  }
  if (rows.length < 2) return null
  return rows
}

export function objectionForOwner(finding: string): string {
  const parts = finding.split(/\s(?=(?:blocking|concern|major|minor|note|info):\s)/i).map((s) => s.trim()).filter(Boolean)
  const findings = parts.filter((s) => /^(blocking|concern|major|minor):/i.test(s))
  const WRAPPER = /^(?:\[Agent report[^\]]*\]\s*|The reviewer (?:found the draft does not meet|could not tell whether the draft meets) the criteria\.?|Not yet\b.*)$/i
  const METHOD = /^(?:I|We)\s+(?:read|opened|ran|re-?ran|checked|compared|inspected|verified|looked|hashed|searched|reviewed)\b/i
  const DEFECT = /\b(?:wrong|incorrect|missing|broken|crash\w*|fail\w*|error|bug|not|never|no longer|differs?|mismatch\w*)\b|\d[\d.,]*\s?(?:kr\b|øre|DKK)|\b\d{4}-\d{2}-\d{2}\b/i
  const first = parts[0] ?? ''
  const lead = /^(blocking|concern|major|minor|note|info):/i.test(first)
    ? []
    : [first.replace(/^\[Agent report[^\]]*\]\s*/i, '').split(/(?<=[.!?])\s+(?=\p{Lu})/u).map((x) => x.trim()).filter((x) => x && !WRAPPER.test(x) && !(METHOD.test(x) && !DEFECT.test(x))).join(' ')].filter(Boolean)
  if (findings.length) return [...lead, ...findings.map((s) => s.replace(/\s*\([^)]*\)\s*$/, ''))].join(' ')
  const head = parts[0] ?? finding
  return head.replace(/^The reviewer (found|could not tell)[^.]*\.\s*/i, '').trim() || finding
}

export function reviewerSaid(objection: string, max = 600, most = 3, card = false): string {
  return plainForOwner(ownerWords(objectionForOwner(objection)), max, { most, card, pointer: true })
}

export const KEEP_WORK = 'approves the work as it is, and the jobs waiting for it start.'
export const KEEP_FAULT = 'approves it with this fault on record; work that builds on it waits until the fix passes its own review.'
export const KEEP_CHECKED = 'it stays approved as it is.'
export const BACK_REVIEWER = "it goes back to the team with the reviewer's point, is fixed, and is checked again."
export const BACK_CHECK = "it goes back to the team with the check's finding, is fixed, and is checked again."
export const KEEP_DECISION = 'your earlier decision stands, and the work carries on under it.'
export const BACK_DECISION = 'Damon reconsiders it with you; nothing changes until you agree.'
export const DONE_CONFIRMED = 'you have opened the file and checked it yourself; Damon stops asking about it.'
export const BACK_REMAKE = 'the team remakes the file.'
export const KNOWN_FAULT_LEAD = 'Release accepts living with this fault: the work that builds on it stops waiting. Leave the card, and that work keeps waiting until a fix passes its own review.'
export const REVIEW_STUCK_LEAD = 'Keep it puts the draft in your folder as yours, once you have read it on the Files tab. Send it back has the writer do it again. Try the review again runs the review once more, now.'
export const PAST_CAP_LEAD = 'Try once more lets the team have one more go at this work. Stop here ends it: the manager is told not to assign it again and to change what is asked.'
const FAULT_PREAMBLE = /^A real fault, kept now and fixed by a follow-up job:[^.]*\.\s*/i
const OLD_BUTTON_SENTENCE = /\n?Keep it confirms your existing decision despite this concern\. Send it back asks Damon to reconsider with you; it does not approve a change\.\s*$/
const checkGate = (sendBack?: string): boolean => /The check found/.test(sendBack ?? '')
const signOffCard = (item: { what: string; sendBack?: string }): boolean =>
  /^Send ".*" back to .*?\. (?:The reviewer said|The check found):/s.test(item.sendBack ?? '') || /(?:^|\n)What needs you: (?:The reviewer refused|Damon approved)/.test(item.what)

export function signOffNotice(o: {
  label: string
  who: string
  gate: 'check' | 'reviewer'
  finding: string
  why: string
  files?: string[]
  knownFault?: boolean
}): { title: string; what: string; sendBack: string; file?: string; files?: string[] } {
  const label = o.label.trim()
  const said = reviewerSaid(o.finding, 2500, 6, true)
  const knownFault = o.knownFault ?? FAULT_PREAMBLE.test(o.why)
  const reason = plainForOwner(ownerWords(o.why.replace(FAULT_PREAMBLE, '')), 1500, { most: 6, card: true })
  const gate = o.gate === 'reviewer' ? 'the reviewer' : 'a check'
  return {
    title: `Keep “${label}” over ${gate === 'the reviewer' ? 'the reviewer’s' : 'a check’s'} objection?`,
    what: [
      o.gate === 'reviewer'
        ? `What needs you: The reviewer refused "${label}" (made by ${o.who}), and Damon thinks it should be kept${knownFault ? ' with its fault on record and a fix to follow' : ''}. Only you can settle that.`
        : `What needs you: Damon approved "${label}" by ${o.who} even though a check questioned it. Only you can settle that.`,
      `Why: ${o.gate === 'reviewer' ? 'The reviewer said' : 'The check found'}: ${said}`,
      `Damon's reason: ${reason}`,
      'What to do: Open the file and read both sides, then choose.',
      `Keep it: ${knownFault ? KEEP_FAULT : o.gate === 'reviewer' ? KEEP_WORK : KEEP_CHECKED}`,
      `Send it back: ${o.gate === 'reviewer' ? BACK_REVIEWER : BACK_CHECK}`
    ].join('\n'),
    file: o.files?.length === 1 ? o.files[0] : undefined,
    files: (o.files?.length ?? 0) > 1 ? o.files : undefined,
    sendBack: `Send "${label}" back to ${o.who}. ${o.gate === 'reviewer' ? 'The reviewer said' : 'The check found'}: ${o.finding.replace(/\s+/g, ' ').trim().slice(0, 600)} Your reason for signing it off anyway does not hold. Have it fixed and checked again before it comes back to me.`
  }
}

export function decisionEffects(item: Pick<YourTurnItem, 'kind' | 'what' | 'sendBack' | 'critiqueDecision' | 'standard'>): { keep: string; sendBack: string } | null {
  if (item.standard) return { keep: 'Keep it: puts this rule on every job from now on; nobody on the team can reword or lower it afterwards.', sendBack: 'Send it back: throws the suggestion away and changes nothing.' }
  if (item.kind !== 'decide' || !(item.sendBack || item.critiqueDecision)) return null
  if (item.critiqueDecision && isOwnerConfirmation(item.critiqueDecision.challenge)) return { keep: `Done: ${DONE_CONFIRMED}`, sendBack: `Send it back: ${BACK_REMAKE}` }
  const rows = explainLines(item.what) ?? []
  const keep = rows.find((r) => /^keep it$/i.test(r.label))?.text
  const back = rows.find((r) => /^send it back$/i.test(r.label))?.text
  if (keep && back) return { keep: `Keep it: ${keep}`, sendBack: `Send it back: ${back}` }
  if (item.critiqueDecision) return { keep: `Keep it: ${KEEP_DECISION}`, sendBack: `Send it back: ${BACK_DECISION}` }
  if (!signOffCard(item)) return null
  const check = checkGate(item.sendBack) || /even though a check/.test(item.what)
  const fault = /Damon's reason: A real fault, kept now/i.test(item.what)
  return { keep: `Keep it: ${fault ? KEEP_FAULT : check ? KEEP_CHECKED : KEEP_WORK}`, sendBack: `Send it back: ${check ? BACK_CHECK : BACK_REVIEWER}` }
}
export function withoutOldButtonSentence(what: string): string { return what.replace(OLD_BUTTON_SENTENCE, '') }

export function cautionLine(gate: 'check' | 'reviewer', findings: string, why: string): string {
  const said = reviewerSaid(findings, 240, 2)
  const reason = plainForOwner(ownerWords(why.replace(FAULT_PREAMBLE, '')), 240, { card: true })
  return gate === 'reviewer'
    ? `The reviewer refused this work and Damon thinks it should be kept, so it waits for you. The reviewer said: ${said} Damon's reason: ${reason} If that does not convince you, send it back.`
    : `A check questioned this work and Damon kept it. It said: ${said} Damon's reason: ${reason} If that does not convince you, send it back before you use it.`
}

const HOST_SENTENCES: [RegExp, string][] = [
  [/The review no longer describes the current draft:\s*Requirements, owner answers or critical findings changed after this review\.?/gi, 'the project’s records changed after the review; the draft itself was not faulted'],
  [/The review no longer describes the current draft:\s*Project execution permissions changed after this review\.?/gi, 'permissions changed after the review; the draft itself was not faulted'],
  [/The review no longer describes the current draft:\s*The draft changed after this review\.[^.]*\.?/gi, 'the draft changed after the review, so it needs a fresh look'],
  [/Resolve and independently review:\s*/gi, ''],
  [/There may be no HTML-to-PDF renderer available to the team\.?/gi, 'the team may not be able to print the PDF itself'],
  [/An input changed or disappeared:\s*([^.]+)\.\s*Recheck the affected work\.?/gi, 'a file this work was made from has changed since: $1'],
  [/Unknown, missing or duplicate scenario ID\.?/gi, ''],
  [/Allow lets Damon(?:'|’)s workers\sand reviewers run them while they build and check work\.?/gi, '']
]
export function asSentence(text: string): string {
  const t = text.trim().replace(/[\s.]+$/, '')
  return t ? t + '.' : ''
}
const BOOKKEEPING_ONLY: RegExp[] = [
  /The review no longer describes the current draft:?/gi,
  /Requirements, owner answers or critical findings changed after this review\.?/gi,
  /Project execution permissions changed after this review\.?/gi,
  /Project permissions changed after this draft was produced\.?/gi,
  /The draft changed after this review\.?/gi,
  /The reviewer found the draft does not meet the criteria\.?/gi,
  /Resolve and independently review:?/gi,
  /An input changed or disappeared:[^.]*\.?\s*Recheck the affected work\.?/gi,
  /Unknown, missing or duplicate scenario ID\.?/gi
]
export function isBookkeepingObjection(text: string): boolean {
  let rest = text
  for (const re of BOOKKEEPING_ONLY) rest = rest.replace(re, ' ')
  rest = rest.replace(/[\s.;:,()\-–—]+/g, ' ').trim()
  return text.trim().length > 0 && rest.length < 24
}
const DEFECT = /\b(?:wrong|incorrect|false|missing|broken|fails?|failed|failing|error|bug|defect|does not match|doesn't match|mismatch|violat\w*|contradict\w*|overclaim\w*|untrue|partly fixed|not fixed|still (?:says|reads|has|shows))\b/i
const UNOBSERVED = /\b(?:could not|cannot|can't|couldn't|unable to|did not|was not|were not|not) (?:be )?(?:independently )?(?:run|read(?: back)?|open(?:ed)?|observe[d]?|inspect(?:ed)?|verif(?:y|ied)|check(?:ed)?|confirm(?:ed)?|see|seen|load(?:ed)?|reach(?:ed)?)\b|\bunverified\b|\bnot independently inspected\b|\bblocked\b/i
export function onlyUnobserved(text: string): boolean {
  if (!text.trim() || DEFECT.test(text)) return false
  let rest = text
  for (const re of BOOKKEEPING_ONLY) rest = rest.replace(re, ' ')
  const parts = rest.split(/(?:\[(?:gap|blocking|note)\]|;|\n|(?<=\.)\s+(?=[A-Z]))/i).map((p) => p.trim()).filter((p) => p.replace(/[\s.;:,()\-–—]+/g, '').length > 0)
  return parts.some((p) => UNOBSERVED.test(p)) && parts.every((p) => UNOBSERVED.test(p) || POSITIVE.test(p))
}
const POSITIVE = /\b(?:exists?|is correct|are correct|matches|match|passes|passed|is present|are present|recorded|as requested|confirmed live|is live)\b/i
export function ownerWords(text: string): string {
  let out = text
  for (const [re, plain] of HOST_SENTENCES) out = out.replace(re, plain)
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:]+/, '').trim()
}

export type SubmitStage = 'fill' | 'filled' | 'failed' | 'by-hand' | 'waiting'
export function submitStage(item: Pick<YourTurnItem, 'kind' | 'url' | 'filledAt' | 'fillFailed' | 'fillingAt' | 'waitingOn'>): SubmitStage | null {
  if (item.kind !== 'submit') return null
  if (item.waitingOn) return 'waiting'
  if (!item.url) return 'by-hand'
  if (item.filledAt && !item.fillFailed) return 'filled'
  if (item.fillFailed) return 'failed'
  return 'fill'
}

export function submitActions(item: Pick<YourTurnItem, 'kind' | 'filledAt' | 'waitingOn' | 'doneAt'>): ('fill' | 'submitted' | 'notYet')[] {
  if (item.kind !== 'submit') return []
  if (item.doneAt) return []
  if (item.waitingOn) return ['submitted']
  return item.filledAt ? ['submitted', 'notYet'] : ['fill', 'submitted']
}

export function privatePageWhat(site: string, job: string, url: string): string {
  return `What needs you: a yes or a no.\nWhy: ${job} wants to read a page on ${site}, where you sign in, read your post or mail, or bank. The team never opens such a page without your yes. It asked for: ${url.slice(0, 200)}\nWhat to do: Allow for this job lets it open, read and look at ${site} for this one job, two hours at most; what the page shows goes to the team's AI model, and Damon keeps no copy. Decline and it carries on without it. If the site wants you to sign in, open the page, sign in there yourself, then press Allow.`
}

export function leadFor(item: Pick<YourTurnItem, 'kind' | 'what' | 'url' | 'filledAt' | 'fillFailed' | 'fillingAt' | 'leftToFill' | 'fillChecks' | 'readyToSubmit' | 'sendBack' | 'critiqueDecision' | 'standard' | 'opens' | 'text' | 'waitingOn' | 'doneAt' | 'projectCheck' | 'projectChecks' | 'knownFault' | 'privatePage' | 'pastCap' | 'reviewStuck'>): string {
  if (item.knownFault) return KNOWN_FAULT_LEAD
  if (item.pastCap) return PAST_CAP_LEAD
  if (item.reviewStuck) return REVIEW_STUCK_LEAD
  if (item.privatePage) return `Allow for this job lets this one job open ${item.privatePage.site}; Decline keeps it out. Another job asks again.`
  const stage = submitStage(item)
  if (item.waitingOn) {
    const place = item.kind === 'send' ? 'the thread' : 'the page'
    const byHand = item.kind === 'send' ? 'send it yourself' : 'submit it by hand'
    return `Not ready for you yet: ${asSentence(ownerWords(plainForOwner(item.waitingOn, 300)))} Damon is clearing that, and this card wakes up when it is done. You can still open ${place} and ${byHand}.`
  }
  if (stage === 'filled' && item.readyToSubmit === true) return `Ready to submit: Damon read every field and upload he filled back from the form in the team’s browser. Left for you to answer: ${item.leftToFill || 'nothing'}. Press the site’s own Submit, then press “I pressed Submit” here. If you have not, press “Not yet”.`
  if (stage === 'filled' && item.readyToSubmit === false) {
    const bad = (item.fillChecks ?? []).filter(c => !c.ok)
    return `Not ready to submit yet: the form is filled in the team’s browser, but ${bad.length ? `${bad.length === 1 ? 'one thing' : `${bad.length} things`} could not be verified on the page: ${bad.map(c => `${c.what} (${c.why})`).join('; ')}` : 'a required box is still empty'}. Left for you to answer: ${item.leftToFill || 'nothing'}. Put those right in the form, then press the site’s own Submit and “I pressed Submit” here. If you have not, press “Not yet”.`
  }
  if (stage === 'filled') return `The form is filled in the team’s browser and waiting for you. Left for you to answer: ${item.leftToFill || 'nothing'}. Check it there, press the site’s own Submit, then press “I pressed Submit” here. If you have not, press “Not yet”.`
  if (stage === 'failed') return `Damon could not fill the form: ${asSentence(ownerWords(failureForOwner(item.fillFailed ?? '')))} Open the page and submit it by hand, or press Fill it in.`
  if (stage === 'fill') return 'Press Fill it in. Damon fills the form in the team’s browser from the package and stops before the site’s Submit button; you check it and press Submit yourself. Or open the page and do it by hand.'
  if (stage === 'by-hand') return 'Open the page and submit it by hand with the files below. Once you have pressed the site’s own Submit, press “I pressed Submit” here.'
  if (item.standard) return 'Damon suggests this becomes a rule for every job on this project. Keep it makes it a rule nobody on the team can lower; Send it back throws it away.'
  if (item.kind === 'decide' && item.critiqueDecision) return isOwnerConfirmation(item.critiqueDecision.challenge) ? 'Open the file and check it yourself; Damon cannot read it.' : 'A check questioned one of your earlier decisions. Read it below, then choose.'
  if (item.kind === 'decide' && item.sendBack && !signOffCard(item)) {
    const todo = explainLines(item.what)?.find((l) => /^what to do$/i.test(l.label))?.text
    return todo ? ownerWords(todo) : 'Damon needs your decision. Read it below, then choose.'
  }
  if (item.kind === 'decide' && item.sendBack) return checkGate(item.sendBack) ? 'A check objected after Damon approved it. Open the file and read both sides below, then choose.' : 'The reviewer objected and Damon recommends keeping it. Open the file and read both sides below, then choose.'
  if (item.projectChecks && item.projectChecks.length > 1) return 'Allow lets Damon\u2019s teammates and reviewers run exactly these commands, each in a throwaway copy of the project and never in your folder, while they build and check work. Decline keeps them checking by reading only.'
  if (item.projectCheck) return 'Allow lets Damon\u2019s teammates and reviewers run exactly this command in a throwaway copy of the project, never in your folder, while they build and check work. Decline keeps them checking by reading only.'
  if (item.kind === 'decide') return 'Damon needs your answer. Read it, then Open the chat and answer there; Done takes it off the list.'
  if (item.kind === 'send') return 'Read the message. Send posts it in the team’s browser as you; Done means you sent it yourself.'
  if (item.kind === 'login') return 'Open the sign-in page, sign in there, then press Done.'
  const lines = explainLines(item.what)
  const todo = lines?.find((l) => /^what to do$/i.test(l.label))?.text
  if (todo) return ownerWords(todo)
  return ownerWords(item.what.split('\n')[0] ?? item.what).slice(0, 400)
}

export const BUTTON = {
  fill: 'Fill it in',
  send: 'Send',
  done: 'Done',
  submitted: 'I pressed Submit',
  sent: 'I sent it',
  checkAgain: 'Check again',
  notYet: 'Not yet',
  keep: 'Keep it',
  sendBack: 'Send it back',
  copy: 'Copy',
  allow: 'Allow for this job',
  decline: 'Decline',
  open: (place: string): string => `Open ${place}`
} as const
export function ownerTitle(item: Pick<YourTurnItem, 'title'>): string {
  return item.title
}
export const DOORS_NAMED = ['the thread', 'the form', 'the file', 'the chat', 'Accounts', 'Connections', 'Team', 'Limits', 'the sign-in page', 'the page', 'the email'] as const

export const DECISION_NOT_ASKED = 'That decision is no longer awaiting an answer.'
export const DECISION_UNKNOWN = 'Unknown critique decision.'
export function staleDecision(message: string): boolean {
  return message === DECISION_NOT_ASKED || message === DECISION_UNKNOWN
}

export function closableQuestion(item: Pick<YourTurnItem, 'kind' | 'doneAt' | 'sendBack' | 'critiqueDecision' | 'standard' | 'need' | 'projectCheck' | 'privatePage' | 'pastCap'> & { knownFault?: unknown; reviewStuck?: unknown }): boolean {
  return item.kind === 'decide' && !item.doneAt && !item.knownFault && !item.sendBack && !item.critiqueDecision && !item.standard && !item.need && !item.projectCheck && !item.privatePage && !item.pastCap && !item.reviewStuck
}

type Replaceable = Parameters<typeof closableQuestion>[0] & { id: string; at: string }
export function replacementRefusal(item: Replaceable, newer: Replaceable | undefined): string | null {
  if (!newer || newer.doneAt || newer.kind !== 'decide' || newer.id === item.id) return 'replaced_by must be the id of another open question card on the owner\'s list.'
  if (!closableQuestion(item)) return 'only a plain question the team asked can be replaced. A Submit, Send, critic, standard or record card is the owner\'s own to close.'
  if (newer.at <= item.at) return 'the replacing card must be newer than the one it replaces.'
  return null
}

export function mootRefusal(item: Parameters<typeof closableQuestion>[0] & { kind: string; doneAt?: string; critiqueDecision?: unknown; knownFault?: unknown; standard?: unknown }, why: string, provenMoot: boolean): string | null {
  if (item.doneAt) return 'that card is already closed.'
  if (why.trim().length < 20) return 'say in one line why it no longer needs his answer (at least 20 characters).'
  if (!(item.kind === 'decide' && item.critiqueDecision && !item.knownFault && !item.standard)) return "only a critic's question can be closed as no longer needed. A Submit, Send, Keep or Send it back, standard, record, check or known-fault card stays his."
  if (!provenMoot) return 'Damon cannot show it is moot (a job it was about is still open), so it stays on his list for one press.'
  return null
}

export function answeredInChatSince(chat: { role: string; text?: string; at?: string }[], since: string): boolean {
  return chat.some(m => m.role === 'user' && (m.text ?? '').trim() !== '' && (m.at ?? '') >= since)
}
