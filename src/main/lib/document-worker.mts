import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { crc32, inflateSync } from 'node:zlib'
import { Inflate, unzipSync } from 'fflate'
import jpegJs from 'jpeg-js'

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'odt' | 'ods' | 'odp' | 'rtf' | 'html' | 'zip' | 'doc' | 'xls' | 'ppt' | 'msg' | 'plain'
export interface ReadLimits { maxPages: number; maxChars: number; budgetMs: number }
export interface DocumentBody {
  pages: number
  pagesRead: number
  text: string
  textless: number[]
  cut: boolean
  fonts?: string[]
}
export interface PagePicture { pixels: Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 }

const TEXTLESS_CHARS = 20
const FONT_PAGES = 3
const OFFICE_PART_MAX_BYTES = 30 * 1024 * 1024
const PICTURE_MAX_PIXELS = 60_000_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function xmlText(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_whole: string, e: string) =>
    e.startsWith('#') ? String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]!)
}
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

export function docxXmlText(xml: string): string {
  return xmlText(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function officeParts(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, string> {
  let tooBig = false
  const files = unzipSync(bytes, { filter: file => {
    if (!wanted(file.name)) return false
    if (file.originalSize > OFFICE_PART_MAX_BYTES) { tooBig = true; return false }
    return true
  } })
  if (tooBig) throw new Error('A part of this file is larger than Damon reads.')
  const decoder = new TextDecoder('utf-8')
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]))
}

export async function pdfText(bytes: Uint8Array, limits: ReadLimits): Promise<DocumentBody> {
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 })
  const started = Date.now()
  try {
    const last = Math.min(pdf.numPages, limits.maxPages)
    const pages: string[] = [], textless: number[] = [], fonts = new Set<string>()
    let chars = 0, cut = last < pdf.numPages
    for (let n = 1; n <= last; n++) {
      if (Date.now() - started > limits.budgetMs) { cut = true; break }
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      const text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('').trim()
      if (n <= FONT_PAGES) await namePdfFonts(page, content.items, fonts)
      page.cleanup()
      if (text.length < TEXTLESS_CHARS) textless.push(n)
      pages.push(`--- page ${n} ---\n${text}`)
      chars += text.length
      if (chars > limits.maxChars) { cut = true; break }
    }
    return { pages: pdf.numPages, pagesRead: pages.length, text: pages.join('\n\n').slice(0, limits.maxChars), textless, cut, fonts: [...fonts] }
  } finally { await pdf.loadingTask.destroy().catch(() => undefined) }
}

interface FontPage { getOperatorList(): Promise<unknown>; commonObjs: { has(id: string): boolean; get(id: string): unknown } }
async function namePdfFonts(page: FontPage, items: unknown[], into: Set<string>): Promise<void> {
  const ids = new Set(items.map(item => (item as { fontName?: unknown }).fontName).filter((id): id is string => typeof id === 'string'))
  if (!ids.size) return
  try { await page.getOperatorList() } catch { return }
  for (const id of ids) {
    try {
      if (!page.commonObjs.has(id)) continue
      const name = (page.commonObjs.get(id) as { name?: unknown } | null)?.name
      if (typeof name === 'string' && name.trim()) into.add(name.trim().replace(/^[A-Z]{6}\+/, ''))
    } catch {}
  }
}

export function docxText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const xml = officeParts(bytes, name => name === 'word/document.xml')['word/document.xml']
  if (xml === undefined) throw new Error('This Word file has no document body.')
  const text = docxXmlText(xml)
  return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: text.length < TEXTLESS_CHARS ? [1] : [], cut: text.length > limits.maxChars }
}

function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
function sheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cell[1]!, body = cell[2] ?? ''
      const ref = attr(head, 'r'), type = attr(head, 't')
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const inline = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
      const text = type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? xmlText(inline) : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : xmlText(value ?? '')
      const at = ref ? columnIndex(ref) : cells.length
      while (cells.length < at) cells.push('')
      cells[at] = text.replace(/[\t\r\n]+/g, ' ')
    }
    rows.push(cells.join('\t').replace(/\t+$/, ''))
  }
  return rows
}
export function xlsxText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const parts = officeParts(bytes, name => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name))
  const shared = [...(parts['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText([...m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')))
  const targets = new Map<string, string>([...(parts['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m): [string, string] => {
    const target = attr(m[0], 'Target') ?? ''
    return [attr(m[0], 'Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`]
  }))
  const sheets = [...(parts['xl/workbook.xml'] ?? '').matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: xmlText(attr(m[0], 'name') ?? 'Sheet'), part: targets.get(attr(m[0], 'r:id') ?? '') }))
  const text = sheets.map(sheet => `--- sheet ${sheet.name} ---\n${sheetRows(sheet.part ? parts[sheet.part] ?? '' : '', shared).join('\n')}`).join('\n\n')
  return { pages: sheets.length, pagesRead: sheets.length, text: text.slice(0, limits.maxChars), textless: [], cut: text.length > limits.maxChars }
}

const relTargets = (xml: string, base: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target')
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue
    out.set(id, partPath(base, target))
  }
  return out
}
function partPath(base: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/')
  const out: string[] = []
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
  return out.join('/')
}
function drawingText(xml: string): string {
  const lines: string[] = []
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = ''
    for (const m of p[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>|<a:tab\b[^>]*\/>/g)) line += m[1] !== undefined ? xmlText(m[1]) : m[0].startsWith('<a:br') ? '\n' : '\t'
    if (line.trim()) lines.push(line.trimEnd())
  }
  return lines.join('\n')
}
const blank = (text: string): boolean => !text.trim()

export function pptxText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const parts = officeParts(bytes, name => name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/.test(name) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
  const rels = relTargets(parts['ppt/_rels/presentation.xml.rels'] ?? '', 'ppt/')
  const listed = [...(parts['ppt/presentation.xml'] ?? '').matchAll(/<p:sldId\b[^>]*>/g)].map(m => rels.get(attr(m[0], 'r:id') ?? '')).filter((p): p is string => !!p && p in parts)
  const number = (name: string): number => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  const slides = listed.length ? listed : Object.keys(parts).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => number(a) - number(b))
  if (!slides.length) throw new Error('This PowerPoint file has no slides.')
  const blocks: string[] = [], textless: number[] = []
  let chars = 0, cut = slides.length > limits.maxPages
  for (let i = 0; i < Math.min(slides.length, limits.maxPages); i++) {
    const slide = slides[i]!
    const own = drawingText(parts[slide] ?? '')
    const notesPart = [...relTargets(parts[slide.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels'] ?? '', 'ppt/slides/').values()].find(t => /notesSlide\d+\.xml$/.test(t))
    const notes = notesPart ? drawingText(parts[notesPart] ?? '') : ''
    if (blank(own)) textless.push(i + 1)
    const block = `--- slide ${i + 1} ---\n${own}${notes.trim() ? `\n(notes) ${notes}` : ''}`
    blocks.push(block); chars += block.length
    if (chars > limits.maxChars) { cut = true; break }
  }
  const text = blocks.join('\n\n')
  return { pages: slides.length, pagesRead: blocks.length, text: text.slice(0, limits.maxChars), textless, cut: cut || text.length > limits.maxChars }
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function htmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, code: string) => {
    if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? whole
    const n = code[1]!.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    try { return String.fromCodePoint(n) } catch { return whole }
  })
}
export function htmlText(html: string, withTitle = true): string {
  const title = withTitle ? htmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim() : ''
  const words = htmlEntities(html
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title ? `${title}\n\n${words}` : words
}
function decodeHtml(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const label = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(head)?.[1]
  try { return new TextDecoder(label ?? 'utf-8').decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}
function htmlDocument(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const text = htmlText(decodeHtml(bytes))
  return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: blank(text) ? [1] : [], cut: text.length > limits.maxChars }
}

export function epubText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const head = officeParts(bytes, name => name === 'META-INF/container.xml' || name === 'META-INF/encryption.xml')
  const opfPath = /<rootfile\b[^>]*full-path="([^"]+)"/.exec(head['META-INF/container.xml'] ?? '')?.[1]
  if (!opfPath) throw new Error('This e-book has no table of contents.')
  if ([...(head['META-INF/encryption.xml'] ?? '').matchAll(/<(?:enc:)?CipherReference\b[^>]*URI="([^"]+)"/g)].some(m => /\.x?html?$/i.test(m[1]!))) throw new Error('This e-book is protected (DRM), so its text cannot be read.')
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opf = officeParts(bytes, name => name === opfPath)[opfPath] ?? ''
  const manifest = new Map<string, string>()
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = attr(m[0], 'id'), href = attr(m[0], 'href')
    if (!id || !href) continue
    let decoded = href.split('#')[0]!
    try { decoded = decodeURIComponent(decoded) } catch {}
    manifest.set(id, partPath(base, decoded))
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/g)].map(m => manifest.get(attr(m[0], 'idref') ?? '')).filter((p): p is string => !!p)
  if (!spine.length) throw new Error('This e-book has no chapters.')
  const wanted = new Set(spine.slice(0, limits.maxPages))
  const docs = officeParts(bytes, name => wanted.has(name))
  const title = htmlEntities(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? '').trim()
  const blocks: string[] = title ? [`Title: ${title}`] : []
  const textless: number[] = []
  let chars = 0, read = 0, cut = spine.length > limits.maxPages
  for (let i = 0; i < Math.min(spine.length, limits.maxPages); i++) {
    const words = htmlText(docs[spine[i]!] ?? '', false)
    if (blank(words)) textless.push(i + 1)
    blocks.push(`--- chapter ${i + 1} ---\n${words}`); read += 1; chars += words.length
    if (chars > limits.maxChars) { cut = true; break }
  }
  const text = blocks.join('\n\n')
  return { pages: spine.length, pagesRead: read, text: text.slice(0, limits.maxChars), textless, cut: cut || text.length > limits.maxChars }
}

function odfInline(xml: string): string {
  return xmlText(xml
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<text:s\b([^>]*)\/>/g, (_whole: string, attrs: string) => ' '.repeat(Math.min(Number(attr(` ${attrs}`, 'text:c') ?? '1') || 1, 100)))
    .replace(/<[^>]+>/g, ''))
}
function odfParagraphs(xml: string): string {
  return odfInline(xml.replace(/<\/text:(?:p|h)>/g, '\n').replace(/<text:(?:p|h)\b[^>]*\/>/g, '\n'))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
const REPEAT_MAX = 50
function odsRows(xml: string): string[] {
  const rows: string[] = []
  for (const row of xml.matchAll(/<table:table-row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const cells: string[] = []
    for (const cell of (row[2] ?? '').matchAll(/<table:(?:covered-)?table-cell(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const value = odfParagraphs(cell[2] ?? '').replace(/[\t\r\n]+/g, ' ')
      const times = Math.max(1, Number(attr(cell[1]!, 'table:number-columns-repeated') ?? '1') || 1)
      for (let k = 0; k < (value ? Math.min(times, REPEAT_MAX) : 1); k++) cells.push(value)
    }
    const line = cells.join('\t').replace(/\t+$/, '')
    if (!line) { if (rows.length && rows[rows.length - 1] !== '') rows.push(''); continue }
    const times = Math.max(1, Number(attr(row[1]!, 'table:number-rows-repeated') ?? '1') || 1)
    for (let k = 0; k < Math.min(times, REPEAT_MAX); k++) rows.push(line)
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows
}
export function odfText(kind: 'odt' | 'ods' | 'odp', bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const xml = officeParts(bytes, name => name === 'content.xml')['content.xml']
  if (xml === undefined) throw new Error('This OpenDocument file has no content.')
  if (kind === 'odt') {
    const text = odfParagraphs(/<office:text\b[^>]*>([\s\S]*)<\/office:text>/.exec(xml)?.[1] ?? xml)
    return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: blank(text) ? [1] : [], cut: text.length > limits.maxChars }
  }
  const units = kind === 'odp'
    ? [...xml.matchAll(/<draw:page(?=[\s>])[^>]*>([\s\S]*?)<\/draw:page>/g)].map((m, i) => ({ head: `--- slide ${i + 1} ---`, body: odfParagraphs(m[1]!) }))
    : [...xml.matchAll(/<table:table(?=[\s>])([^>]*)>([\s\S]*?)<\/table:table>/g)].map(m => ({ head: `--- sheet ${xmlText(attr(m[1]!, 'table:name') ?? 'Sheet')} ---`, body: odsRows(m[2]!).join('\n') }))
  const blocks: string[] = [], textless: number[] = []
  let chars = 0, cut = units.length > limits.maxPages
  for (let i = 0; i < Math.min(units.length, limits.maxPages); i++) {
    const unit = units[i]!
    if (kind === 'odp' && blank(unit.body)) textless.push(i + 1)
    const block = `${unit.head}\n${unit.body}`
    blocks.push(block); chars += block.length
    if (chars > limits.maxChars) { cut = true; break }
  }
  const text = blocks.join('\n\n')
  return { pages: units.length, pagesRead: blocks.length, text: text.slice(0, limits.maxChars), textless, cut: cut || text.length > limits.maxChars }
}

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'fldinst', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'pgdsctbl', 'revtbl', 'filetbl', 'nonshppict', 'shppict'])
const RTF_CHARS: Record<string, string> = { par: '\n', line: '\n', sect: '\n\n', page: '\n\n', row: '\n', cell: '\t', tab: '\t', emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ' }
const RTF_WORD = /([a-zA-Z]{1,32})(-?\d{1,10})? ?/y
export function rtfText(raw: string, maxChars: number): string {
  if (!raw.startsWith('{\\rtf')) throw new Error('This RTF file does not start the way RTF does.')
  const cp1252 = new TextDecoder('windows-1252')
  const out: string[] = []
  let size = 0, pendingSkip = 0, atGroupStart = false
  let group = { skip: false, uc: 1 }
  const stack: { skip: boolean; uc: number }[] = []
  const emit = (s: string): void => {
    if (group.skip) return
    if (pendingSkip > 0) { const n = Math.min(pendingSkip, s.length); pendingSkip -= n; s = s.slice(n); if (!s) return }
    out.push(s); size += s.length
  }
  let i = 0
  while (i < raw.length && size <= maxChars) {
    const ch = raw[i]!
    if (ch === '{') { stack.push(group); group = { ...group }; atGroupStart = true; i++; continue }
    if (ch === '}') { group = stack.pop() ?? { skip: false, uc: 1 }; atGroupStart = false; pendingSkip = 0; i++; continue }
    if (ch === '\r' || ch === '\n') { i++; continue }
    if (ch !== '\\') { emit(ch); atGroupStart = false; i++; continue }
    const next = raw[i + 1] ?? ''
    if (next === '\\' || next === '{' || next === '}') { emit(next); atGroupStart = false; i += 2; continue }
    if (next === '*') { group.skip = true; i += 2; continue }
    if (next === "'") { emit(cp1252.decode(Uint8Array.of(parseInt(raw.slice(i + 2, i + 4), 16) || 0x3f))); atGroupStart = false; i += 4; continue }
    if (next === '~') { emit(' '); i += 2; continue }
    if (next === '-' || next === '\r' || next === '\n') { i += 2; continue }
    if (next === '_') { emit('-'); i += 2; continue }
    RTF_WORD.lastIndex = i + 1
    const m = RTF_WORD.exec(raw)
    if (!m) { i += 2; continue }
    i = RTF_WORD.lastIndex
    const word = m[1]!, num = m[2] !== undefined ? Number(m[2]) : undefined
    if (atGroupStart && RTF_SKIP.has(word)) group.skip = true
    atGroupStart = false
    if (word === 'bin' && num) { i += num; continue }
    if (word === 'uc' && num !== undefined) { group.uc = num; continue }
    if (word === 'u' && num !== undefined) { emit(String.fromCharCode(num < 0 ? num + 65536 : num)); pendingSkip = group.uc; continue }
    const mapped = RTF_CHARS[word]
    if (mapped) emit(mapped)
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars)
}
function rtfDocument(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const text = rtfText(new TextDecoder('latin1').decode(bytes), limits.maxChars)
  return { pages: 1, pagesRead: 1, text, textless: blank(text) ? [1] : [], cut: text.length >= limits.maxChars }
}

export const ZIP_MAX_ENTRIES = 5000
export const ZIP_ENTRY_MAX_BYTES = 25 * 1024 * 1024
export interface ZipEntry { index: number; name: string; size: number; packed: number; folder: boolean; problem: string | null; method: number; offset: number; crc: number }
const NESTED = /\.(?:zip|7z|rar|gz|tgz|tar|bz2|xz|cab|iso|jar|apk)$/i
export const sizeWords = (n: number): string => n < 1024 ? `${n} bytes` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`
export function zipEntries(bytes: Uint8Array): { entries: ZipEntry[]; more: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) if (v.getUint32(at, true) === 0x06054b50) { eocd = at; break }
  if (eocd < 0) throw new Error('This zip archive is damaged: its table of contents is missing.')
  let count = v.getUint16(eocd + 10, true), cd = v.getUint32(eocd + 16, true)
  if ((count === 0xffff || cd === 0xffffffff) && eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) {
    const z = Number(v.getBigUint64(eocd - 12, true))
    if (z + 56 > bytes.length || v.getUint32(z, true) !== 0x06064b50) throw new Error('This zip archive is damaged.')
    count = Number(v.getBigUint64(z + 32, true)); cd = Number(v.getBigUint64(z + 48, true))
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true }), win = new TextDecoder('windows-1252')
  const entries: ZipEntry[] = []
  let at = cd
  for (let i = 0; i < Math.min(count, ZIP_MAX_ENTRIES); i++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50) throw new Error('This zip archive is damaged.')
    const madeBy = v.getUint16(at + 4, true), flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true), crc = v.getUint32(at + 16, true)
    let packed = v.getUint32(at + 20, true), size = v.getUint32(at + 24, true), offset = v.getUint32(at + 42, true)
    const nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true), external = v.getUint32(at + 38, true)
    const raw = bytes.subarray(at + 46, at + 46 + nameLen)
    let name: string
    try { name = utf8.decode(raw) } catch { name = flags & 0x800 ? '' : win.decode(raw) }
    for (let e = at + 46 + nameLen; e + 4 <= at + 46 + nameLen + extraLen;) {
      const id = v.getUint16(e, true), len = v.getUint16(e + 2, true)
      if (id === 0x0001) {
        let p = e + 4
        if (size === 0xffffffff) { size = Number(v.getBigUint64(p, true)); p += 8 }
        if (packed === 0xffffffff) { packed = Number(v.getBigUint64(p, true)); p += 8 }
        if (offset === 0xffffffff) offset = Number(v.getBigUint64(p, true))
      }
      e += 4 + len
    }
    const folder = name.endsWith('/') || name.endsWith('\\')
    const problem =
      !name || /[\u0000-\u001f]/.test(name) ? 'its name is not one Damon opens'
      : /^(?:[\\/]|[A-Za-z]:)/.test(name) || name.split(/[\\/]/).includes('..') ? 'its name points outside the archive (a trick, not a file)'
      : (madeBy >> 8) === 3 && ((external >>> 16) & 0o170000) === 0o120000 ? 'it is a link, not a file'
      : flags & 1 ? 'it is protected with a password'
      : method !== 0 && method !== 8 ? `it is packed in a way Damon does not unpack (method ${method})`
      : folder ? null
      : NESTED.test(name) ? 'it is an archive inside the archive; Damon opens one level'
      : size > ZIP_ENTRY_MAX_BYTES ? `it unpacks to ${Math.round(size / 1048576)} MB, more than the ${ZIP_ENTRY_MAX_BYTES / 1048576} MB Damon unpacks`
      : null
    entries.push({ index: i + 1, name, size, packed, folder, problem, method, offset, crc })
    at += 46 + nameLen + extraLen + commentLen
  }
  return { entries, more: Math.max(0, count - ZIP_MAX_ENTRIES) }
}
export function zipEntryBytes(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.problem || entry.folder) throw new Error(`Damon does not open ${entry.name}: ${entry.problem ?? 'it is a folder'}.`)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length || v.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('This zip archive is damaged.')
  const start = entry.offset + 30 + v.getUint16(entry.offset + 26, true) + v.getUint16(entry.offset + 28, true)
  if (start + entry.packed > bytes.length) throw new Error('This zip archive is damaged.')
  const packed = bytes.subarray(start, start + entry.packed)
  let out: Uint8Array
  if (entry.method === 0) out = packed
  else {
    out = new Uint8Array(entry.size)
    let filled = 0
    const inflater = new Inflate((chunk: Uint8Array) => {
      if (filled + chunk.length > entry.size) throw new Error(`${entry.name} unpacks to more than its header says (a zip bomb), so Damon stopped.`)
      out.set(chunk, filled); filled += chunk.length
    })
    for (let i = 0; i < packed.length; i += 65536) inflater.push(packed.subarray(i, i + 65536), i + 65536 >= packed.length)
    if (!packed.length) inflater.push(new Uint8Array(0), true)
    if (filled !== entry.size) throw new Error('This zip archive is damaged.')
  }
  if (out.length !== entry.size || crc32(out) >>> 0 !== entry.crc >>> 0) throw new Error('This zip archive is damaged.')
  return out
}
export function zipListing(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const { entries, more } = zipEntries(bytes)
  const files = entries.filter(e => !e.folder).length + more
  const lines = entries.map(e => `${e.index}. ${e.name}${e.folder ? ' (folder)' : ` (${sizeWords(e.size)})`}${e.problem ? `; not opened: ${e.problem}` : ''}`)
  const text = `--- archive: ${files} file${files === 1 ? '' : 's'}${more ? `, ${more} of them not listed` : ''} ---\n${lines.join('\n')}`
  return { pages: entries.length + more, pagesRead: entries.length, text: text.slice(0, limits.maxChars), textless: [], cut: more > 0 || text.length > limits.maxChars }
}

export const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const NO_STREAM = 0xffffffff
const CFB_MAX_ENTRIES = 20_000
const CFB_MAX_DEPTH = 12
export interface Cfb { paths: string[]; stream: (path: string) => Uint8Array | null }
const damaged = (): Error => new Error('This old Office file is damaged.')
export function readCfb(bytes: Uint8Array): Cfb {
  if (bytes.length < 512 || OLE_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('This is not an old Office file inside.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (at: number): number => view.getUint32(at, true)
  const shift = view.getUint16(0x1e, true)
  if (shift !== 9 && shift !== 12) throw damaged()
  const size = 1 << shift, per = size / 4
  const sectors = Math.ceil((bytes.length - size) / size)
  const word = (sector: number, i: number): number => {
    if (sector >= sectors) throw damaged()
    const at = (sector + 1) * size + i * 4
    if (at + 4 > bytes.length) throw damaged()
    return u32(at)
  }
  const fatCount = u32(0x2c)
  if (fatCount > sectors) throw damaged()
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(u32(0x4c + i * 4))
  for (let d = u32(0x44), hops = 0; fatSectors.length < fatCount; hops++) {
    if (hops > sectors) throw damaged()
    for (let i = 0; i < per - 1 && fatSectors.length < fatCount; i++) fatSectors.push(word(d, i))
    d = word(d, per - 1)
  }
  const fat = new Uint32Array(fatCount * per)
  fatSectors.forEach((sector, k) => { for (let i = 0; i < per; i++) fat[k * per + i] = word(sector, i) })
  const chain = (start: number, table: Uint32Array): number[] => {
    const out: number[] = []
    for (let n = start; n !== END_OF_CHAIN; n = table[n]!) {
      if (n >= table.length || out.length >= table.length) throw damaged()
      out.push(n)
    }
    return out
  }
  const regular = (start: number, length: number): Uint8Array => {
    const list = length === 0 ? [] : chain(start, fat)
    if (length > list.length * size) throw damaged()
    const out = new Uint8Array(length)
    for (let k = 0; k < list.length && k * size < length; k++) {
      const from = (list[k]! + 1) * size
      out.set(bytes.subarray(from, from + Math.min(size, length - k * size)), k * size)
    }
    return out
  }
  const dirStart = u32(0x30)
  const dir = regular(dirStart, chain(dirStart, fat).length * size)
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const names = new TextDecoder('utf-16le')
  interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const entries: Entry[] = []
  for (let i = 0; i < Math.min(Math.floor(dir.length / 128), CFB_MAX_ENTRIES); i++) {
    const o = i * 128
    const nameBytes = Math.min(dv.getUint16(o + 0x40, true), 64)
    entries.push({ name: names.decode(dir.subarray(o, o + Math.max(0, nameBytes - 2))), type: dir[o + 0x42]!, left: dv.getUint32(o + 0x44, true), right: dv.getUint32(o + 0x48, true), child: dv.getUint32(o + 0x4c, true), start: dv.getUint32(o + 0x74, true), size: dv.getUint32(o + 0x78, true) + (shift === 12 ? dv.getUint32(o + 0x7c, true) * 2 ** 32 : 0) })
  }
  const root = entries[0]
  if (!root || root.type !== 5) throw damaged()
  const cutoff = u32(0x38)
  let miniStream: Uint8Array | undefined, miniFat: Uint32Array | undefined
  const mini = (start: number, length: number): Uint8Array => {
    if (!miniStream) {
      if (root.size > bytes.length) throw damaged()
      miniStream = regular(root.start, root.size)
      const raw = u32(0x40) ? regular(u32(0x3c), chain(u32(0x3c), fat).length * size) : new Uint8Array(0)
      miniFat = new Uint32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4))
    }
    const list = length === 0 ? [] : chain(start, miniFat!)
    if (length > list.length * 64) throw damaged()
    const out = new Uint8Array(length)
    for (let k = 0; k < list.length && k * 64 < length; k++) out.set(miniStream.subarray(list[k]! * 64, list[k]! * 64 + Math.min(64, length - k * 64)), k * 64)
    return out
  }
  const byPath = new Map<string, Entry>()
  const named: string[] = []
  const seen = new Set<number>([0])
  const visit = (first: number, prefix: string, depth: number): void => {
    if (depth > CFB_MAX_DEPTH) throw damaged()
    const todo = [first]
    while (todo.length) {
      const n = todo.pop()!
      if (n === NO_STREAM) continue
      if (n >= entries.length || seen.has(n)) throw damaged()
      seen.add(n)
      const e = entries[n]!
      todo.push(e.left, e.right)
      if (e.type !== 1 && e.type !== 2) continue
      const path = prefix + e.name
      byPath.set(path.toLowerCase(), e); named.push(path)
      if (e.type === 1) visit(e.child, `${path}/`, depth + 1)
    }
  }
  visit(root.child, '', 0)
  return {
    paths: named,
    stream: (path: string): Uint8Array | null => {
      const e = byPath.get(path.toLowerCase())
      if (!e || e.type !== 2) return null
      if (e.size > bytes.length) throw damaged()
      return e.size < cutoff ? mini(e.start, e.size) : regular(e.start, e.size)
    }
  }
}

const cp1252 = new TextDecoder('windows-1252')
const utf16le = new TextDecoder('utf-16le')
const CP1252 = Array.from(cp1252.decode(Uint8Array.from({ length: 256 }, (_, i) => i)), ch => ch.charCodeAt(0))

export function docText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const cfb = readCfb(bytes)
  const word = cfb.stream('WordDocument')
  if (!word || word.length < 0x01aa) throw new Error('This Word file has no document body.')
  const w = new DataView(word.buffer, word.byteOffset, word.byteLength)
  if (w.getUint16(0, true) !== 0xa5ec || w.getUint16(2, true) < 0x00c1) throw new Error('This Word file is older than Word 97, which Damon does not read.')
  const flags = w.getUint16(0x0a, true)
  if (flags & 0x0100) throw new Error('This Word file is protected with a password.')
  const table = cfb.stream(flags & 0x0200 ? '1Table' : '0Table')
  if (!table) throw damaged()
  const counts = [0x4c, 0x50, 0x54, 0x5c, 0x60, 0x64, 0x68].map(at => w.getInt32(at, true))
  const fcClx = w.getUint32(0x01a2, true), lcbClx = w.getUint32(0x01a6, true)
  if (fcClx + lcbClx > table.length) throw damaged()
  const t = new DataView(table.buffer, table.byteOffset, table.byteLength)
  let at = fcClx
  while (at < fcClx + lcbClx && table[at] === 0x01) at += 3 + t.getInt16(at + 1, true)
  if (table[at] !== 0x02) throw damaged()
  const lcb = t.getUint32(at + 1, true), plc = at + 5
  if (plc + lcb > table.length || lcb < 4) throw damaged()
  const pieces = Math.floor((lcb - 4) / 12)
  const total = counts.reduce((a, b) => a + Math.max(0, b), 0) + 1
  const parts: string[] = []
  let chars = 0
  for (let i = 0; i < pieces && chars < total; i++) {
    const cpStart = t.getUint32(plc + i * 4, true), cpEnd = t.getUint32(plc + (i + 1) * 4, true)
    const fc = t.getUint32(plc + (pieces + 1) * 4 + i * 8 + 2, true)
    const length = Math.max(0, Math.min(cpEnd - cpStart, total - chars))
    const compressed = (fc & 0x40000000) !== 0, offset = compressed ? (fc & 0x3fffffff) / 2 : fc & 0x3fffffff
    const end = offset + length * (compressed ? 1 : 2)
    if (end > word.length) throw damaged()
    parts.push(compressed ? cp1252.decode(word.subarray(offset, end)) : utf16le.decode(word.subarray(offset, end)))
    chars += length
  }
  const all = parts.join('')
  const names = ['', 'footnotes', 'headers and footers', 'comments', 'endnotes', 'text boxes', 'text boxes in headers']
  const blocks: string[] = []
  let from = 0
  counts.forEach((count, k) => {
    const part = wordClean(all.slice(from, from + Math.max(0, count)))
    from += Math.max(0, count)
    if (k === 0) blocks.push(part)
    else if (part.trim() && k !== 2 && k !== 6) blocks.push(`--- ${names[k]} ---\n${part}`)
  })
  const text = blocks.join('\n\n').trim()
  return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: text ? [] : [1], cut: text.length > limits.maxChars }
}
function wordClean(raw: string): string {
  let out = '', codes = 0
  const stack: boolean[] = []
  for (const ch of raw) {
    const c = ch.charCodeAt(0)
    if (c === 0x13) { stack.push(true); codes += 1; continue }
    if (c === 0x14) { if (stack.length && stack[stack.length - 1]) { stack[stack.length - 1] = false; codes -= 1 } continue }
    if (c === 0x15) { if (stack.length && stack.pop()) codes -= 1; continue }
    if (codes > 0) continue
    if (c === 0x0d || c === 0x0b) out += '\n'
    else if (c === 0x0c) out += '\n\n'
    else if (c === 0x07) out += '\t'
    else if (c === 0x1e) out += '-'
    else if (c === 0xa0) out += ' '
    else if (c >= 0x20 || c === 0x09) out += ch
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function xlsText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const cfb = readCfb(bytes)
  const book = cfb.stream('Workbook')
  if (!book) throw new Error(cfb.stream('Book') ? 'This Excel file is older than Excel 97, which Damon does not read.' : 'This Excel file has no workbook.')
  const v = new DataView(book.buffer, book.byteOffset, book.byteLength)
  interface Rec { type: number; at: number; data: Uint8Array }
  const recs: Rec[] = []
  for (let at = 0; at + 4 <= book.length;) {
    const type = v.getUint16(at, true), len = v.getUint16(at + 2, true)
    if (at + 4 + len > book.length) break
    recs.push({ type, at, data: book.subarray(at + 4, at + 4 + len) })
    at += 4 + len
  }
  const dvOf = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength)
  if (recs[0]?.type !== 0x0809 || recs[0].data.length < 2 || dvOf(recs[0].data).getUint16(0, true) !== 0x0600) throw new Error('This Excel file is older than Excel 97, which Damon does not read.')
  if (recs.some(r => r.type === 0x002f)) throw new Error('This Excel file is protected with a password.')
  const shortString = (d: Uint8Array, at: number, wide16: boolean): string => {
    const cch = wide16 ? dvOf(d).getUint16(at, true) : d[at]!
    const flags = d[at + (wide16 ? 2 : 1)]!, from = at + (wide16 ? 3 : 2)
    return flags & 1 ? utf16le.decode(d.subarray(from, from + cch * 2)) : cp1252.decode(d.subarray(from, from + cch))
  }
  const sheets: { name: string; at: number; worksheet: boolean }[] = []
  for (const r of recs) if (r.type === 0x0085) sheets.push({ name: shortString(r.data, 6, false), at: dvOf(r.data).getUint32(0, true), worksheet: r.data[5] === 0 })
  const sst: string[] = []
  const sstAt = recs.findIndex(r => r.type === 0x00fc)
  if (sstAt >= 0) {
    const segs = [recs[sstAt]!.data]
    for (let k = sstAt + 1; k < recs.length && recs[k]!.type === 0x003c; k++) segs.push(recs[k]!.data)
    let seg = 0, pos = 8
    const unique = dvOf(segs[0]!).getUint32(4, true)
    const byte = (): number => { while (seg < segs.length && pos >= segs[seg]!.length) { seg += 1; pos = 0 } if (seg >= segs.length) throw damaged(); return segs[seg]![pos++]! }
    const u16 = (): number => byte() | byte() << 8
    const i32 = (): number => (byte() | byte() << 8 | byte() << 16 | byte() << 24) | 0
    const skip = (n: number): void => { for (let k = 0; k < n; k++) byte() }
    try {
      for (let s = 0; s < unique && s < 2_000_000; s++) {
        const cch = u16(), flags = byte()
        const runs = flags & 0x08 ? u16() : 0
        const ext = flags & 0x04 ? i32() : 0
        let wide = (flags & 1) === 1
        const codes: number[] = []
        for (let k = 0; k < cch; k++) {
          if (seg < segs.length && pos >= segs[seg]!.length) { seg += 1; pos = 0; wide = (byte() & 1) === 1 }
          codes.push(wide ? u16() : CP1252[byte()]!)
        }
        sst.push(String.fromCharCode(...codes))
        skip(runs * 4 + Math.max(0, ext))
      }
    } catch {}
  }
  const number = (x: number): string => Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(15)))
  const rk = (raw: number): string => {
    let x: number
    if (raw & 2) x = (raw | 0) >> 2
    else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, raw & 0xfffffffc, true); x = b.getFloat64(0, true) }
    return number(raw & 1 ? x / 100 : x)
  }
  const ERRORS: Record<number, string> = { 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A' }
  const blocks: string[] = []
  let chars = 0, cut = false, read = 0
  const worksheets = sheets.filter(s => s.worksheet)
  for (const sheet of worksheets) {
    if (read >= limits.maxPages || chars > limits.maxChars) { cut = true; break }
    const start = recs.findIndex(r => r.at === sheet.at)
    if (start < 0) continue
    const rows = new Map<number, string[]>()
    const put = (row: number, col: number, text: string): void => { if (col > 16383) return; const cells = rows.get(row) ?? []; while (cells.length < col) cells.push(''); cells[col] = text.replace(/[\t\r\n]+/g, ' '); rows.set(row, cells) }
    let pendingFormula: { row: number; col: number } | null = null
    for (let k = start + 1; k < recs.length && recs[k]!.type !== 0x000a; k++) {
      const { type, data } = recs[k]!
      if (data.length < 6 && type !== 0x0207) continue
      const d = dvOf(data)
      if (type === 0x00fd) put(d.getUint16(0, true), d.getUint16(2, true), sst[d.getUint32(6, true)] ?? '')
      else if (type === 0x0203) put(d.getUint16(0, true), d.getUint16(2, true), number(d.getFloat64(6, true)))
      else if (type === 0x027e) put(d.getUint16(0, true), d.getUint16(2, true), rk(d.getUint32(6, true)))
      else if (type === 0x00bd) { const row = d.getUint16(0, true), first = d.getUint16(2, true); for (let i = 0; 4 + i * 6 + 6 <= data.length - 2; i++) put(row, first + i, rk(d.getUint32(4 + i * 6 + 2, true))) }
      else if (type === 0x0204) put(d.getUint16(0, true), d.getUint16(2, true), shortString(data, 6, true))
      else if (type === 0x0205) put(d.getUint16(0, true), d.getUint16(2, true), data[7] ? ERRORS[data[6]!] ?? '#ERROR' : data[6] ? 'TRUE' : 'FALSE')
      else if (type === 0x0006) {
        const row = d.getUint16(0, true), col = d.getUint16(2, true)
        if (d.getUint16(12, true) !== 0xffff) put(row, col, number(d.getFloat64(6, true)))
        else if (data[6] === 0) pendingFormula = { row, col }
        else if (data[6] === 1) put(row, col, data[8] ? 'TRUE' : 'FALSE')
        else if (data[6] === 2) put(row, col, ERRORS[data[8]!] ?? '#ERROR')
        continue
      } else if (type === 0x0207 && pendingFormula) put(pendingFormula.row, pendingFormula.col, shortString(data, 0, true))
      pendingFormula = null
    }
    const lines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells.join('\t').replace(/\t+$/, ''))
    const block = `--- sheet ${sheet.name} ---\n${lines.join('\n')}`
    blocks.push(block); chars += block.length; read += 1
  }
  const text = blocks.join('\n\n')
  return { pages: worksheets.length, pagesRead: read, text: text.slice(0, limits.maxChars), textless: [], cut: cut || read < worksheets.length || text.length > limits.maxChars }
}

export function pptText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const cfb = readCfb(bytes)
  const doc = cfb.stream('PowerPoint Document'), user = cfb.stream('Current User')
  if (!doc || !user || user.length < 20) throw new Error('This PowerPoint file has no slides.')
  const d = new DataView(doc.buffer, doc.byteOffset, doc.byteLength)
  const head = (at: number): { ver: number; inst: number; type: number; len: number } => {
    if (at + 8 > doc.length) throw damaged()
    const vi = d.getUint16(at, true)
    return { ver: vi & 0x0f, inst: vi >> 4, type: d.getUint16(at + 2, true), len: d.getUint32(at + 4, true) }
  }
  const u = new DataView(user.buffer, user.byteOffset, user.byteLength)
  if (u.getUint32(12, true) === 0xf3d1c4df) throw new Error('This PowerPoint file is protected with a password.')
  const persist = new Map<number, number>()
  let docRef = 0
  for (let edit = u.getUint32(16, true), hops = 0; edit && hops < 1000; hops++) {
    let last = 0
    try {
      const h = head(edit)
      if (h.type !== 0x0ff5) throw damaged()
      if (!docRef) docRef = d.getUint32(edit + 24, true)
      last = d.getUint32(edit + 16, true)
      const dirAt = d.getUint32(edit + 20, true), dh = head(dirAt)
      if (dh.type !== 0x1772) throw damaged()
      for (let at = dirAt + 8; at + 4 <= Math.min(dirAt + 8 + dh.len, doc.length);) {
        const entry = d.getUint32(at, true), first = entry & 0xfffff, count = entry >>> 20
        for (let k = 0; k < count && at + 8 + k * 4 <= doc.length; k++) if (!persist.has(first + k)) persist.set(first + k, d.getUint32(at + 4 + k * 4, true))
        at += 4 + count * 4
      }
    } catch (e) {
      if (hops === 0) throw e
      break
    }
    edit = last
  }
  const docAt = persist.get(docRef)
  if (docAt === undefined || head(docAt).type !== 0x03e8) throw damaged()
  const children = (at: number): number[] => {
    const h = head(at), out: number[] = []
    for (let c = at + 8; c + 8 <= at + 8 + h.len && c + 8 <= doc.length; c += 8 + head(c).len) out.push(c)
    return out
  }
  const atomText = (at: number): string | null => {
    const h = head(at), body = doc.subarray(at + 8, at + 8 + h.len)
    if (h.type === 0x0fa0) return utf16le.decode(body)
    if (h.type === 0x0fa8) return new TextDecoder('latin1').decode(body)
    return null
  }
  const textIn = (at: number, depth = 0): string[] => {
    if (depth > 12) return []
    const out: string[] = []
    for (const c of children(at)) {
      const t = atomText(c)
      if (t !== null) out.push(t)
      else if (head(c).ver === 0x0f) out.push(...textIn(c, depth + 1))
    }
    return out
  }
  const lists = children(docAt).filter(c => head(c).type === 0x0ff0)
  const outline = new Map<number, string[]>()
  const order: number[] = []
  const notesById = new Map<number, number>()
  for (const list of lists) {
    const inst = head(list).inst
    if (inst === 2) { for (const c of children(list)) if (head(c).type === 0x03f3) notesById.set(d.getUint32(c + 20, true), d.getUint32(c + 8, true)); continue }
    if (inst !== 0) continue
    let current: number | null = null
    for (const c of children(list)) {
      if (head(c).type === 0x03f3) { current = d.getUint32(c + 8, true); order.push(current); outline.set(current, []) }
      else if (current !== null) { const t = atomText(c); if (t !== null) outline.get(current)!.push(t) }
    }
  }
  if (!order.length) throw new Error('This PowerPoint file has no slides.')
  const clean = (parts: string[]): string => parts.join('\n').replace(/\r|\v/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const blocks: string[] = [], textless: number[] = []
  let chars = 0, cut = order.length > limits.maxPages
  for (let i = 0; i < Math.min(order.length, limits.maxPages); i++) {
    const ref = order[i]!, at = persist.get(ref)
    const own = at !== undefined && head(at).type === 0x03ee ? textIn(at) : []
    const slideText = clean([...outline.get(ref)!, ...own])
    let notes = ''
    if (at !== undefined) {
      const atom = children(at).find(c => head(c).type === 0x03ef)
      const notesId = atom ? d.getUint32(atom + 8 + 16, true) : 0
      const notesRef = notesId ? notesById.get(notesId) : undefined
      const notesAt = notesRef !== undefined ? persist.get(notesRef) : undefined
      if (notesAt !== undefined && head(notesAt).type === 0x03f0) notes = clean(textIn(notesAt).filter(t => t.trim() !== '*'))
    }
    if (!slideText) textless.push(i + 1)
    const block = `--- slide ${i + 1} ---\n${slideText}${notes ? `\n(notes) ${notes}` : ''}`
    blocks.push(block); chars += block.length
    if (chars > limits.maxChars) { cut = true; break }
  }
  const text = blocks.join('\n\n')
  return { pages: order.length, pagesRead: blocks.length, text: text.slice(0, limits.maxChars), textless, cut: cut || text.length > limits.maxChars }
}

export interface MailAttachment { index: number; name: string; size: number; mail: boolean }
export interface Mail { from: string; to: string; cc: string; sent: string; subject: string; body: string; attachments: MailAttachment[] }
const CODEPAGES: Record<number, string> = { 65001: 'utf-8', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874', 20866: 'koi8-r', 21866: 'koi8-u', 28591: 'iso-8859-1', 28592: 'iso-8859-2', 28595: 'iso-8859-5', 28597: 'iso-8859-7', 28605: 'iso-8859-15', 50220: 'iso-2022-jp', 51932: 'euc-jp' }
const decoderFor = (codepage: number): TextDecoder => {
  try { return new TextDecoder(CODEPAGES[codepage] ?? (codepage >= 1250 && codepage <= 1258 ? `windows-${codepage}` : 'windows-1252')) } catch { return cp1252 }
}
const ATTACHED = /^__attach_version1\.0_#([0-9A-F]{8})$/i
function attachmentStorages(cfb: Cfb, prefix: string): string[] {
  return cfb.paths.filter(p => p.startsWith(prefix) && ATTACHED.test(p.slice(prefix.length)))
    .sort((a, b) => parseInt(ATTACHED.exec(a.slice(prefix.length))![1]!, 16) - parseInt(ATTACHED.exec(b.slice(prefix.length))![1]!, 16))
}
const RTF_PREFIX = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx'
export function decompressRtf(data: Uint8Array, maxBytes: number): string {
  if (data.length < 16) throw damaged()
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const rawSize = v.getUint32(4, true), kind = v.getUint32(8, true)
  const latin1 = new TextDecoder('latin1')
  if (kind === 0x414c454d) return latin1.decode(data.subarray(16, 16 + Math.min(rawSize, maxBytes)))
  if (kind !== 0x75465a4c) throw damaged()
  const dict = new Uint8Array(4096)
  for (let i = 0; i < RTF_PREFIX.length; i++) dict[i] = RTF_PREFIX.charCodeAt(i)
  let write = RTF_PREFIX.length
  const out: number[] = []
  const limit = Math.min(rawSize, maxBytes)
  let at = 16
  while (at < data.length && out.length < limit) {
    const control = data[at++]!
    for (let bit = 0; bit < 8 && at < data.length && out.length < limit; bit++) {
      if (control & (1 << bit)) {
        if (at + 1 >= data.length) return latin1.decode(Uint8Array.from(out))
        const ref = data[at]! << 8 | data[at + 1]!; at += 2
        const offset = ref >> 4, length = (ref & 0x0f) + 2
        if (offset === write) return latin1.decode(Uint8Array.from(out))
        for (let k = 0; k < length && out.length < limit; k++) { const b = dict[(offset + k) % 4096]!; out.push(b); dict[write] = b; write = (write + 1) % 4096 }
      } else {
        const b = data[at++]!; out.push(b); dict[write] = b; write = (write + 1) % 4096
      }
    }
  }
  return latin1.decode(Uint8Array.from(out))
}
export function readMailAt(cfb: Cfb, prefix: string, maxChars: number): Mail {
  if (!cfb.paths.some(p => p.startsWith(prefix) && /^__substg1\.0_/i.test(p.slice(prefix.length)))) throw new Error('This is not an Outlook mail inside.')
  const props = cfb.stream(`${prefix}__properties_version1.0`)
  const top = prefix ? 24 : 32
  const fixed = (id: number, type: number): DataView | null => {
    if (!props) return null
    const v = new DataView(props.buffer, props.byteOffset, props.byteLength)
    for (let at = top; at + 16 <= props.length; at += 16) if (v.getUint16(at + 2, true) === id && v.getUint16(at, true) === type) return new DataView(props.buffer, props.byteOffset + at + 8, 8)
    return null
  }
  const ansi = decoderFor(fixed(0x3ffd, 0x0003)?.getUint32(0, true) ?? fixed(0x3fde, 0x0003)?.getUint32(0, true) ?? 1252)
  const prop = (at: string, id: number): string => {
    const hex = id.toString(16).toUpperCase().padStart(4, '0')
    const wide = cfb.stream(`${at}__substg1.0_${hex}001F`)
    if (wide) return utf16le.decode(wide).replace(/\u0000+$/, '')
    const narrow = cfb.stream(`${at}__substg1.0_${hex}001E`)
    return narrow ? ansi.decode(narrow).replace(/\u0000+$/, '') : ''
  }
  const binary = (at: string, id: number): Uint8Array | null => cfb.stream(`${at}__substg1.0_${id.toString(16).toUpperCase().padStart(4, '0')}0102`)
  let sent = ''
  for (const id of [0x0039, 0x0e06]) {
    const t = fixed(id, 0x0040)
    if (!t || sent) continue
    const ms = (t.getUint32(0, true) + t.getUint32(4, true) * 2 ** 32) / 10_000 - 11_644_473_600_000
    if (Number.isFinite(ms) && ms > 0) sent = new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  }
  const senderName = prop(prefix, 0x0c1a)
  const senderEmail = [0x5d01, 0x5d02, 0x0c1f, 0x0065].map(id => prop(prefix, id)).find(e => e.includes('@') && !e.startsWith('/')) ?? ''
  let body = prop(prefix, 0x1000)
  if (!body.trim()) {
    const html = binary(prefix, 0x1013)
    if (html) {
      const meta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(new TextDecoder('latin1').decode(html.subarray(0, 2048)))?.[1]
      let decoder = ansi
      try { if (meta) decoder = new TextDecoder(meta) } catch {}
      body = htmlText(decoder.decode(html), false)
    } else body = htmlText(prop(prefix, 0x1013), false)
  }
  if (!body.trim()) {
    const rtf = binary(prefix, 0x1009)
    if (rtf) try { body = rtfText(decompressRtf(rtf, maxChars * 4), maxChars) } catch { body = '' }
  }
  const attachments = attachmentStorages(cfb, prefix).map((path, k): MailAttachment => {
    const at = `${path}/`
    const mail = cfb.paths.some(p => p.toLowerCase() === `${at}__substg1.0_3701000d`.toLowerCase())
    const name = prop(at, 0x3707) || prop(at, 0x3704) || prop(at, 0x3001) || `attachment ${k + 1}`
    return { index: k + 1, name: mail && !/\.msg$/i.test(name) ? `${name}.msg` : name, size: binary(at, 0x3701)?.length ?? 0, mail }
  })
  const from = senderName && senderEmail && senderName !== senderEmail ? `${senderName} <${senderEmail}>` : senderName || senderEmail
  return { from, to: prop(prefix, 0x0e04), cc: prop(prefix, 0x0e03), sent, subject: prop(prefix, 0x0037), body: body.replace(/\r\n?/g, '\n').slice(0, maxChars), attachments }
}
export function mailAttachment(cfb: Cfb, prefix: string, index: number): { bytes: Uint8Array } | { mailAt: string } | null {
  const path = attachmentStorages(cfb, prefix)[index - 1]
  if (!path) return null
  const nested = cfb.paths.find(p => p.toLowerCase() === `${path}/__substg1.0_3701000d`.toLowerCase())
  if (nested) return { mailAt: `${nested}/` }
  const bytes = cfb.stream(`${path}/__substg1.0_37010102`)
  return bytes ? { bytes } : null
}
export function mailBody(mail: Mail, limits: ReadLimits): DocumentBody {
  const lines = [`From: ${mail.from || '(not stated)'}`, `To: ${mail.to || '(not stated)'}`, ...(mail.cc ? [`Cc: ${mail.cc}`] : []), `Sent: ${mail.sent || '(not stated)'}`, `Subject: ${mail.subject}`,
    `Attachments: ${mail.attachments.length ? mail.attachments.map(a => `${a.index}. ${a.name} (${a.mail ? 'a mail' : sizeWords(a.size)})`).join(', ') : 'none'}`]
  const body = mail.body.trim()
  const text = `${lines.join('\n')}\n\n${body}`
  return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: body ? [] : [1], cut: text.length > limits.maxChars }
}
export function mailText(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  return mailBody(readMailAt(readCfb(bytes), '', limits.maxChars), limits)
}

type InnerKind = Exclude<DocumentKind, 'zip'>
export function plainDocument(bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  const text = plainText(bytes)
  return { pages: 1, pagesRead: 1, text: text.slice(0, limits.maxChars), textless: text.trim() ? [] : [1], cut: text.length > limits.maxChars }
}
function innerKind(name: string, bytes: Uint8Array, words: boolean): InnerKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  const zip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const ole = bytes.length > 8 && OLE_SIGNATURE.every((b, i) => bytes[i] === b)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  if (ext === 'pdf' && head.includes('%PDF-')) return 'pdf'
  if (zip && (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'epub' || ext === 'odt' || ext === 'ods' || ext === 'odp')) return ext
  const old = ext === 'doc' || ext === 'dot' ? 'doc' : ext === 'xls' || ext === 'xlt' ? 'xls' : ext === 'ppt' || ext === 'pps' || ext === 'pot' ? 'ppt' : ext === 'msg' ? 'msg' : null
  if (old && ole) return old
  if (old && old !== 'msg' && zip) return `${old}x` as InnerKind
  if (ext === 'rtf' && head.startsWith('{\\rtf')) return 'rtf'
  if (words && (ext === 'html' || ext === 'htm') && !bytes.subarray(0, 4096).includes(0)) return 'html'
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  if (/\.(?:zip|7z|rar|gz|tgz|tar)$/i.test(name)) return null
  if (utf16 || !bytes.subarray(0, 8192).includes(0)) return 'plain'
  return null
}
const pick = <T extends { index: number; name: string }>(items: T[], asked: string): T | undefined => {
  const n = /^#(\d+)$/.exec(asked)?.[1]
  return n ? items.find(i => i.index === Number(n)) : items.find(i => i.name === asked) ?? items.find(i => i.name.toLowerCase() === asked.toLowerCase())
}
function innerFile(container: 'zip' | 'msg', bytes: Uint8Array, inside: string, maxChars: number): { name: string; bytes: Uint8Array } | { name: string; mail: Mail } {
  if (container === 'zip') {
    const entry = pick(zipEntries(bytes).entries, inside)
    if (!entry) throw new Error(`Damon does not open ${inside}: there is no such file in this archive. Read the archive without inside for its list.`)
    return { name: entry.name, bytes: zipEntryBytes(bytes, entry) }
  }
  const cfb = readCfb(bytes)
  const parts = inside.split('/')
  if (parts.length > 3) throw new Error(`Damon does not open ${inside}: it reads attachments three mails deep at most.`)
  let prefix = ''
  for (let depth = 0; depth < parts.length; depth++) {
    const att = pick(readMailAt(cfb, prefix, maxChars).attachments, parts[depth]!)
    if (!att) throw new Error(`Damon does not open ${inside}: the mail has no attachment by that name. Read the mail without inside for its list.`)
    const found = mailAttachment(cfb, prefix, att.index)
    if (!found) throw new Error(`Damon does not open ${att.name}: the attachment holds no file (a link or an embedded object).`)
    const last = depth === parts.length - 1
    if ('bytes' in found) {
      if (!last) throw new Error(`Damon does not open ${inside}: ${att.name} is a file, not a mail.`)
      if (/\.(?:zip|7z|rar|gz|tgz|tar)$/i.test(att.name)) throw new Error(`Damon does not open ${att.name}: it is an archive attached to the mail; ask the owner for it on its own.`)
      return { name: att.name, bytes: found.bytes }
    }
    if (last) return { name: att.name, mail: readMailAt(cfb, found.mailAt, maxChars) }
    prefix = found.mailAt
  }
  throw new Error(`Damon does not open ${inside}.`)
}

function textOf(kind: Exclude<DocumentKind, 'pdf'>, bytes: Uint8Array, limits: ReadLimits): DocumentBody {
  switch (kind) {
    case 'docx': return docxText(bytes, limits)
    case 'xlsx': return xlsxText(bytes, limits)
    case 'pptx': return pptxText(bytes, limits)
    case 'epub': return epubText(bytes, limits)
    case 'odt': case 'ods': case 'odp': return odfText(kind, bytes, limits)
    case 'rtf': return rtfDocument(bytes, limits)
    case 'html': return htmlDocument(bytes, limits)
    case 'zip': return zipListing(bytes, limits)
    case 'doc': return docText(bytes, limits)
    case 'xls': return xlsText(bytes, limits)
    case 'ppt': return pptText(bytes, limits)
    case 'msg': return mailText(bytes, limits)
    case 'plain': return plainDocument(bytes, limits)
  }
}

export function shrinkPicture(p: PagePicture, maxSide: number): PagePicture {
  const scale = maxSide / Math.max(p.width, p.height)
  if (scale >= 1) return p
  const w = Math.max(1, Math.round(p.width * scale)), h = Math.max(1, Math.round(p.height * scale)), c = p.channels
  const out = new Uint8ClampedArray(w * h * c)
  for (let ty = 0; ty < h; ty++) {
    const sy0 = Math.floor((ty * p.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * p.height) / h))
    for (let tx = 0; tx < w; tx++) {
      const sx0 = Math.floor((tx * p.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * p.width) / w))
      const n = (sy1 - sy0) * (sx1 - sx0)
      for (let k = 0; k < c; k++) {
        let sum = 0
        for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) sum += p.pixels[(sy * p.width + sx) * c + k]!
        out[(ty * w + tx) * c + k] = Math.round(sum / n)
      }
    }
  }
  return { pixels: out, width: w, height: h, channels: c }
}

const PNG_MAX_PIXELS = 25_000_000
const paeth = (a: number, b: number, c: number): number => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
export function decodePng(bytes: Uint8Array): PagePicture | null {
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8, width = 0, height = 0, depth = 0, type = -1, interlace = 0
  const data: Uint8Array[] = []
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at), name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    if (name === 'IHDR') { width = view.getUint32(at + 8); height = view.getUint32(at + 12); depth = bytes[at + 16]!; type = bytes[at + 17]!; interlace = bytes[at + 20]! }
    else if (name === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length))
    else if (name === 'IEND') break
    at += 12 + length
  }
  const channels = type === 0 ? 1 : type === 2 ? 3 : type === 6 ? 4 : 0
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height || width * height > PNG_MAX_PIXELS) return null
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const out = new Uint8ClampedArray(stride * height)
  let previous = new Uint8Array(stride), pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!
    const line = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const v = raw[pos + x]!, a = x >= channels ? line[x - channels]! : 0, b = previous[x]!, c = x >= channels ? previous[x - channels]! : 0
      line[x] = filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : v
    }
    pos += stride
    out.set(line, y * stride)
    previous = line
  }
  return { pixels: out, width, height, channels: channels as 1 | 3 | 4 }
}

export async function pdfPicture(bytes: Uint8Array, page: number, maxSide: number): Promise<{ pages: number; picture: PagePicture | null }> {
  const { getDocumentProxy, extractImages } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 })
  try {
    if (page > pdf.numPages) return { pages: pdf.numPages, picture: null }
    const images = await extractImages(pdf, page)
    const largest = [...images].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (!largest) return { pages: pdf.numPages, picture: null }
    if (largest.width * largest.height > PICTURE_MAX_PIXELS) throw new Error('The picture on this page is larger than Damon opens.')
    return { pages: pdf.numPages, picture: shrinkPicture({ pixels: largest.data, width: largest.width, height: largest.height, channels: largest.channels }, maxSide) }
  } finally { await pdf.loadingTask.destroy().catch(() => undefined) }
}

export function decodeJpeg(bytes: Uint8Array): PagePicture | null {
  const out = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 25, maxMemoryUsageInMB: 352, tolerantDecoding: true })
  if (!out.width || !out.height) return null
  return { pixels: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.byteLength), width: out.width, height: out.height, channels: 3 }
}

export function plainText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2)
    for (let i = 2; i + 1 < bytes.length; i += 2) { swapped[i - 2] = bytes[i + 1]!; swapped[i - 1] = bytes[i]! }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}
export function layOutJson(text: string): { text: string; laidOut: boolean } {
  if (text.length <= 20000 || text.slice(0, 20000).includes('\n')) return { text, laidOut: false }
  try { return { text: JSON.stringify(JSON.parse(text), null, 1), laidOut: true } } catch { return { text, laidOut: false } }
}

export type ReaderRequest =
  | { id: number; op: 'text'; kind: DocumentKind; bytes: ArrayBuffer; limits: ReadLimits }
  | { id: number; op: 'picture'; bytes: ArrayBuffer; page: number; maxSide: number }
  | { id: number; op: 'png'; bytes: ArrayBuffer; maxSide: number }
  | { id: number; op: 'jpeg'; bytes: ArrayBuffer; maxSide: number }
  | { id: number; op: 'layout'; bytes: ArrayBuffer }
  | { id: number; op: 'inner'; container: 'zip' | 'msg'; bytes: ArrayBuffer; inside: string; want: 'text' | 'bytes'; words: boolean; limits: ReadLimits; maxBytes: number }
export type ReaderReply =
  | { id: number; ok: true; body?: DocumentBody; found?: { pages: number; picture: PagePicture | null }; png?: PagePicture | null; layout?: { text: string; laidOut: boolean }; inner?: { name: string; sha256: string; kind?: DocumentKind; body?: DocumentBody; bytes?: ArrayBuffer; head?: Uint8Array } }
  | { id: number; ok: false; error: { name: string; message: string } }

if (!isMainThread && parentPort && (workerData as { damon?: string } | null)?.damon === 'documents') {
  const port = parentPort
  port.on('message', (m: ReaderRequest) => {
    void (async () => {
      try {
        const bytes = new Uint8Array(m.bytes)
        if (m.op === 'text') {
          const body = m.kind === 'pdf' ? await pdfText(bytes, m.limits) : textOf(m.kind, bytes, m.limits)
          port.postMessage({ id: m.id, ok: true, body } satisfies ReaderReply)
          return
        }
        if (m.op === 'layout') {
          port.postMessage({ id: m.id, ok: true, layout: layOutJson(plainText(bytes)) } satisfies ReaderReply)
          return
        }
        if (m.op === 'inner') {
          const found = innerFile(m.container, bytes, m.inside, m.limits.maxChars)
          if ('mail' in found) {
            if (m.want === 'bytes') throw new Error(`Damon does not open ${found.name} as a file: it is a mail attached to the mail. Read it with read_project_file and inside.`)
            const body = mailBody(found.mail, m.limits)
            port.postMessage({ id: m.id, ok: true, inner: { name: found.name, sha256: createHash('sha256').update(body.text).digest('hex'), kind: 'msg', body } } satisfies ReaderReply)
            return
          }
          const sha256 = createHash('sha256').update(found.bytes).digest('hex')
          if (m.want === 'bytes') {
            if (found.bytes.length > m.maxBytes) throw new Error(`Damon does not open ${found.name}: it is larger than ${Math.round(m.maxBytes / 1048576)} MB.`)
            const copy = new Uint8Array(found.bytes).buffer as ArrayBuffer
            port.postMessage({ id: m.id, ok: true, inner: { name: found.name, sha256, bytes: copy } } satisfies ReaderReply, [copy])
            return
          }
          const kind = innerKind(found.name, found.bytes, m.words)
          if (!kind) { port.postMessage({ id: m.id, ok: true, inner: { name: found.name, sha256, head: found.bytes.slice(0, 8192) } } satisfies ReaderReply); return }
          const body = kind === 'pdf' ? await pdfText(new Uint8Array(found.bytes), m.limits) : textOf(kind, found.bytes, m.limits)
          port.postMessage({ id: m.id, ok: true, inner: { name: found.name, sha256, kind, body } } satisfies ReaderReply)
          return
        }
        if (m.op === 'jpeg') {
          const decoded = decodeJpeg(bytes)
          const small = decoded ? shrinkPicture(decoded, m.maxSide) : null
          const png = small ? { ...small, pixels: new Uint8ClampedArray(small.pixels) } : null
          port.postMessage({ id: m.id, ok: true, png } satisfies ReaderReply, png ? [png.pixels.buffer as ArrayBuffer] : [])
          return
        }
        if (m.op === 'png') {
          const decoded = decodePng(bytes)
          const small = decoded ? shrinkPicture(decoded, m.maxSide) : null
          const png = small ? { ...small, pixels: new Uint8ClampedArray(small.pixels) } : null
          port.postMessage({ id: m.id, ok: true, png } satisfies ReaderReply, png ? [png.pixels.buffer as ArrayBuffer] : [])
          return
        }
        const found = await pdfPicture(bytes, m.page, m.maxSide)
        const picture = found.picture ? { ...found.picture, pixels: new Uint8ClampedArray(found.picture.pixels) } : null
        port.postMessage({ id: m.id, ok: true, found: { pages: found.pages, picture } } satisfies ReaderReply, picture ? [picture.pixels.buffer as ArrayBuffer] : [])
      } catch (e) {
        const error = e instanceof Error ? { name: e.name, message: e.message.slice(0, 500) } : { name: 'Error', message: String(e).slice(0, 500) }
        port.postMessage({ id: m.id, ok: false, error } satisfies ReaderReply)
      }
    })()
  })
}
