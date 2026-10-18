import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { noteRunning } from './freeze-watch'

let tellSomeone: ((file: string, keptAt: string) => void) | null = null

export function onUnreadableFile(fn: (file: string, keptAt: string) => void): void {
  tellSomeone = fn
}

const unreadable = new Set<string>()
const heldFiles = new Map<string, string>()
const heldToldOn = new Map<string, string>()
let tellLocked: ((file: string, heldAt?: string) => void) | null = null

export function onLockedStore(fn: (file: string, heldAt?: string) => void): void {
  tellLocked = fn
}

export function isHeld(file: string): boolean {
  return unreadable.has(file)
}

export function forgetLockedStores(): void {
  unreadable.clear()
  heldFiles.clear()
  heldToldOn.clear()
}

const MISSING = new Set(['ENOENT', 'ENOTDIR'])
const READ_TRIES = 5
const READ_PAUSE_MS = 200

function tellOf(file: string, heldAt?: string): void {
  try {
    tellLocked?.(file, heldAt)
  } catch {
  }
}

const CORRUPT_SUFFIX = '.corrupt-'

export function corruptCopiesOf(file: string): string[] {
  try {
    const name = basename(file)
    return readdirSync(dirname(file))
      .filter((f) => f.startsWith(name + CORRUPT_SUFFIX))
      .sort()
      .map((f) => join(dirname(file), f))
  } catch {
    return []
  }
}

export function readJson<T>(file: string, fallback: T): T {
  if (unreadable.has(file)) {
    const heldAt = heldFiles.get(file)
    if (heldAt) {
      try {
        return JSON.parse(readFileSync(heldAt, 'utf8').replace(/^﻿/, '')) as T
      } catch {
      }
    }
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T
    } catch {
      return fallback
    }
  }
  let raw: string | undefined
  for (let attempt = 0; raw === undefined; attempt++) {
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code ?? ''
      if (MISSING.has(code)) return fallback
      if (attempt + 1 >= READ_TRIES) {
        unreadable.add(file)
        tellOf(file)
        return fallback
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_PAUSE_MS)
    }
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, '')) as T
  } catch {
    keepACopy(file, raw)
    return fallback
  }
}

function keepACopy(file: string, raw: string): void {
  let keptAt = ''
  try {
    const existing = corruptCopiesOf(file).find(copy => {
      try { return readFileSync(copy, 'utf8') === raw } catch { return false }
    })
    if (existing) {
      keptAt = existing
    } else {
      keptAt = `${file}${CORRUPT_SUFFIX}${Date.now()}-${createHash('sha256').update(raw).digest('hex')}`
      if (existsSync(file)) copyFileSync(file, keptAt)
      else writeFileSync(keptAt, raw, 'utf8')
    }
  } catch {
  }
  try {
    tellSomeone?.(file, keptAt)
  } catch {
  }
}

export function writeJson(file: string, value: unknown, pretty = true): void {
  writeJsonText(file, JSON.stringify(value, null, pretty ? 2 : undefined))
}
export function writeJsonText(file: string, text: string): void {
  noteRunning(`write:${basename(file)}`)
  if (unreadable.has(file)) {
    writeHeld(file, text)
    return
  }
  writeReal(file, text)
}

function writeHeld(file: string, text: string): void {
  let heldAt = heldFiles.get(file)
  if (!heldAt) {
    heldAt = `${file}.held-${Date.now()}.json`
    heldFiles.set(file, heldAt)
    console.warn(`[json-file] ${file} could not be opened at startup; changes this run are kept beside it at ${heldAt}`)
  }
  try {
    writeReal(heldAt, text)
  } catch (err) {
    console.warn(`[json-file] could not keep the held copy of ${file}:`, err)
  }
  const today = new Date().toISOString().slice(0, 10)
  if (heldToldOn.get(file) !== today) {
    heldToldOn.set(file, today)
    tellOf(file, heldAt)
  }
}

function writeReal(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  let last: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err) {
      last = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
  }
  throw last
}
