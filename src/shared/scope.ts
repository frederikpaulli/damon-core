export const ANY = '**'

function tidy(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

const compiled = new Map<string, RegExp>()
export function globToRegExp(pattern: string): RegExp {
  const known = compiled.get(pattern)
  if (known) return known
  if (compiled.size > 5000) compiled.clear()
  const made = buildGlob(pattern)
  compiled.set(pattern, made)
  return made
}
function buildGlob(pattern: string): RegExp {
  const p = tidy(pattern)
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

export function matchesScope(scope: string[], file: string): boolean {
  const f = tidy(file)
  return scope.some((p) => globToRegExp(p).test(f) || (!tidy(p).endsWith('**') && !LOOKS_LIKE_A_FILE.test(tidy(p)) && globToRegExp(`${tidy(p)}/**`).test(f)))
}

export function normaliseDrive(p: string): string {
  return p.replace(/^([A-Za-z])\/(?=[^/])/, (_m, d: string) => d.toUpperCase() + ':/')
}
export function isProjectRelative(file: string): boolean {
  const f = tidy(file)
  return !!f && !/^[A-Za-z]:/.test(f) && !f.startsWith('/') && f !== '..' && !f.startsWith('../')
}
export function relativeTo(root: string, file: string): string {
  const r = normaliseDrive(tidy(root)).toLowerCase()
  const f = normaliseDrive(tidy(file))
  if (!r) return f
  const lower = f.toLowerCase()
  if (lower === r) return ''
  if (lower.startsWith(r + '/')) return f.slice(r.length + 1)
  return f
}

function onlyStars(s: string, from: number): boolean {
  for (let i = from; i < s.length; i++) if (s[i] !== '*') return false
  return true
}

function namesIntersect(a: string, b: string): boolean {
  const p = a.toLowerCase()
  const q = b.toLowerCase()
  const memo = new Map<number, boolean>()
  const step = (i: number, j: number): boolean => {
    const key = i * (q.length + 1) + j
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let out: boolean
    if (i === p.length && j === q.length) out = true
    else if (i === p.length) out = onlyStars(q, j)
    else if (j === q.length) out = onlyStars(p, i)
    else if (p[i] === '*') out = step(i + 1, j) || step(i, j + 1)
    else if (q[j] === '*') out = step(i, j + 1) || step(i + 1, j)
    else out = (p[i] === q[j] || p[i] === '?' || q[j] === '?') && step(i + 1, j + 1)
    memo.set(key, out)
    return out
  }
  return step(0, 0)
}

const CROSSES = (seg: string): boolean => seg.includes('**')

function segmentsOf(pattern: string): string[] {
  return tidy(pattern)
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (CROSSES(s) ? ANY : s))
}

function segmentsIntersect(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>()
  const step = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let out: boolean
    if (i === a.length && j === b.length) out = true
    else if (i === a.length) out = b.slice(j).every((s) => s === ANY)
    else if (j === b.length) out = a.slice(i).every((s) => s === ANY)
    else if (a[i] === ANY) out = step(i + 1, j) || step(i, j + 1)
    else if (b[j] === ANY) out = step(i, j + 1) || step(i + 1, j)
    else out = namesIntersect(a[i]!, b[j]!) && step(i + 1, j + 1)
    memo.set(key, out)
    return out
  }
  return step(0, 0)
}

const LOOKS_LIKE_A_FILE = /[^/]\.[a-z0-9_]{1,8}$/i

function readings(pattern: string): string[][] {
  const p = tidy(pattern)
  const self = segmentsOf(p)
  if (p.endsWith('**') || LOOKS_LIKE_A_FILE.test(p)) return [self]
  return [self, [...self, ANY]]
}

export function patternsOverlap(a: string, b: string): boolean {
  return readings(a).some((x) => readings(b).some((y) => segmentsIntersect(x, y)))
}

export function scopeClash(a: string[], b: string[]): { a: string; b: string }[] {
  const hits: { a: string; b: string }[] = []
  for (const x of a) {
    for (const y of b) {
      if (patternsOverlap(x, y)) hits.push({ a: x, b: y })
    }
  }
  return hits
}

export const SERIALIZED_PATHS = [
  '**/migrations/**',
  '**/migration/**',
  '**/schema.prisma',
  '**/schema.sql',
  '**/*.migration.*',
  '**/prisma/**',
  '**/db/**'
]

export function exampleOf(pattern: string): string {
  return tidy(pattern).replace(/\*\*\//g, 'x/').replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x')
}

function coversEachOther(a: string, b: string): boolean {
  return matchesScope([a], exampleOf(b)) || matchesScope([b], exampleOf(a))
}

export function touchesSharedSpine(scope: string[]): string[] {
  return scope.filter((p) => SERIALIZED_PATHS.some((s) => coversEachOther(s, p)))
}

export function sameLineOfCommand(
  a: string | undefined,
  b: string | undefined,
  parentOf: (agentId: string) => string | undefined
): boolean {
  if (!a || !b) return false
  return descendsFrom(a, b, parentOf) || descendsFrom(b, a, parentOf)
}

function descendsFrom(
  child: string,
  ancestor: string,
  parentOf: (agentId: string) => string | undefined
): boolean {
  const seen = new Set<string>([child])
  let at = parentOf(child)
  while (at && !seen.has(at)) {
    if (at === ancestor) return true
    seen.add(at)
    at = parentOf(at)
  }
  return false
}

export function outsideScope(declared: string[], written: string[]): string[] {
  if (declared.length === 0) return []
  return written.filter((f) => !matchesScope(declared, f))
}

export function scopeIsMeaningless(scope: string[]): boolean {
  if (scope.length === 0) return true
  return scope.some((p) => {
    const t = tidy(p)
    return t === '**' || t === '*' || t === '' || t === '.' || t === '**/*' || t === '*/**' || t === '**/**'
  })
}

export function clashSentence(
  mine: string,
  theirs: string,
  hits: { a: string; b: string }[]
): string {
  const areas = [...new Set(hits.map((h) => h.a))].slice(0, 3).join(', ')
  return `"${mine}" waits: it writes to ${areas}, and "${theirs}" is working there right now.`
}

export function scopedToPackage(writes: readonly string[], files: readonly string[]): boolean {
  if (!writes.length || !files.length) return false
  const folders = files.map(f => {
    const path = f.replace(/\\/g, '/').toLowerCase()
    return path.slice(0, path.lastIndexOf('/') + 1)
  })
  return writes.some(pattern => {
    const write = pattern.replace(/\\/g, '/').toLowerCase()
    const wild = write.search(/[*?[]/)
    const fixed = wild === -1 ? write : write.slice(0, write.lastIndexOf('/', wild) + 1)
    if (!fixed) return false
    return folders.some(folder => fixed === folder || fixed.startsWith(folder))
  })
}

export function openOnSameFiles(
  tasks: { id: string; title: string; status: string; writes?: string[] }[],
  newId: string,
  writes: string[] | undefined
): { id: string; title: string; status: string }[] {
  if (!writes?.length) return []
  const open = new Set(['queued', 'working', 'reviewing', 'review', 'revising'])
  return tasks
    .filter((t) => t.id !== newId && open.has(t.status) && t.writes?.length && scopeClash(writes, t.writes).length > 0)
    .map(({ id, title, status }) => ({ id, title, status }))
}

export function afterDropSentence(tasks: { id: string; title: string; needs?: string[]; status?: string }[], droppedId: string): string {
  const waiting = tasks.filter((t) => t.id !== droppedId && t.needs?.includes(droppedId) && t.status !== 'approved')
  if (!waiting.length) return 'Nothing was waiting for it.'
  return `Still waiting for it, and they will not start until you change that: ${waiting.map((t) => `"${t.title}" (id ${t.id})`).join('; ')}. For each, use amend to wait for something else or nothing, or replace the prerequisite with the reviewed input it needs.`
}

export function unlandedSentence(files: string[]): string {
  if (!files.length) return ''
  return ` Its edits to ${files.join(', ')} were never put into the project folder, and closing the job threw them away: the folder still has the old ${files.length === 1 ? 'version' : 'versions'}. If the change is still needed, give it to a new job.`
}
