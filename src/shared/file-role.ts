import { isRenderedView } from './rendered-views'

export type FileRole =
  | 'outward'
  | 'owner-sheet'
  | 'record'
  | 'view'
  | 'evidence'
  | 'code'
  | 'tests'
  | 'contract'
  | 'internal-doc'
  | 'other'

export type ProjectKind = 'build' | 'documents'

export interface RoleContext {
  kind?: ProjectKind
  outward?: ReadonlySet<string>
  packageFolders?: readonly string[]
}

export const ROLE_WORDS: Record<FileRole, string> = {
  outward: "goes out under the owner's name or to a client",
  'owner-sheet': "a sheet for the owner to read; his form may be filled from it, so it is judged like what goes out",
  record: "Damon's own record of the work; nothing sends it",
  view: 'drawn by Damon from its records',
  evidence: "evidence Damon's checks took",
  code: 'code',
  tests: 'tests',
  contract: 'a contract the rest of the project builds on',
  'internal-doc': 'an internal document: the team reads it, nothing sends it',
  other: 'a data or other file'
}

const norm = (p: string): string => (p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
const nameOf = (p: string): string => norm(p).split('/').pop() ?? ''

const EVIDENCE = /(^|\/)(damon-shots|damon-coverage|damon-skills|\.playwright-mcp|screenshots?)\//i
const OWN_RECORD = /(^|\/)records\/[^/]+\.json$/i
const TEAM_FILE = /^(?:NOTES(?:-ARCHIVE)?|ROADMAP|PLAN|RUNBOOK|DAMON-REPORT|CHANGELOG)\.md$/i
const OWNER_SHEET = /^(?:.*[-_.])?(?:submission|how-?to|readme|checklist|prep|brief)(?:[-_.].*)?\.(?:md|markdown|html?|txt)$/i
const TRACKER = /^(?:.*[-_.])?(?:tracker|pipeline)(?:[-_.].*)?\.(?:md|markdown|txt|csv)$/i
const LOGLIKE = /log/i
const INTERNAL_FOLDER = /(^|\/)docs\/(?:qa|design|design-notes|superpowers\/(?:plans|specs))\/|(^|\/)design-notes\//i
const SENDABLE = /(?:letter|e-?mail|message|answers?|response|reply|proposal|invoice|quote|offer)/i
const TESTS = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z0-9]+$/i
const CONTRACT = /(^|\/)(contracts?|schemas?|migrations?)\/|\.(proto|graphql|sql)$|(^|\/)openapi\.(json|ya?ml)$|\.d\.ts$/i
const CODE = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|vue|svelte|css|scss|sass|less)$/i
const DOCUMENT = /\.(md|markdown|txt|rst|adoc|html?|pdf|docx?|odt|rtf|eml|msg)$/i
const SENDABLE_FORMAT = /\.(pdf|docx?|odt|rtf|eml|msg)$/i
const MANIFEST = /^(package\.json|cargo\.toml|pyproject\.toml|setup\.py|go\.mod|pom\.xml|build\.gradle(\.kts)?|gemfile|composer\.json|deno\.json|mix\.exs|.+\.(csproj|fsproj|sln))$/i

export function projectKind(rootNames: readonly string[]): ProjectKind {
  return rootNames.some((n) => MANIFEST.test(n)) ? 'build' : 'documents'
}

function inFolder(path: string, folders: readonly string[] | undefined): boolean {
  const p = norm(path).toLowerCase()
  return (folders ?? []).some((f) => {
    const d = norm(f).toLowerCase().replace(/\/+$/, '')
    return d.length > 0 && p.startsWith(d + '/')
  })
}

export function fileRole(path: string, ctx: RoleContext = {}): FileRole {
  const p = norm(path)
  const name = nameOf(p)
  if (!p) return 'other'
  if (ctx.outward?.has(p.toLowerCase())) return 'outward'
  if (EVIDENCE.test(p)) return 'evidence'
  if (isRenderedView(p)) return 'view'
  if (OWN_RECORD.test(p) || TEAM_FILE.test(p)) return 'record'
  if (OWNER_SHEET.test(name)) return 'owner-sheet'
  if (TESTS.test(p) && !DOCUMENT.test(name)) return 'tests'
  if (CONTRACT.test(p)) return 'contract'
  const packaged = inFolder(p, ctx.packageFolders)
  if (CODE.test(name) || (ctx.kind === 'build' && /\.html?$/i.test(name) && !packaged)) return 'code'
  if (ctx.kind !== 'build' && !packaged && TRACKER.test(name) && !LOGLIKE.test(name) && !SENDABLE.test(name)) return 'record'
  if (!DOCUMENT.test(name)) return 'other'
  if (packaged) return 'outward'
  if (SENDABLE.test(name) || SENDABLE_FORMAT.test(name)) return 'outward'
  if (INTERNAL_FOLDER.test(p)) return 'internal-doc'
  return 'outward'
}

const SHARED_FOLDERS: ReadonlySet<string> = new Set(['pipeline', 'records', 'docs', 'notes', 'documents'])
const ABSOLUTE = /^(?:[a-z]:|\/)/i
const tricky = (p: string): boolean => ABSOLUTE.test(p) || p.split('/').some((s) => s === '..')
export function packageFolderOf(path: string, ctx: RoleContext): string | undefined {
  const p = norm(path)
  if (!p || tricky(p)) return undefined
  const role = fileRole(p, ctx)
  if (role !== 'outward' && role !== 'owner-sheet') return undefined
  const lower = p.toLowerCase()
  for (const f of ctx.packageFolders ?? []) {
    const d = norm(f).toLowerCase().replace(/\/+$/, '')
    const segs = d.split('/').filter(Boolean)
    if (segs.length < 2 || tricky(d) || segs.some((s) => SHARED_FOLDERS.has(s)) || segs[segs.length - 1] === 'outgoing') continue
    if (lower.startsWith(d + '/')) return d
  }
  return undefined
}

export function packagedDraft(files: readonly string[], ctx: RoleContext, covered: boolean): boolean {
  if (covered) return true
  return files.some((f) => fileRole(f, ctx) === 'outward' && (!!ctx.outward?.has(norm(f).toLowerCase()) || inFolder(f, ctx.packageFolders)))
}

const NEVER_LEAVES: ReadonlySet<FileRole> = new Set<FileRole>(['record', 'view', 'evidence', 'internal-doc', 'code', 'tests', 'contract'])
export function neverLeaves(paths: readonly string[], ctx: RoleContext = {}): boolean {
  const files = paths.map(norm).filter(Boolean)
  return files.length > 0 && files.every((f) => !/[*?]/.test(f) && NEVER_LEAVES.has(fileRole(f, ctx)))
}

const NOTE_ROLES: ReadonlySet<FileRole> = new Set<FileRole>(['record', 'view', 'evidence', 'internal-doc'])
export function cosmeticIsNote(role: FileRole): boolean {
  return NOTE_ROLES.has(role)
}

export function bookkeepingFile(path: string, ctx: RoleContext = {}): boolean {
  const p = norm(path)
  if (!p || /[*?]/.test(p) || ctx.outward?.has(p.toLowerCase())) return false
  const role = fileRole(p, ctx)
  if (role === 'view') return true
  if (role !== 'record') return false
  return OWN_RECORD.test(p) || TRACKER.test(nameOf(p))
}

const COSMETIC = /\b(?:em[- ]?dash(?:es)?|en[- ]?dash(?:es)?|long dash(?:es)?|dash(?:es)?|typos?|spelling|misspel\w*|punctuation|comma|full stop|capitali[sz]\w*|heading|formatting|indent\w*|whitespace|line endings?|crlf|wording|phrasing|tone|grammar|bracket)\b/i
const SUBSTANCE = /\b(?:wrong(?:ly)?|incorrect(?:ly)?|false|untrue|inconsisten(?:t|cy|cies)|ambiguous|ambiguit(?:y|ies)|should (?:be|say|read)|missing|absent|broken|fail(?:s|ed|ing|ure|ures)?|errors?|bugs?|defects?|(?:does|do|did)(?: not|n't) (?:match|add up)|mismatch(?:es|ed)?|contradict\w*|overclaim\w*|invent\w*|unverified|claims?|claimed|figures?|numbers?|totals?|amounts?|prices?|salar(?:y|ies)|dates?|deadlines?|counts?|lists?|security|secrets?|passwords?|leak\w*|mislead\w*|adds? up)\b/i
const DIGIT = /\d/
export function cosmeticFinding(text: string): boolean {
  const t = text ?? ''
  return COSMETIC.test(t) && !SUBSTANCE.test(t) && !DIGIT.test(t)
}
export function substantiveFinding(text: string): boolean {
  const t = text ?? ''
  return SUBSTANCE.test(t) || DIGIT.test(t)
}
export function substantiveWords(text: string): boolean {
  return SUBSTANCE.test(text ?? '')
}

const PROCESS = [
  /\b(?:a |the |no )?(?:missing |absent )?(?:test[- ]first|red[- ]green|tdd|failing[- ]first)\b[\w -]{0,40}?\b(?:printouts?|print-outs?|outputs?|evidence|transcripts?|proofs?|runs?|steps?|records?)\b/gi,
  /\b(?:the |a |its |new )?tests? (?:was|were|is|are) (?:not|never) (?:shown|seen|run|printed) (?:to )?fail(?:ing)?(?: (?:first|before (?:the )?(?:fix|change|implementation)))?/gi,
  /\b(?:the |a |an )?(?:exact )?commands? (?:is|are|was|were) (?:not|never) (?:quoted|shown|printed)(?: (?:verbatim|in full|exactly))?/gi,
  /\bunquoted (?:commands?|output)\b/gi,
  /\b(?:does|do|did) ?(?:not|n't) quote (?:the )?(?:exact )?(?:commands?|output)\b/gi,
  /\bcount words?\b/gi,
  /["'“”‘’](?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many|both)["'“”‘’]/gi
]
const SENSITIVE = /\b(?:behaviou?rs?|crash\w*|regress\w*|breaks?|hangs?|freez\w*|slow\w*|data|personal|privacy|gdpr|consent|cpr|money|payments?|currenc\w*|tax(?:es)?|vat|rent|logins?|auth\w*|permissions?|tokens?)\b/i
const stripProcess = (text: string): string => PROCESS.reduce((t, re) => t.replace(re, ' '), text ?? '')
export function processFinding(statement: string, evidence = ''): boolean {
  const raw = statement ?? ''
  if (/^\s*\[s\d{1,3}\]/i.test(raw)) return false
  const s = raw.replace(/^\s*\[(?:j\d{1,3}|gap)\]\s*/i, '')
  const named = PROCESS.some((re) => new RegExp(re.source, 'i').test(s)) || COSMETIC.test(s)
  if (!named) return false
  const rest = stripProcess(s)
  if (SUBSTANCE.test(rest) || DIGIT.test(rest) || SENSITIVE.test(rest)) return false
  const said = stripProcess(evidence)
  return !SUBSTANCE.test(said) && !SENSITIVE.test(said)
}
