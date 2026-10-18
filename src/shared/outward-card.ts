import { isCheckNotClear, ownerWords, plainForOwner, safeUrl, type YourTurnItem } from './your-turn'

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

const norm = (f: string): string => f.replace(/\\/g, '/')
const base = (f: string): string => norm(f).split('/').pop() ?? f

export function emailRecipient(item: Pick<YourTurnItem, 'to'>): string | null {
  const c = item.to?.contact?.trim()
  return c && EMAIL_RE.test(c) ? c : null
}

export function emailFileOf(item: Pick<YourTurnItem, 'file' | 'files'>): string | null {
  if (item.file && /\.txt$/i.test(item.file)) return norm(item.file)
  const found = (item.files ?? []).find((f) => base(f).toLowerCase() === 'email.txt')
  return found ? norm(found) : null
}

export function isEmailCard(item: Pick<YourTurnItem, 'kind' | 'to' | 'file' | 'files' | 'url'>): boolean {
  if (item.kind !== 'submit' && item.kind !== 'send') return false
  if (safeUrl(item.url) !== undefined) return false
  return emailRecipient(item) !== null && emailFileOf(item) !== null
}

export function usesOutwardLayout(item: Pick<YourTurnItem, 'kind' | 'to' | 'file' | 'files' | 'url'>): boolean {
  return item.kind === 'submit' || isEmailCard(item)
}

export function parseEmailFile(text: string): { subject: string; body: string } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const m = /^\s*subject\s*:\s*(.*)$/i.exec(lines[0] ?? '')
  const rest = m ? lines.slice(1) : lines
  while (rest.length && !rest[0]!.trim()) rest.shift()
  return { subject: m ? m[1]!.trim() : '', body: rest.join('\n').replace(/\s+$/, '') }
}

export const MAILTO_MAX = 2000
export function mailLink(d: { to: string; subject: string; body: string }): { url: string; inLink: boolean } {
  if (!EMAIL_RE.test(d.to)) throw new Error('That is not an email address.')
  const enc = (s: string): string => encodeURIComponent(s.replace(/\r?\n/g, '\r\n'))
  const head = `mailto:${d.to}?subject=${enc(d.subject)}`
  const full = `${head}&body=${enc(d.body)}`
  return full.length <= MAILTO_MAX ? { url: full, inLink: true } : { url: head, inLink: false }
}

const ROLES: [RegExp, string][] = [
  [/(^|[-_ ])letter([-_ .]|$)/i, 'Letter'],
  [/report/i, 'Report'],
  [/proposal|quote|offer/i, 'Proposal'],
  [/invoice/i, 'Invoice'],
  [/contract|agreement/i, 'Contract'],
  [/portfolio/i, 'Portfolio']
]
const ROLE_ORDER = ['The email', 'Letter', 'Report', 'Proposal', 'Invoice', 'Contract', 'Portfolio', 'File']

export function fileRole(file: string, how: 'upload' | 'attach'): { what: string; out: boolean } {
  const name = base(file)
  if (/\.pdf$/i.test(name)) {
    const role = ROLES.find(([re]) => re.test(name))?.[1] ?? 'File'
    return { what: `${role} (${how})`, out: true }
  }
  if (/^submission-notes\.md$/i.test(name)) return { what: "Damon's instructions", out: false }
  if (/^request\.(md|html?|txt)$/i.test(name)) return { what: 'The request, as saved', out: false }
  if (/recipient-notes/i.test(name)) return { what: 'Notes on the recipient', out: false }
  if (/^email\.txt$/i.test(name)) return { what: 'The email', out: false }
  if (/email\.txt$/i.test(name)) return { what: 'A second email (it gets its own card)', out: false }
  const stem = name.replace(/\.(md|html?)$/i, '')
  if (stem !== name && ROLES.some(([re]) => re.test(stem + '.pdf'))) return { what: `Source of ${stem}.pdf`, out: false }
  return { what: 'A file in the folder', out: false }
}

export interface OutgoingFile { file: string; name: string; what: string; out: boolean }

export function outgoingFiles(files: readonly string[], how: 'upload' | 'attach', printed?: readonly string[], emailFile?: string | null): OutgoingFile[] {
  const all = files.map(norm)
  const has = (f: string): boolean => all.some((x) => x.toLowerCase() === f.toLowerCase())
  const prints = printed
    ? printed.map(norm).filter((p) => !has(p))
    : all.filter((f) => /\.html?$/i.test(f)).map((f) => f.replace(/\.html?$/i, '.pdf')).filter((p) => !has(p))
  const outFiles = [...new Set([...all.filter((f) => /\.pdf$/i.test(f)), ...prints])]
  const roleOf = (f: string): string => fileRole(f, how).what.replace(/ \((upload|attach)\)$/, '')
  outFiles.sort((a, b) => ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)))
  const email = emailFile ? norm(emailFile) : null
  const out: OutgoingFile[] = [
    ...(email ? [{ file: email, name: base(email), what: 'The email', out: true }] : []),
    ...outFiles.map((f) => ({ file: f, name: base(f), what: fileRole(f, how).what, out: true }))
  ]
  const rest = all.filter((f) => !out.some((o) => o.file === f)).map((f) => ({ file: f, name: base(f), ...fileRole(f, how), out: false }))
  return [...out, ...rest]
}

function sentences(text: string): string[] {
  return text.split('\n').flatMap((line) => line.split(/(?<=[.!?]["”)]?)\s+(?=[A-Z"“(])/)).map((s) => s.trim()).filter(Boolean)
}

export function noteLines(text: string | undefined): string[] {
  return sentences(withoutIds(ownerWords(text ?? '')))
}

export function listWords(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const NOT_FIELDS = /^(folder|uploads?|attachments?|subject|step|before (sending|uploading|you send|you upload)|note|why|what to do|what needs you|then|damon's reason|deadline|form|cut from)$/i
export function pasteFields(item: Pick<YourTurnItem, 'kind' | 'to' | 'file' | 'files' | 'url' | 'what' | 'text'>): { label: string; text: string }[] {
  if (isEmailCard(item)) return []
  const out: { label: string; text: string }[] = []
  for (const s of sentences([item.what, item.text ?? ''].join('\n'))) {
    const m = /^([A-Z][A-Za-z' ]{1,40}?):\s+(.+)$/.exec(s)
    if (!m) continue
    const label = m[1]!.trim()
    const text = m[2]!.replace(/[.\s]+$/, '').trim()
    if (label.split(/\s+/).length > 4 || NOT_FIELDS.test(label)) continue
    if (!text || text.length > 48 || /\.(pdf|md|html?|txt|docx?)\b/i.test(text) || /https?:\/\//i.test(text)) continue
    if (out.some((f) => f.label.toLowerCase() === label.toLowerCase())) continue
    out.push({ label, text })
  }
  return out
}

export function beforeYouPress(item: Pick<YourTurnItem, 'what'>): string[] {
  const out: string[] = []
  for (const raw of sentences(item.what)) {
    if (/not ready yet|final check|this card/i.test(raw)) continue
    if (!/\b(check|make sure|stop and tell)\b/i.test(raw) && !/^before\b/i.test(raw)) continue
    let s = raw.replace(/^before [a-z]+(?: [a-z]+)?,\s+/i, '').replace(/^[A-Z][A-Za-z ,']{0,40}:\s+(?=[a-z(])/, '').replace(/^\(\d+\)\s*/, '')
    if (s.length > 220) s = s.slice(0, 219).replace(/\s+\S*$/, '') + '…'
    s = s.charAt(0).toUpperCase() + s.slice(1)
    if (!out.includes(s)) out.push(s)
    if (out.length === 3) break
  }
  return out
}

export function withoutIds(text: string): string {
  const id = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi
  const isId = (s: string): boolean => /\d/.test(s) && /[a-f]/i.test(s)
  return text
    .replace(/\b(same as)\s+([0-9a-f]{8}(?:-[0-9a-f-]{27})?)\b/gi, (all, lead: string, hex: string) => (isId(hex) ? `${lead} before` : all))
        .replace(/\s*\(\s*([0-9a-f-]{8,36})\s*\)/gi, (all, hex: string) => (isId(hex) ? '' : all))
    .replace(id, (hex) => (isId(hex) ? '' : hex))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}

const firstSentence = (s: string): string => {
  const one = (s.split(/(?<=[.!?])\s+/)[0] ?? s).trim()
  const cut = one.length > 160 ? one.slice(0, 159).replace(/\s+\S*$/, '') + '…' : one
  return /[.!?…]$/.test(cut) ? cut : cut + '.'
}

export function heldReason(item: Pick<YourTurnItem, 'waitingOn' | 'fillFailed' | 'sendFailed'>): string | null {
  if (item.waitingOn) return firstSentence(withoutIds(ownerWords(plainForOwner(item.waitingOn, 300, { card: true }))))
  if (isCheckNotClear(item.fillFailed) || isCheckNotClear(item.sendFailed)) return "Damon's own final check on this package did not come back clear."
  return null
}

export function cautionNotes(caution: string | undefined): string[] {
  const out: string[] = []
  for (const raw of (caution ?? '').split('\n')) {
    let s = raw.trim()
    if (!s || /^the critic suggests \(optional\):\s*none\.?$/i.test(s)) continue
    s = s.replace(/^the critic suggests \(optional\):\s*/i, 'Suggestion: ')
    s = s.replace(/^damon's check on (\S+) \(for you, not sent\):\s*/i, (_all, f: string) => `${base(f)}: `)
    s = s.replace(/\s*Prior findings? [^.]*\.?/gi, '')
    s = withoutIds(s)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
