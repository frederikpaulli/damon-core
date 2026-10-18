import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs'
import { extname, join, resolve, sep, relative, isAbsolute } from 'node:path'
export { RUNNABLE, safeToOpen } from '../../shared/openable'

export interface FileNode {
  name: string
  rel: string
  kind: 'file' | 'dir'
  children?: FileNode[]
}

const IGNORED = new Set([
  '.git',
  'node_modules',
  '.damon',
  'out',
  'release',
  'target',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.next',
  'coverage'
])
const MAX_DEPTH = 6
const MAX_NODES = 500
const MAX_READ_BYTES = 512 * 1024

export function listFiles(root: string): FileNode[] {
  const budget = { left: MAX_NODES }
  return listDir(root, '', 0, budget)
}

function listDir(root: string, rel: string, depth: number, budget: { left: number }): FileNode[] {
  if (depth > MAX_DEPTH || budget.left <= 0) return []
  let entries: string[]
  try {
    entries = readdirSync(join(root, rel))
  } catch {
    return []
  }

  const dirs: FileNode[] = []
  const files: FileNode[] = []
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (IGNORED.has(name)) continue
    if (budget.left <= 0) break
    const childRel = rel ? join(rel, name) : name
    try {
      const target = resolveInside(root, childRel)
      if (!target) continue
      const stat = lstatSync(target)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue
      budget.left -= 1
      if (stat.isDirectory()) {
        dirs.push({ name, rel: childRel, kind: 'dir', children: listDir(root, childRel, depth + 1, budget) })
      } else {
        files.push({ name, rel: childRel, kind: 'file' })
      }
    } catch {
    }
  }
  return [...dirs, ...files]
}

export type ReadResult =
  | { ok: true; media: import('./media-preview').MediaPreview }
  | { ok: true; content: string; html?: string }
  | { ok: true; image: string }
  | { ok: false; reason: string }

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

export function resolveInside(root: string, rel: string): string | null {
  if (/[\x00-\x1f:]/.test(rel)) return null
  const abs = resolve(root, rel)
  const rootAbs = resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null
  try {
    const canonicalRoot = realpathSync(rootAbs)
    let current = rootAbs
    for (const part of relative(rootAbs, abs).split(sep).filter(Boolean)) {
      current = join(current, part)
      try {
        if (lstatSync(current).isSymbolicLink()) return null
        const actual = relative(canonicalRoot, realpathSync(current))
        if (actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual)) return null
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; return null }
    }
    return abs
  } catch { return null }
}

export function readFileSafe(root: string, rel: string): ReadResult {
  const abs = resolveInside(root, rel)
  if (abs === null) {
    return { ok: false, reason: 'That file is outside the project folder.' }
  }

  let size: number
  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return { ok: false, reason: 'That path is not a regular file.' }
    size = stat.size
  } catch {
    return { ok: false, reason: 'That file could not be found.' }
  }
  if (size > MAX_READ_BYTES) {
    return { ok: false, reason: 'This file is too big to show here. Open it in its own program instead.' }
  }

  try {
    const buf = readFileSync(abs)
    if (buf.length > MAX_READ_BYTES) return { ok: false, reason: 'This file is too big to show here.' }
    const type = IMAGE_TYPES[extname(abs).toLowerCase()]
    if (type) {
      return { ok: true, image: `data:${type};base64,${buf.toString('base64')}` }
    }
    if (buf.includes(0)) {
      return { ok: false, reason: 'Damon cannot show this kind of file. Open it in its own program instead.' }
    }
    return { ok: true, content: buf.toString('utf8') }
  } catch {
    return { ok: false, reason: 'That file could not be read.' }
  }
}
