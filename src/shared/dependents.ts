export interface SourceFile { path: string; text: string }

export const USED_BY_LIMIT = 12

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')
const dirOf = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
const stem = (p: string): string => p.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '').replace(/\/index$/i, '')
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isRust = (p: string): boolean => /\.rs$/i.test(p)
const isScript = (p: string): boolean => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(p)

export function concretePaths(paths: string[] | undefined): string[] {
  return (paths ?? []).map(norm).filter(p => p && !/[*?{}[\]]/.test(p) && /\.[A-Za-z0-9]+$/.test(p))
}

function rustModule(path: string): { parent: string; name: string } | null {
  const parts = norm(path).replace(/\.rs$/i, '').split('/')
  if (parts[parts.length - 1] === 'mod') parts.pop()
  const name = parts[parts.length - 1]
  if (!name || name === 'lib' || name === 'main') return null
  return { parent: parts[parts.length - 2] ?? '', name }
}

function rustUses(file: SourceFile, target: string): boolean {
  const mod = rustModule(target)
  if (!mod) return false
  const name = escape(mod.name), parent = escape(mod.parent)
  if (new RegExp(`\\b${parent}::${name}\\b`).test(file.text)) return true
  if (new RegExp(`\\b${parent}::\\{[^}]*\\b${name}\\b`).test(file.text)) return true
  if (dirOf(norm(file.path)) === dirOf(norm(target)) && new RegExp(`\\bsuper::(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(file.text)) return true
  return false
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm

function scriptUses(file: SourceFile, target: string): boolean {
  const want = stem(norm(target))
  for (const m of file.text.matchAll(IMPORT)) {
    const parts = `${dirOf(norm(file.path))}/${m[1]}`.split('/')
    const out: string[] = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    if (stem(out.join('/')) === want) return true
  }
  return false
}

const rank = (p: string): number => /(^|\/)(examples|bin|scripts|benches)\//.test(p) ? 2 : /(^|\/)tests?\/|\.(test|spec)\.[a-z]+$/i.test(p) ? 1 : 0

export function dependentsOf(targets: string[], files: SourceFile[]): string[] {
  const wanted = concretePaths(targets).filter(t => isRust(t) || isScript(t))
  if (!wanted.length) return []
  const skip = new Set(wanted.map(t => t.toLowerCase()))
  const out = new Set<string>()
  for (const file of files) {
    const path = norm(file.path)
    if (skip.has(path.toLowerCase())) continue
    for (const target of wanted) {
      const hit = isRust(target) ? isRust(path) && rustUses(file, target) : isScript(path) && scriptUses(file, target)
      if (hit) { out.add(path); break }
    }
  }
  return [...out].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export function usedByBlock(all: string[], seat: 'worker' | 'reviewer'): string {
  if (!all.length) return ''
  const users = all.slice(0, USED_BY_LIMIT)
  const more = all.length - users.length
  const how = seat === 'worker'
    ? 'Do not break them: run their tests, or the project’s tests that cover them, before you report, as far as the criteria and your step budget allow. Change them only if your write list includes them.'
    : 'A change that breaks one of them is a finding. Check that through the tests the criteria name or the project’s own tests; do not review those files themselves.'
  return [`FILES THAT USE WHAT ${seat === 'worker' ? 'YOU ARE CHANGING' : 'THIS JOB CHANGED'} (found by reading import lines, one step out; it may be incomplete):`, ...users.map(u => `- ${u}`), ...(more > 0 ? [`- and ${more} more (examples and scripts last)`] : []), how].join('\n')
}
