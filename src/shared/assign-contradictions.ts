import { matchesScope } from './scope'

export interface ContradictionFacts { writes: readonly string[]; criteria: readonly string[]; exists(path: string): boolean; text?(path: string): string | null; seatCanRun: boolean; seatName: string; alsoCovered?: readonly string[] }

const exact = (p: string): boolean => !/[*?]/.test(p)
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const join2 = (d: string, f: string): string => (d ? `${d}/${f}` : f)
const NO_DECLARE = /(^|\/)(tests|benches|examples|bin)(\/|$)/

export function rustParentsOf(file: string): string[] {
  const name = baseOf(file).replace(/\.rs$/i, ''); let dir = dirOf(file)
  if (['main', 'lib', 'build'].includes(name) || NO_DECLARE.test(dir)) return []
  if (name === 'mod') { if (!dir.includes('/')) return []; dir = dirOf(dir) }
  if (!/(^|\/)src(\/|$)/.test(dir)) return []
  return baseOf(dir) === 'src' ? [join2(dir, 'lib.rs'), join2(dir, 'main.rs')] : [join2(dir, 'mod.rs'), `${dir}.rs`]
}

export function isBarrel(text: string | null): boolean {
  if (!text) return false
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n').trim()
  if (!body) return false
  const stmts = body.split(/;|\n(?=\s*export\b)/).map(s => s.trim()).filter(Boolean)
  return stmts.every(s => /^export\s+(\*|\{[^}]*\}|type\s+\{[^}]*\})(\s+as\s+\w+)?\s+from\s+['"]\.\/[^'"]+['"]$/.test(s))
}

const NOT_BARREL = /\.(stories|mock|fixture|test|spec)\.tsx?$|(^|\/)(__tests__|__mocks__|tests)\//i

export function moduleDeclarationRefusal(f: ContradictionFacts): string | null {
  const covered = [...f.writes, ...(f.alsoCovered ?? [])]
  const lines: string[] = [], missing = new Set<string>()
  for (const file of f.writes.filter(exact)) {
    if (f.exists(file)) continue
    const rust = /\.rs$/i.test(file)
    const ts = /\.tsx?$/i.test(file) && !/\.d\.tsx?$/i.test(file) && !NOT_BARREL.test(file) && !/^index\.tsx?$/i.test(baseOf(file))
    const parents = rust ? rustParentsOf(file) : ts ? [join2(dirOf(file), 'index.ts'), join2(dirOf(file), 'index.tsx')].filter(p => f.exists(p) && isBarrel(f.text?.(p) ?? null)) : []
    const present = parents.filter(p => f.exists(p))
    if (!present.length || present.some(p => matchesScope(covered, p))) continue
    const parent = present[0]!, name = baseOf(file).replace(/\.(rs|tsx?)$/i, '')
    missing.add(parent)
    lines.push(rust
      ? `${file} is a new Rust file, and Rust builds it only when ${parent} declares it (one "mod ${name};" line).`
      : `${file} is a new module in a folder whose ${parent} re-exports each of its files.`)
  }
  if (!lines.length) return null
  const list = [...missing]
  return `Nothing was assigned: ${lines.join(' ')} ${list.join(', ')} ${list.length > 1 ? 'are' : 'is'} not in writes, so this job could not finish. Add ${list.join(', ')} to writes: a new module without its declaring file does not build, so they must change together.`
}

const QUOTE_OUTPUT = /\b(quot(?:e|es|ed|ing)|paste[sd]?)\b[^.]{0,60}\b(?:(?:command|test|build|suite|cargo|npm|vitest|tsc)\b[^.]{0,30}\b(?:output|totals?|summary|results?|exit)|exit (?:line|code|status))\b|\b(?:cargo|npm|vitest|test|build|suite)\b[^.]{0,30}\b(?:output|totals?|summary)\b[^.]{0,30}\bquoted\b/i
export function quoteOutputRefusal(f: ContradictionFacts): string | null {
  if (f.seatCanRun) return null
  const hit = f.criteria.find(c => QUOTE_OUTPUT.test(c))
  return hit ? `Nothing was assigned: the criterion "${hit.slice(0, 160)}" asks for quoted command output, and ${f.seatName}'s seat on this project cannot run commands (no shell, no isolated run, no project check). Ask for something the seat can show (a file it writes, a value it reads), or give the job to a teammate whose seat can run commands.` : null
}

const FULL_SUITE = /\b(full|whole|entire|complete)\s+(test\s+)?suite\b|\ball (the )?tests (run and )?pass/i
export const docsOnly = (writes: readonly string[]): boolean => writes.length > 0 && writes.every(w => /^docs\//i.test(w.replace(/^\.\//, '')))
export function notApplicableStandards(standards: readonly string[], writes: readonly string[]): string[] { return docsOnly(writes) ? standards.filter(s => FULL_SUITE.test(s)) : [] }
export const notApplicableLine = (standard: string): string => `Not applicable to this job, which changes only files under docs/, where no test runs: the owner's standard "${standard}". Damon set this when the job was assigned; no test run is asked for.`
