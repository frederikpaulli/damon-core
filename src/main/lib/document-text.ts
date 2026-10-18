import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import workerPath from './document-worker.mts?modulePath'
import type { DocumentBody, DocumentKind, PagePicture, ReaderReply, ReaderRequest } from './document-worker.mts'
import { requireReviewedTextInSlices } from './protected-context'
import { decodePlainText } from '../../shared/file-reading'
import { readableText } from '../../shared/readable-text'

export type { DocumentKind, PagePicture } from './document-worker.mts'

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
export const DOCUMENT_MAX_PAGES = 80
export const DOCUMENT_MAX_CHARS = 2_000_000
export const DOCUMENT_BUDGET_MS = 20_000
export const DOCUMENT_HARD_STOP_MS = 30_000
export const CONTAINER_MAX_BYTES = 64 * 1024 * 1024
const READER_HEAP_MB = 512
const READER_IDLE_MS = 60_000
const READER_QUEUE_MAX = 16
const CACHE_DIR = 'document-text'
const CACHE_KEEP = 200
const MEMORY_KEEP = 8

export interface DocumentText extends DocumentBody {
  v: 1
  kind: DocumentKind
  sha256: string
  inside?: { container: 'zip' | 'msg'; name: string; sha256: string }
}

export function containerOf(path: string): 'zip' | 'msg' | null {
  return /\.zip$/i.test(path) ? 'zip' : /\.msg$/i.test(path) ? 'msg' : null
}

export function documentKind(path: string, bytes: Buffer): DocumentKind | null {
  const zip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (ext === 'pdf' && bytes.subarray(0, 8192).includes('%PDF-')) return 'pdf'
  if (zip && (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'epub' || ext === 'odt' || ext === 'ods' || ext === 'odp')) return ext
  if (zip && ext === 'zip') return 'zip'
  const ole = bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1
  const old = ext === 'doc' || ext === 'dot' ? 'doc' : ext === 'xls' || ext === 'xlt' ? 'xls' : ext === 'ppt' || ext === 'pps' || ext === 'pot' ? 'ppt' : null
  if (old && ole) return old
  if (old && zip) return `${old}x` as DocumentKind
  if (ext === 'msg' && ole) return 'msg'
  if (ext === 'rtf' && bytes.subarray(0, 8).toString('latin1').startsWith('{\\rtf')) return 'rtf'
  if ((ext === 'html' || ext === 'htm') && !bytes.subarray(0, 4096).includes(0)) return 'html'
  return null
}
export const DOCUMENT_NAME = /\.(?:pdf|docx|xlsx|pptx|epub|odt|ods|odp|rtf|zip|doc|dot|xls|xlt|ppt|pps|pot|msg)$/i

type Unnumbered<T> = T extends unknown ? Omit<T, 'id'> : never

class DocumentReader {
  private worker: Worker | undefined
  private seq = 0
  private waiting = 0
  private lane: Promise<unknown> = Promise.resolve()
  private current: { id: number; resolve: (reply: ReaderReply) => void; reject: (e: Error) => void } | undefined
  private idle: ReturnType<typeof setTimeout> | undefined

  private spawn(): Worker {
    const worker = new Worker(workerPath, { workerData: { damon: 'documents' }, resourceLimits: { maxOldGenerationSizeMb: READER_HEAP_MB } })
    worker.on('message', (reply: ReaderReply) => {
      const asked = this.current
      if (!asked || reply?.id !== asked.id) return
      this.current = undefined
      if (reply.ok) asked.resolve(reply)
      else asked.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }))
    })
    const lost = (why: string): void => {
      if (this.worker === worker) this.worker = undefined
      const asked = this.current
      this.current = undefined
      asked?.reject(new Error(why))
    }
    worker.on('error', () => lost('The document reader stopped while reading this file.'))
    worker.on('messageerror', () => lost('The document reader could not hand the text back.'))
    worker.on('exit', () => lost('The document reader stopped while reading this file.'))
    return worker
  }

  ask(request: Unnumbered<ReaderRequest>, transfer: ArrayBuffer[]): Promise<ReaderReply> {
    if (this.waiting >= READER_QUEUE_MAX) return Promise.reject(new Error('Damon is reading too many documents at once. Try again in a minute.'))
    this.waiting += 1
    const run = (): Promise<ReaderReply> => new Promise<ReaderReply>((resolve, reject) => {
      if (this.idle) { clearTimeout(this.idle); this.idle = undefined }
      const worker = this.worker ??= this.spawn()
      worker.ref()
      const id = ++this.seq
      const timer = setTimeout(() => {
        if (this.current?.id === id) { this.current = undefined; this.worker = undefined; void worker.terminate(); reject(new Error(`Damon stopped reading this file after ${DOCUMENT_HARD_STOP_MS / 1000} seconds.`)) }
      }, DOCUMENT_HARD_STOP_MS)
      const settle = (): void => { clearTimeout(timer); this.rest() }
      this.current = { id, resolve: reply => { settle(); resolve(reply) }, reject: e => { settle(); reject(e) } }
      worker.postMessage({ ...request, id } as ReaderRequest, transfer)
    })
    const turn = this.lane.then(run, run)
    this.lane = turn.catch(() => undefined).finally(() => { this.waiting -= 1 })
    return turn
  }

  private rest(): void {
    const worker = this.worker
    if (!worker) return
    worker.unref()
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.idle = undefined; if (!this.current && this.worker === worker) { this.worker = undefined; void worker.terminate() } }, READER_IDLE_MS)
    this.idle.unref()
  }

  stop(): Promise<void> {
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined }
    const worker = this.worker
    this.worker = undefined
    return worker ? worker.terminate().then(() => undefined) : Promise.resolve()
  }
}
const reader = new DocumentReader()
export function stopDocumentReader(): Promise<void> { return reader.stop() }

function own(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length)
  new Uint8Array(copy).set(bytes)
  return copy
}

const memory = new Map<string, DocumentText>()
function remember(doc: DocumentText): void {
  memory.delete(doc.sha256)
  memory.set(doc.sha256, doc)
  while (memory.size > MEMORY_KEEP) memory.delete(memory.keys().next().value!)
}
const valid = (known: DocumentText | null | undefined, sha256: string, kind: DocumentKind): known is DocumentText =>
  !!known && known.v === 1 && known.sha256 === sha256 && known.kind === kind && typeof known.text === 'string' && Array.isArray(known.textless)

export class DocumentTextStore {
  private readonly dir: string
  constructor(stateDir: string) { this.dir = join(stateDir, CACHE_DIR) }
  cachedNow(sha256: string, kind: DocumentKind): DocumentText | null {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null
    const held = memory.get(sha256)
    if (valid(held, sha256, kind)) return held
    try {
      const known = JSON.parse(readFileSync(join(this.dir, `${sha256}.json`), 'utf8')) as DocumentText
      if (valid(known, sha256, kind)) return known
    } catch {}
    return null
  }
  async cached(sha256: string, kind: DocumentKind): Promise<DocumentText | null> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null
    const held = memory.get(sha256)
    if (valid(held, sha256, kind)) { remember(held); return held }
    try {
      const known = JSON.parse(await readFile(join(this.dir, `${sha256}.json`), 'utf8')) as DocumentText
      if (valid(known, sha256, kind)) { remember(known); return known }
    } catch {}
    return null
  }
  async read(bytes: Buffer, sha256: string, kind: DocumentKind): Promise<DocumentText> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('A document is read by its sha256.')
    const known = await this.cached(sha256, kind)
    if (known) return known
    const most = kind === 'zip' || kind === 'msg' ? CONTAINER_MAX_BYTES : DOCUMENT_MAX_BYTES
    if (bytes.length > most) throw new Error(`This file is larger than ${most / 1048576} MB, so Damon does not take its text out.`)
    const moving = own(bytes)
    const reply = await reader.ask({ op: 'text', kind, bytes: moving, limits: { maxPages: DOCUMENT_MAX_PAGES, maxChars: DOCUMENT_MAX_CHARS, budgetMs: DOCUMENT_BUDGET_MS } }, [moving])
    const body = reply.ok ? reply.body : undefined
    if (!body) throw new Error('The document reader gave no text back.')
    const record: DocumentText = { v: 1, kind, sha256, pages: body.pages, pagesRead: body.pagesRead, text: body.text, textless: body.textless, cut: body.cut, ...(body.fonts?.length ? { fonts: body.fonts } : {}) }
    remember(record)
    try { await mkdir(this.dir, { recursive: true }); await writeFile(join(this.dir, `${sha256}.json`), JSON.stringify(record), 'utf8'); await this.trim() } catch {}
    return record
  }
  private async kept(key: string): Promise<DocumentText | null> {
    const held = memory.get(key)
    if (held && held.sha256 === key) { remember(held); return held }
    try {
      const known = JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as DocumentText
      if (known && known.v === 1 && known.sha256 === key && typeof known.text === 'string' && Array.isArray(known.textless)) { remember(known); return known }
    } catch {}
    return null
  }
  async readInside(outer: Buffer, outerSha: string, container: 'zip' | 'msg', inside: string, words: boolean): Promise<{ doc: DocumentText } | { other: { name: string; head: Uint8Array } }> {
    if (!/^[a-f0-9]{64}$/.test(outerSha)) throw new Error('A document is read by its sha256.')
    const key = createHash('sha256').update(`inside\n${outerSha}\n${container}\n${inside}\n${words ? 'words' : 'as stored'}`).digest('hex')
    const known = await this.kept(key)
    if (known) return { doc: known }
    if (outer.length > CONTAINER_MAX_BYTES) throw new Error(`This file is larger than ${CONTAINER_MAX_BYTES / 1048576} MB, so Damon does not take its text out.`)
    const moving = own(outer)
    const reply = await reader.ask({ op: 'inner', container, bytes: moving, inside, want: 'text', words, limits: { maxPages: DOCUMENT_MAX_PAGES, maxChars: DOCUMENT_MAX_CHARS, budgetMs: DOCUMENT_BUDGET_MS }, maxBytes: DOCUMENT_MAX_BYTES }, [moving])
    const inner = reply.ok ? reply.inner : undefined
    if (!inner) throw new Error('The document reader gave no text back.')
    if (!inner.body || !inner.kind) return { other: { name: inner.name, head: inner.head ?? new Uint8Array(0) } }
    const record: DocumentText = { v: 1, kind: inner.kind, sha256: key, pages: inner.body.pages, pagesRead: inner.body.pagesRead, text: inner.body.text, textless: inner.body.textless, cut: inner.body.cut, ...(inner.body.fonts?.length ? { fonts: inner.body.fonts } : {}), inside: { container, name: inner.name, sha256: inner.sha256 } }
    remember(record)
    try { await mkdir(this.dir, { recursive: true }); await writeFile(join(this.dir, `${key}.json`), JSON.stringify(record), 'utf8'); await this.trim() } catch {}
    return { doc: record }
  }
  private async trim(): Promise<void> {
    const files = (await readdir(this.dir)).filter(f => f.endsWith('.json'))
    if (files.length <= CACHE_KEEP) return
    const aged = await Promise.all(files.map(async f => ({ f, at: (await stat(join(this.dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })))
    aged.sort((a, b) => a.at - b.at)
    for (const { f } of aged.slice(0, files.length - CACHE_KEEP)) await rm(join(this.dir, f), { force: true })
  }
}

export async function pdfPagePicture(bytes: Buffer, page: number, maxSide = 1568): Promise<{ pages: number; picture: PagePicture | null }> {
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new Error(`This file is larger than ${DOCUMENT_MAX_BYTES / 1048576} MB, so Damon does not take its pictures out.`)
  const moving = own(bytes)
  const reply = await reader.ask({ op: 'picture', bytes: moving, page, maxSide }, [moving])
  const found = reply.ok ? reply.found : undefined
  if (!found) throw new Error('The document reader gave no picture back.')
  return found
}

export async function shrinkPng(bytes: Buffer, maxSide: number): Promise<PagePicture | null> {
  if (bytes.length > DOCUMENT_MAX_BYTES) return null
  const moving = own(bytes)
  const reply = await reader.ask({ op: 'png', bytes: moving, maxSide }, [moving])
  return reply.ok ? reply.png ?? null : null
}

export async function shrinkJpeg(bytes: Buffer, maxSide: number): Promise<PagePicture | null> {
  if (bytes.length > DOCUMENT_MAX_BYTES) return null
  const moving = own(bytes)
  const reply = await reader.ask({ op: 'jpeg', bytes: moving, maxSide }, [moving]).catch(() => null)
  return reply?.ok ? reply.png ?? null : null
}

export async function innerBytes(outer: Buffer, container: 'zip' | 'msg', inside: string, maxBytes: number): Promise<{ name: string; sha256: string; bytes: Buffer }> {
  if (outer.length > CONTAINER_MAX_BYTES) throw new Error(`This file is larger than ${CONTAINER_MAX_BYTES / 1048576} MB, so Damon does not open it.`)
  const moving = own(outer)
  const reply = await reader.ask({ op: 'inner', container, bytes: moving, inside, want: 'bytes', words: false, limits: { maxPages: DOCUMENT_MAX_PAGES, maxChars: DOCUMENT_MAX_CHARS, budgetMs: DOCUMENT_BUDGET_MS }, maxBytes }, [moving])
  const inner = reply.ok ? reply.inner : undefined
  if (!inner?.bytes) throw new Error('The document reader gave nothing back.')
  return { name: inner.name, sha256: inner.sha256, bytes: Buffer.from(inner.bytes) }
}

const scanned = new Set<string>()
export async function requireReviewedTextAsync(text: string, key: string): Promise<void> {
  if (scanned.has(key)) return
  await requireReviewedTextInSlices(text)
  if (scanned.size > 500) scanned.clear()
  scanned.add(key)
}
export async function requireReviewedDocument(doc: DocumentText): Promise<void> {
  await requireReviewedTextAsync(doc.text, doc.sha256)
}

const SHOWN_KEEP_CHARS = 32_000_000
const shown = new Map<string, { text: string; note?: string; laidOut: boolean }>()
export async function shownPlainText(path: string, raw: Buffer, sha256: string): Promise<{ text: string; note?: string; laidOut: boolean }> {
  const json = /\.json$/i.test(path), key = `${sha256}:${json ? 'json' : 'text'}`
  const known = shown.get(key)
  if (known) { shown.delete(key); shown.set(key, known); return known }
  const decoded = decodePlainText(raw)
  await requireReviewedTextAsync(decoded.text, `plain:${sha256}`)
  let out: { text: string; note?: string; laidOut: boolean } = { text: decoded.text, ...(decoded.note ? { note: decoded.note } : {}), laidOut: false }
  if (json && decoded.text.length > 20000 && !decoded.text.slice(0, 20000).includes('\n')) {
    const moving = own(raw)
    const reply = await reader.ask({ op: 'layout', bytes: moving }, [moving]).catch(() => null)
    if (reply?.ok && reply.layout) { if (reply.layout.laidOut) out = { text: reply.layout.text, laidOut: true } }
    else { const here = readableText(path, decoded.text); if (here.laidOut) out = { text: here.text, laidOut: true } }
  }
  if (out.text.length <= SHOWN_KEEP_CHARS) {
    shown.set(key, out)
    let total = [...shown.values()].reduce((n, s) => n + s.text.length, 0)
    for (const [k, s] of shown) { if (total <= SHOWN_KEEP_CHARS || k === key) break; shown.delete(k); total -= s.text.length }
  }
  return out
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

export function pdfAtsHeading(doc: Pick<DocumentText, 'pages'>): string {
  return `PDF: ${plural(doc.pages, 'page')}. Text as an ATS reads it, page by page:`
}
export function documentNote(doc: DocumentText, path: string, canView: boolean): string {
  const what: Record<DocumentKind, string> = {
    pdf: `this PDF: ${doc.pagesRead} of ${plural(doc.pages, 'page')}`,
    docx: 'this Word file',
    xlsx: `this spreadsheet: ${plural(doc.pagesRead, 'sheet')}, one row per line, cells separated by tabs`,
    pptx: `this PowerPoint deck: ${doc.pagesRead} of ${plural(doc.pages, 'slide')}, each with its speaker notes`,
    epub: `this e-book: ${doc.pagesRead} of ${plural(doc.pages, 'chapter')}`,
    odt: 'this OpenDocument text',
    ods: `this OpenDocument spreadsheet: ${plural(doc.pagesRead, 'sheet')}, one row per line, cells separated by tabs`,
    odp: `this OpenDocument presentation: ${doc.pagesRead} of ${plural(doc.pages, 'slide')}`,
    rtf: 'this RTF file',
    html: 'this web page: the words a reader sees, without its markup',
    zip: 'the files in this zip archive, numbered, with their sizes',
    doc: 'this Word 97-2003 file',
    xls: `this Excel 97-2003 spreadsheet: ${plural(doc.pagesRead, 'sheet')}, one row per line, cells separated by tabs`,
    ppt: `this PowerPoint 97-2003 deck: ${doc.pagesRead} of ${plural(doc.pages, 'slide')}, each with its speaker notes`,
    msg: 'this Outlook mail: who sent it, to whom, when, the subject and its text, then its attachments by number',
    plain: 'this text file'
  }
  const where = doc.inside ? `${doc.inside.name}, inside ${path}: ` : ''
  const out = [`Text Damon took out of ${where}${what[doc.kind]}. Layout, pictures, signatures and stamps are not in it; sha256 is of ${doc.inside ? 'that file as stored inside it' : 'the file as stored'}.`]
  if (doc.kind === 'xlsx' || doc.kind === 'xls') out.push('A formula shows its last saved result; a date shows as an Excel day number (45000 is 15 March 2023).')
  if (doc.kind === 'pdf' && doc.fonts?.length) out.push(`Fonts: ${doc.fonts.join(', ')}.`)
  if (doc.kind === 'pdf' && doc.textless.length) {
    const one = doc.textless.length === 1, list = doc.textless.join(', ')
    out.push(canView
      ? `Page${one ? '' : 's'} ${list} ha${one ? 's' : 've'} no text of ${one ? 'its' : 'their'} own (probably a scan): look at ${one ? 'it' : 'them'} with view_picture, ${doc.inside ? `path "${path}", inside "${doc.inside.name}"` : `path "${path}"`} and the page number.`
      : `Page${one ? '' : 's'} ${list} ha${one ? 's' : 've'} no text of ${one ? 'its' : 'their'} own (probably a scan), and you cannot look at pictures here: say so, and ask the owner for a text copy if you need what is on ${one ? 'it' : 'them'}.`)
  }
  if ((doc.kind === 'pptx' || doc.kind === 'odp' || doc.kind === 'ppt') && doc.textless.length) out.push(`Slide${doc.textless.length === 1 ? '' : 's'} ${doc.textless.join(', ')} ha${doc.textless.length === 1 ? 's' : 've'} no text of ${doc.textless.length === 1 ? 'its' : 'their'} own (pictures only); ask the owner for a PDF of the deck if you need what is on ${doc.textless.length === 1 ? 'it' : 'them'}.`)
  if ((doc.kind === 'docx' || doc.kind === 'odt' || doc.kind === 'rtf' || doc.kind === 'doc') && doc.textless.length) out.push('It has no text of its own.')
  if (doc.kind === 'html') out.push('Read it without words: true for its markup.')
  if (doc.kind === 'zip') out.push('Damon lists an archive and does not unpack it into the project. A file marked "not opened" is not opened, for the reason given; ask the owner for it on its own if you need it.')
  if (doc.kind === 'msg' && doc.textless.length) out.push('The mail has no text of its own; what it carries is in its attachments.')
  const unit = doc.kind === 'xlsx' || doc.kind === 'ods' || doc.kind === 'xls' ? 'sheets' : doc.kind === 'pptx' || doc.kind === 'odp' || doc.kind === 'ppt' ? 'slides' : doc.kind === 'epub' ? 'chapters' : 'pages'
  if (doc.cut) out.push(`Damon stopped reading after ${doc.pagesRead} ${unit}; the rest is not in this text.`)
  return out.join(' ')
}

export function documentRefusal(path: string, e: unknown): string {
  const said = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  if (/password/i.test(said)) return `Damon could not take the text out of ${path}: it is protected with a password. Ask the owner for a copy without one.`
  if (/older than (?:Word|Excel) 97/i.test(said)) return `${path} is from before Office 97, which Damon does not read. Ask the owner to open it and save it again as .docx, .xlsx or PDF, and say what you need from it.`
  if (/\bDRM\b/.test(said)) return `${path} is a protected e-book (DRM), so Damon cannot take its text out. Ask the owner for a copy without protection, or for the part you need.`
  if (/larger than/i.test(said)) return `${path}: ${e instanceof Error ? e.message : said} Ask the owner for a smaller copy, or for the part you need.`
  if (/too many documents/i.test(said)) return `${path}: ${e instanceof Error ? e.message : said}`
  if (/stopped reading this file after/i.test(said)) return `Damon could not take the text out of ${path} in time: it took longer than ${DOCUMENT_HARD_STOP_MS / 1000} seconds. Ask the owner for a smaller copy, or for the part you need.`
  if (/document reader/i.test(said) || /ERR_WORKER|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(said)) return `Damon could not take the text out of ${path}: its own document reader stopped. This is Damon's fault, not the file's; say so in your report and carry on with what you have.`
  if (/zip bomb|^Damon does not open /i.test(e instanceof Error ? e.message : said)) return `${path}: ${e instanceof Error ? e.message : said} Ask the owner for the file on its own, or for the part you need.`
  return `Damon could not take the text out of ${path}: the file is damaged, or is not what its name says. Ask the owner for another copy.`
}
