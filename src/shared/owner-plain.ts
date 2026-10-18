const W = String.raw`\p{L}\p{N}_`
const EXT = 'md|html?|json|ts|tsx|js|jsx|mjs|cjs|css|png|jpe?g|ya?ml|csv|txt|pdf|bak|xlsx?|docx?|rs|toml|lock|ps1|sql|py|sh|log'
const CODE = '\u0001'
const FILE = '\u0002'
const FILES = '\u0003'
const DOT = '\u0005'
const MARK = /[\u0001-\u0004]/
const HEX = String.raw`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}`
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
const ID = String.raw`(?:${UUID}|${HEX})(?:…[0-9a-f]*|\.\.\.)?`
const MONTHS = 'januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|dec'
const OPT = '\u0006'
const OWN_NAME = new RegExp(String.raw`(?<![${W}./\\-])(?:[${W}-]+(?:\.[${W}-]+)*\.(?:pdf|docx?|xlsx?|csv)|[A-Z][A-Z0-9_-]+\.md)(?![${W}])`, 'gu')
const EXT_FILE = new RegExp(String.raw`(?<![${W}.-])(?:[A-Za-z]:)?(?:[${W}.*-]+[\\/])*[${W}*-]+(?:\.[${W}*-]+)*\.(?:${EXT})(?![${W}])(?::\d+(?:[-:]\d+)*)?`, 'giu')
const ROOTS = 'src|src-tauri|docs|tests?|scripts|lib|app|public|assets|attachments|outgoing|pipeline|reviews|reports|founder|brain|node_modules|dist|out'
const DIR_PATH = new RegExp(String.raw`(?<![${W}./\\-])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|(?:${ROOTS})[\\/])[${W}.*\\/-]*`, 'gu')
const FILE_LIST = new RegExp(String.raw`${FILE}(?:\s*,\s*(?:and\s+|or\s+)?${FILE}|\s+(?:and|or)\s+${FILE})+`, 'g')
const CODE_TOKENS: RegExp[] = [
  /Cannot read propert(?:y|ies) of (?:undefined|null)/g,
  new RegExp(String.raw`(?<![${W}])(?:[a-z]+-)?${ID}`, 'giu'),
  new RegExp(String.raw`[${W}]+(?:::[${W}]+)+(?:\([^()]*\))?`, 'gu'),
  new RegExp(String.raw`(?<![${W}])[${W}]+\([^()]*\)`, 'gu'),
  new RegExp(String.raw`(?<![${W}])[${W}]+\[[^\]]*\]`, 'gu'),
  new RegExp(String.raw`(?<![${W}-])[a-z][a-z0-9-]*__[a-z0-9-]+`, 'gu'),
  new RegExp(String.raw`(?<![${W}])[a-z][a-z0-9]*(?:_[a-z0-9]+)+_?(?![${W}])`, 'gu'),
  new RegExp(String.raw`(?<![${W}])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![${W}])`, 'gu'),
  new RegExp(String.raw`(?<![${W}])(?!iPhone|iPad|iOS|macOS|eBay)[a-z]+(?:[A-Z][a-z0-9]+)+(?![${W}])`, 'gu'),
  new RegExp(String.raw`(?<![${W}])[${W}]+=\S+`, 'gu'),
  /(?<=^|\s)\.[a-z][\w-]*/g,
  /\s(?:==|!=|=>)\s/g
]
const SEV = new RegExp(String.raw`(?<![${W}])(?:blocking|concern|major|minor|note|info):\s*`, 'giu')
const TAG = /\[(?:[a-z]{1,2}\d{1,3}|criteria|gap|blocking|concern|note)\]\s*/gi
const LABEL = /^(?:blocking|concern|major|minor|note|info|gap|handoff|recovery|scope|evidence|criteria|blocked|fail(?:ed)?|pass(?:ed)?|outcome|bad-figure)$/i
const BEFORE_JOB = /(?:^|\s)(?:a|an|the|this|that|its|their|fix|follow-up|rent-fix|earlier|other|same|new|reissued)\s*$/i
const FINDING_LABEL = /\s(?=(?:blocking|concern|major|minor|note|info):\s)/i
const FAULT = /\b(?:wrong|incorrect|false|missing|broken|break(?:s|ing)?|breach\w*|lost|fails?|failed|failing|error|bug|defect|does not match|doesn't match|mismatch|violat\w*|contradict\w*|overclaim\w*|untrue|partly fixed|not fixed|twice|double(?:s|d)?|second payment|charged|overcharg\w*|still (?:says|reads|has|shows))\b/i
const MONEY = /\d[\d.,]*\s?(?:kr\b|kr\.|øre|DKK)|\bkr\.?\s?\d/iu
const DATE = new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[.${DOT}]\s?(?:${MONTHS})\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b`, 'iu')
const OPTION = /^(?:option|mulighed)\s+(?:[a-h]|\d{1,2})\u0006/i
const matters = (s: string): boolean => { const t = s.replace(/[\u0001-\u0005]/g, ' '); return OPTION.test(s) || FAULT.test(t) || MONEY.test(t) || DATE.test(t) }
const NO_SPLIT = new RegExp(String.raw`(?<![${W}'’./\\-])(kr|ca|pr|nr|jf|inkl|ekskl|mv|osv|evt|dvs|d|kl|md|stk|vedr|pga|iflg|ift|mht|ang|tlf|f\.eks|bl\.a|e\.g|i\.e|vs|approx|jan|feb|mar|apr|jun|jul|aug|sept?|okt|nov|dec)\.|(\d{1,2})\.(?=\s+(?:${MONTHS})\b)`, 'giu')
const NO_SPLIT_DAY = new RegExp(String.raw`(?<![\d.])\d{1,2}\.(?=\s+\p{Ll})|(?<=(?<![${W}'’./\\-])[dD]\.\s?)\d{1,2}\.`, 'gu')
const PRONOUN = /^(?:it|this|that|they|these|those)\b/i

export const PLAIN_FALLBACK_NOTICE = 'The reviewer’s point is about the code itself; its full wording is in History.'

function withoutAsides(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '(') { out += s[i]; continue }
    let depth = 0
    let j = i
    for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break }
    const closed = j < s.length
    if (!closed) { const next = s.slice(i).search(FINDING_LABEL); j = next < 0 ? s.length : i + next }
    const inner = s.slice(i + 1, j)
    const drop = !closed || MARK.test(inner) || /[()]/.test(inner) || /[.!?]\s+\S/.test(inner) || /^\s*[sj]\d{1,3}(?:\s*,\s*[sj]\d{1,3})*\s*$/i.test(inner) || !/\p{L}{2}/u.test(inner)
    if (drop) { out = out.replace(/\s+$/, ''); i = closed ? j : j - 1; continue }
    out += s.slice(i, j + 1)
    i = j
  }
  return out
}

const OS_MISSING = /\b(?:Error:\s*)?(?:ENOENT|ENOTDIR):?\s*no such file or directory,?\s*(?:l?stat|open|scandir|access|realpath|copyfile|rename|unlink|readdir)?\s*'([^']+)'/gi

function marked(text: string): { s: string; kept: string[] } {
  const kept: string[] = []
  let s = text.replace(/\s+/g, ' ').trim().replace(TAG, '')
  s = s.replace(OS_MISSING, (_m: string, path: string) => { kept.push(path.split(/[\\/]/).filter(Boolean).pop() ?? path); return `\u0004${kept.length - 1}\u0004 is not in the project folder` })
  s = s.replace(NO_SPLIT_DAY, (m) => m.replace(/\.$/, DOT))
  s = s.replace(NO_SPLIT, (m) => m.replace(/\.$/, DOT))
  s = s.replace(/\s(?:->|→)\s/g, ' to ')
  s = s.replace(/\b((?:option|mulighed)\s+(?:[a-h]|\d{1,2}))\s*:/gi, `$1${OPT}`)
  s = s.replace(/\b(option\s+)\(([a-h]|[1-9])\)/gi, '$1$2,')
  s = s.replace(/\(\s*(?:option\s+)?([a-h]|[1-9])\s*\)/gi, 'option $1,')
  s = s.replace(SEV, '')
  s = s.replace(new RegExp(String.raw`,?\s*\b(?:critique|candidate|commit|draft|finding)\s+${ID}`, 'gi'), '')
  s = s.replace(new RegExp(String.raw`\b(jobs?|tasks?)\s+${ID}`, 'gi'), (_m: string, noun: string, at: number, all: string) => (BEFORE_JOB.test(all.slice(0, at)) ? noun : `another ${noun}`))
  s = s.replace(/`([a-z][a-z0-9 .-]{0,40})`/gi, (m: string, inner: string) => (inner.trim().split(/\s+/).length <= 4 ? `“${inner.trim()}”` : m))
  s = s.replace(/`[^`]*`/g, CODE)
  s = s.replace(OWN_NAME, (m) => { kept.push(m); return `\u0004${kept.length - 1}\u0004` })
  s = s.replace(EXT_FILE, FILE)
  for (const re of CODE_TOKENS) s = s.replace(re, (m) => (m.startsWith(' ') ? ` ${CODE} ` : CODE))
  s = s.replace(DIR_PATH, FILE)
  s = s.replace(FILE_LIST, FILES)
  s = withoutAsides(s)
  s = s.replace(/\b(?:the\s+)?owner(?:['’]s)?\s+standard\s+s\d{1,3}\b|\bstandard\s+s\d{1,3}\b|\bs\d{1,3}\b/gi, 'your standard')
  s = s.replace(/\bj\d{1,3}\b/g, "one of the job's points")
  return { s, kept }
}

const words = (s: string): number => (s.replace(/[\u0001-\u0005]/g, ' ').match(/\p{L}{2,}/gu) ?? []).length
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function sayCode(s: string): string {
  return s
    .replace(new RegExp(String.raw`${CODE}(?:\s*(?:,|and|or|==|!=|=>)?\s*${CODE})+`, 'g'), CODE)
    .replace(new RegExp(String.raw`\b(the|a|an|its)\s+${CODE}(?=\s+\p{Ll})`, 'gu'), '$1')
    .replace(new RegExp(String.raw`${CODE}['’]s\s`, 'g'), 'a ')
    .replace(new RegExp(CODE, 'g'), 'something in the code')
}
function keepWithCode(clause: string): string {
  const parts = clause.split(/(?=\s(?:because|since)\s)|(?=,\s(?:so|which|but)\s)/)
  return sayCode(parts.filter((p, i) => i === 0 || !p.includes(CODE) || matters(p)).join(''))
}

function clauses(s: string, sayAll: boolean): string[] {
  const parts = s.split(/(;\s+|:\s+)/)
  const out: string[] = []
  let joined = false
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!.trim().replace(/^[,\s]+|[,\s]+$/g, '')
    const sep = (parts[i + 1] ?? '').trim()
    const next = (parts[i + 2] ?? '').trim()
    let said: string | null = null
    const short = words(clause) < 2 && hasAmountOrDate(clause)
    const option = OPTION.test(clause)
    if (clause && !LABEL.test(clause) && (words(clause) >= 2 || short || option)) {
      if (option && !words(clause.replace(OPTION, '').replace(/[\u0001-\u0003]/g, ' '))) said = `${clause.match(OPTION)![0]} keep the code as it is`
      else if (!clause.includes(CODE)) said = clause
      else if (sayAll || matters(clause) || PRONOUN.test(next)) said = keepWithCode(clause)
    }
    if (said === null) {
      joined = false
      if (out.length) out[out.length - 1] = out[out.length - 1]!.replace(/[;:]$/, '')
      continue
    }
    if (out.length && (joined || short)) out[out.length - 1] += ' ' + said + sep
    else out.push(said + sep)
    joined = true
  }
  return out.map((c) => { const t = cap(c.replace(/[;:]$/, '').replace(/[\s.]+$/, '')); return t.endsWith(DOT) ? t : t + '.' }).filter((c) => words(c) >= 2 || hasAmountOrDate(c) || OPTION.test(c))
}

const hasAmountOrDate = (s: string): boolean => { const t = s.replace(/[\u0001-\u0004]/g, ' '); return MONEY.test(t) || DATE.test(t) }

function pick(sentences: string[], most: number): string[] {
  let kept = sentences.slice(0, most)
  const swap = (hit: string): void => { kept = most > 1 ? [...kept.slice(0, most - 1), hit] : [hit] }
  if (!kept.some(hasAmountOrDate)) { const hit = sentences.slice(most).find(hasAmountOrDate); if (hit) swap(hit) }
  if (!kept.some(matters)) { const hit = sentences.slice(most).find(matters); if (hit && most > 1) swap(hit) }
  return kept
}

function render(text: string, max: number, most: number, sayAll: boolean, pointer: boolean): string {
  const { s, kept } = marked(text)
  const raw = s.split(/(?<=[.!?])\s+/).reduce<string[]>((acc, x) => {
    if (acc.length && words(x) < 2 && hasAmountOrDate(x)) acc[acc.length - 1] += ' ' + x
    else acc.push(x)
    return acc
  }, [])
  const sentences = raw.flatMap((x) => clauses(x.replace(/[.!?]$/, ''), sayAll))
  const picked = pick(sentences, most)
  const finish = (str: string): string => {
    let out = str
      .replaceAll(FILES, 'some files').replaceAll(FILE, 'a file')
      .replace(/,\s*([,:;.])/g, '$1').replace(/\s+([,;:])/g, '$1').replace(/\s+\.(?=\s|$)/g, '.').replace(/\s{2,}/g, ' ').trim()
    out = out.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m: string, a: string, b: string) => a + b.toUpperCase())
    return out.replace(/\u0004(\d+)\u0004/g, (_m: string, n: string) => kept[Number(n)]!).replaceAll(DOT, '.').replaceAll(OPT, ':')
  }
  const cutAtWord = (t: string, n: number): string => (t.length > n ? t.slice(0, Math.max(1, n - 1)).replace(/\s+\S*$/, '') + '…' : t)
  const more = sentences.length - picked.length
  let out = finish(picked.join(' '))
  if (out.length <= max) return pointer && more > 0 ? `${out} (${more} more point${more === 1 ? '' : 's'} in History)` : out
  const note = pointer ? ' (more in History)' : ''
  const parts = picked.map((p) => finish(p))
  const at = parts.findIndex((p) => hasAmountOrDate(p))
  const room = max - note.length
  if (at < 0) return cutAtWord(out, room) + note
  const before = parts.slice(0, at).join(' ')
  const hit = parts[at]!
  if (hit.length >= room) return cutAtWord(hit, room) + note
  return (before ? cutAtWord(before, room - hit.length - 1) + ' ' : '') + hit + note
}

export function plainForOwner(text: string, max = 240, opts: { most?: number; card?: boolean; pointer?: boolean } = {}): string {
  const most = opts.most ?? 2
  const out = render(text, max, most, false, !!opts.pointer)
  if (out) return out
  if (!opts.card) return PLAIN_FALLBACK_NOTICE
  const said = render(text, max, most, true, !!opts.pointer)
  return said || text.replace(/\s+/g, ' ').replace(TAG, '').replace(/(?:^|\s)(?:blocking|concern|major|minor|note|info):\s*/gi, ' ').trim().slice(0, max)
}
