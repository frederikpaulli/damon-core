import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { lstat as lstatAsync, readFile as readFileAsync } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInside } from './file-browser'
import { writeJson, writeJsonText } from './json-file'

type Link = { hash: string; count: number }
type Book = { version: number; projectId: string; records: unknown[] }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const parse = (text: string): any => JSON.parse(text.replace(/^\uFEFF/, ''), (key, value) => {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Unsupported history key.')
  return value
})
function archivePath(file: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid history reference.')
  const target = resolveInside(dirname(file), `${file.slice(dirname(file).length + 1)}.history/${digest}.json`)
  if (!target) throw Error('History archive uses an unsafe path.')
  return target
}

export function readHistoryData(file: string, raw: string, limit: number): Book {
  const head = parse(raw)
  if (!head || !Array.isArray(head.records)) throw Error('Invalid history.')
  const { archive, ...book } = head
  const chunks: unknown[][] = [head.records]
  const visited = new Set<string>()
  let link: Link | undefined = archive
  while (link) {
    if (!Number.isSafeInteger(link.count) || link.count < 1 || visited.has(link.hash)) throw Error('Invalid history chain.')
    visited.add(link.hash)
    const path = archivePath(file, link.hash), stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('History page needs recovery.')
    const bytes = readFileSync(path, 'utf8')
    if (hash(bytes) !== link.hash) throw Error('History page changed.')
    const page = parse(bytes)
    if (page.version !== 1 || page.projectId !== head.projectId || !Array.isArray(page.records) || page.records.length < 1 ||
      page.records.length + (page.previous?.count ?? 0) !== link.count || Object.keys(page).some(key => !['version', 'projectId', 'records', 'previous'].includes(key))) throw Error('History page identity does not match.')
    chunks.push(page.records)
    link = page.previous
  }
  return { ...book, records: chunks.reverse().flat() }
}

export interface HistoryWrite { recordsNeverChange?: boolean }
export const historyChecks = { pages: 0 }
const recordCosts = new WeakMap<object, number>()
const headTexts = new WeakMap<object, string>()
const recordText = (record: unknown, keep = false): string => {
  if (typeof record !== 'object' || record === null) return JSON.stringify(record) ?? 'null'
  let text = headTexts.get(record)
  if (text === undefined) { text = JSON.stringify(record); if (keep) headTexts.set(record, text) }
  return text
}
const recordCost = (record: unknown): number => {
  if (typeof record !== 'object' || record === null) return Buffer.byteLength(recordText(record)) + 1
  let cost = recordCosts.get(record)
  if (cost === undefined) { cost = Buffer.byteLength(recordText(record)) + 1; recordCosts.set(record, cost) }
  return cost
}
export function knownRecordText(record: unknown, text: string): void {
  if (typeof record === 'object' && record !== null && !recordCosts.has(record)) recordCosts.set(record, Buffer.byteLength(text) + 1)
}
const pageStat = (path: string): string | null => {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink() ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : null } catch { return null }
}
interface KnownPage { records: unknown[]; previous: string; digest: string; stat: string }
const knownPages = new Map<string, (KnownPage | undefined)[]>()
const samePage = (known: KnownPage | undefined, records: unknown[], previous: string): known is KnownPage =>
  !!known && known.previous === previous && known.records.length === records.length && known.records.every((r, i) => r === records[i])
const pageText = (projectId: string, records: unknown[], previous: Link | undefined): string =>
  `{"version":1,"projectId":${JSON.stringify(projectId)},"records":[${records.map(r => recordText(r)).join(',')}]${previous ? `,"previous":${JSON.stringify(previous)}` : ''}}`

export function writeHistoryData(file: string, book: Book, countLimit: number, byteLimit: number, how: HistoryWrite = {}): void {
  if (!how.recordsNeverChange) {
    knownPages.delete(file)
    writeHistoryDataInFull(file, book, countLimit, byteLimit)
    return
  }
  const chunks: unknown[][] = []
  let chunk: unknown[] = [], bytes = 0
  for (const record of book.records) {
    const cost = recordCost(record)
    if (cost > byteLimit - 4096) throw Error('One history record exceeds its storage page limit.')
    if (chunk.length && (chunk.length >= countLimit || bytes + cost > byteLimit - 4096)) {
      chunks.push(chunk); chunk = []; bytes = 0
    }
    chunk.push(record); bytes += cost
  }
  chunks.push(chunk)
  const known = knownPages.get(file) ?? []
  const pages: (KnownPage | undefined)[] = []
  let previous: Link | undefined
  for (const [i, records] of chunks.slice(0, -1).entries()) {
    const was = known[i], prev = previous?.hash ?? ''
    if (samePage(was, records, prev) && pageStat(archivePath(file, was.digest)) === was.stat) {
      pages[i] = was
      previous = { hash: was.digest, count: (previous?.count ?? 0) + records.length }
      continue
    }
    historyChecks.pages += 1
    const text = pageText(book.projectId, records, previous)
    const digest = hash(text), target = archivePath(file, digest)
    if (existsSync(target)) {
      const stat = lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > byteLimit || readFileSync(target, 'utf8') !== text) throw Error('Existing history page needs recovery.')
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeJsonText(target, text)
    }
    const stat = pageStat(target)
    pages[i] = stat ? { records, previous: prev, digest, stat } : undefined
    previous = { hash: digest, count: (previous?.count ?? 0) + records.length }
  }
  knownPages.set(file, pages)
  for (const records of chunks.slice(0, -1)) for (const r of records) if (typeof r === 'object' && r !== null) headTexts.delete(r)
  const head = chunks.at(-1)!
  if (Object.keys(book).join(',') === 'version,projectId,records' && typeof book.version === 'number' && typeof book.projectId === 'string') {
    writeJsonText(file, `{"version":${JSON.stringify(book.version)},"projectId":${JSON.stringify(book.projectId)},"records":[${head.map(r => recordText(r, true)).join(',')}]${previous ? `,"archive":${JSON.stringify(previous)}` : ''}}`)
  } else {
    writeJson(file, { ...book, records: head, ...(previous ? { archive: previous } : {}) }, false)
  }
}

function writeHistoryDataInFull(file: string, book: Book, countLimit: number, byteLimit: number): void {
  const chunks: unknown[][] = []
  let chunk: unknown[] = [], bytes = 0
  for (const record of book.records) {
    const cost = Buffer.byteLength(JSON.stringify(record)) + 1
    if (cost > byteLimit - 4096) throw Error('One history record exceeds its storage page limit.')
    if (chunk.length && (chunk.length >= countLimit || bytes + cost > byteLimit - 4096)) {
      chunks.push(chunk); chunk = []; bytes = 0
    }
    chunk.push(record); bytes += cost
  }
  chunks.push(chunk)
  let previous: Link | undefined
  for (const records of chunks.slice(0, -1)) {
    historyChecks.pages += 1
    const page = { version: 1, projectId: book.projectId, records, ...(previous ? { previous } : {}) }
    const text = JSON.stringify(page)
    const digest = hash(text), target = archivePath(file, digest)
    if (existsSync(target)) {
      const stat = lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > byteLimit || readFileSync(target, 'utf8') !== text) throw Error('Existing history page needs recovery.')
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeJson(target, page, false)
    }
    previous = { hash: digest, count: (previous?.count ?? 0) + records.length }
  }
  writeJson(file, { ...book, records: chunks.at(-1)!, ...(previous ? { archive: previous } : {}) }, false)
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function textSha256InSlices(text: string): Promise<string> {
  const bytes = Buffer.from(text, 'utf8'), h = createHash('sha256')
  for (let i = 0; i < bytes.length; i += 1024 * 1024) {
    h.update(bytes.subarray(i, i + 1024 * 1024))
    if (i + 1024 * 1024 < bytes.length) await turn()
  }
  return h.digest('hex')
}
export async function readHistoryDataAsync(file: string, raw: string, limit: number): Promise<Book> {
  const head = parse(raw)
  if (!head || !Array.isArray(head.records)) throw Error('Invalid history.')
  const { archive, ...book } = head
  const chunks: unknown[][] = [head.records]
  const visited = new Set<string>()
  let link: Link | undefined = archive
  while (link) {
    if (!Number.isSafeInteger(link.count) || link.count < 1 || visited.has(link.hash)) throw Error('Invalid history chain.')
    visited.add(link.hash)
    const path = archivePath(file, link.hash), stat = await lstatAsync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('History page needs recovery.')
    const bytes = await readFileAsync(path, 'utf8')
    if (await textSha256InSlices(bytes) !== link.hash) throw Error('History page changed.')
    const page = parse(bytes)
    if (page.version !== 1 || page.projectId !== head.projectId || !Array.isArray(page.records) || page.records.length < 1 ||
      page.records.length + (page.previous?.count ?? 0) !== link.count || Object.keys(page).some(key => !['version', 'projectId', 'records', 'previous'].includes(key))) throw Error('History page identity does not match.')
    chunks.push(page.records)
    link = page.previous
    await turn()
  }
  return { ...book, records: chunks.reverse().flat() }
}
