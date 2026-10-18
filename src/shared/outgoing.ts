// Which files of an outgoing package leave the project, and whether a check's finding is
// about them. When unsure, a finding holds.
export function isSharedUpload(file: string): boolean {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return /^attachments\/[^/]+$/i.test(f)
}

export function isBackupName(name: string, siblings: string[] = []): boolean {
  if (/\.bak$|~$|\.tmp$/i.test(name) || /\.\d{4}-\d{2}-\d{2}\./.test(name)) return true
  const dated = /^(.*)-\d{4}-\d{2}-\d{2}(\.[^.]+)$/.exec(name)
  if (!dated) return false
  const undated = (dated[1] + dated[2]).toLowerCase()
  return siblings.some(s => s.toLowerCase() === undated)
}

export function outsideFiles(where: string, files: string[]): boolean {
  if (!files.length) return false
  const named = [...(where ?? '').matchAll(/[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,5}|\b[\w-]+\.(?:md|html?|pdf|json|csv|txt)\b/g)].map(m => m[0].replace(/\\/g, '/').toLowerCase())
  if (!named.length) return false
  const mine = files.map(f => f.replace(/\\/g, '/').toLowerCase())
  return !named.some(n => mine.some(f => f === n || f.endsWith('/' + n) || n.endsWith('/' + f)))
}
const unquoted = (text: string): string => text.replace(/"[^"]*"|\u201c[^\u201d]*\u201d|`[^`]*`/g, ' ')
export function namesSentFile(raw: string, sent: string[]): boolean {
  const text = unquoted(raw ?? '')
  return /[\w-]+\.(?:md|html?|pdf|json|csv|txt|docx?)\b/i.test(text) && !outsideFiles(text, sent)
}

export const PACKAGE_SCENARIOS = [
  { id: 'claims' as const, when: 'Read every sentence in the files that leave', expected: 'Every claim is supported by a fact in the facts given', check: 'Quote each sentence that no fact given supports, or that says more than its fact. Name the file.' },
  { id: 'recipient' as const, when: 'Read the greeting, the recipient and every claim about the recipient', expected: 'The right recipient and contact; nobody else named by mistake; claims about the recipient match a quoted source', check: 'Quote any wrong or unsupported recipient or contact line. Name the file.' },
  { id: 'asks' as const, when: 'Compare the files that leave with what the request and the form ask', expected: 'Every question asked is answered, within any limit the request or form states', check: 'Name a missing answer or a stated limit that is exceeded. A limit nobody can read is a note, not a failure.' }
]
export const PACKAGE_PDF_SCENARIO = { id: 'pdf-text' as const, when: 'Read each PDF that leaves with read_project_file: it comes back as its page count and its text, page by page', expected: 'Each PDF carries the same claims as its source (the .md or .html of the same name beside it)', check: 'Give the page count of each PDF. Compare its text with its source and quote any line in the PDF that the source no longer has (an old print), or any claim in the source that is missing from the PDF. Name the file.' }
const PACKAGE_IDS: ReadonlySet<string> = new Set([...PACKAGE_SCENARIOS.map(s => s.id), PACKAGE_PDF_SCENARIO.id])
export function isPackageScenario(id: string): boolean { return PACKAGE_IDS.has(id) }

export const PACKAGE_NOT_YOURS =
  'NOT YOURS TO JUDGE: Damon\u2019s own notes, decisions, review records and trackers; cards on the owner\u2019s list; schedules; whether the request is still open; whether the browser could open a page. Do not fail or block on any of them. Judge only the files that leave.'

export const BOOKKEEPING_CHECKS: ReadonlySet<string> = new Set(['handoff', 'recovery', 'schedules', 'cards', 'browser', 'records'])
export function isBookkeepingCheck(id: string): boolean { return BOOKKEEPING_CHECKS.has(id) }
const TOOL_WORDS: ReadonlySet<string> = new Set(['scan', 'scans', 'script', 'scripts', 'lint', 'linter', 'grep', 'regex', 'tool', 'tools', 'docker', 'isolated', 'automated', 'automation'])
export function isToolCheck(id: string): boolean {
  if (isPackageScenario(id) || /print/i.test(id)) return false
  const words = id.toLowerCase().split(/[^a-z0-9]+/)
  if (words.some(w => CONTENT_WORDS.has(w))) return false
  return words.some(w => TOOL_WORDS.has(w))
}
const CONTENT_WORDS: ReadonlySet<string> = new Set(['ats', 'word', 'words', 'count', 'length', 'claim', 'claims', 'fact', 'facts', 'spell', 'spelling'])
export function namesSentBase(raw: string, sent: string[]): boolean {
  const text = unquoted(raw ?? '').toLowerCase()
  return sent.some(f => {
    const base = (f.split('/').pop() ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase()
    return base.length >= 2 && new RegExp(`(^|[^a-z0-9])${base.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}([^a-z0-9]|$)`).test(text)
  })
}

const FILE_IN = /[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5}\b/g
const stripFiles = (text: string): string => text.replace(/https?:\/\/\S+/gi, ' ').replace(FILE_IN, ' ')
const filesIn = (text: string): string[] => [...(text ?? '').replace(/https?:\/\/\S+/gi, ' ').matchAll(FILE_IN)].map(m => m[0].replace(/\\/g, '/'))
const nameOf = (p: string): string => p.split('/').pop() ?? p
const SHEET_NAME = /^(?:.*[-_.])?(?:submission|how-?to|readme|notes|checklist|prep|brief|answers?)(?:[-_.].*)?\.(?:md|html?|txt)$/i
const OWN_NAME = /^(?:.*[-_.])?(?:review|tracker|pipeline|decisions|notes-archive|intel|research)(?:[-_.].*)?\.(?:md|html?|txt|json)$/i
const FORM_SHEET = /^(?:.*[-_.])?(?:submission|answers?)(?:[-_.].*)?\.(?:md|html?|txt)$/i
export function isFormSheet(path: string): boolean { return FORM_SHEET.test(nameOf(path.replace(/\\/g, '/'))) }

const ANSWERS_HEADING = /(?:^|[^a-z])(?:form|fields?|answers?|questions?|paste)(?:[^a-z]|$)/i
export function formAnswers(text: string): { answers: string; headings: string[] } | undefined {
  const lines = (text ?? '').split(/\r?\n/)
  const parts: string[] = [], headings: string[] = []
  let level = 0, inside = false
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const lv = h[1]!.length
      if (inside && lv <= level) inside = false
      if (!inside && lv > 1 && ANSWERS_HEADING.test(h[2]!)) { inside = true; level = lv; headings.push(h[2]!.trim()) }
    }
    if (inside) parts.push(line)
  }
  return headings.length ? { answers: parts.join('\n'), headings } : undefined
}
export function placeInAnswers(where: string, headings: string[]): boolean {
  const words = stripFiles(unquoted(where ?? '')).toLowerCase().match(/[a-z\u00e6\u00f8\u00e5]{4,}/g) ?? []
  const hs = headings.map(h => h.toLowerCase())
  return words.some(w => hs.some(h => h.includes(w)))
}

export function namesASentFile(text: string, sent: string[]): boolean {
  return filesIn(text).some(p => !outsideFiles(p, sent))
}
function placeNamesSentStem(where: string, sent: string[]): boolean {
  const words = (s: string): string => s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  const place = words(stripFiles(unquoted(where)))
  return sent.some(f => {
    const stem = words(nameOf(f.replace(/\\/g, '/')).replace(/\.[A-Za-z0-9]{1,5}$/, '')).trim()
    return stem.length >= 2 && new RegExp('(?:^|[^a-z0-9])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z0-9])').test(place)
  })
}

export function longQuotes(text: string): string[] {
  return [...(text ?? '').matchAll(/"([^"]{12,})"|\u201c([^\u201d]{12,})\u201d|\u2018([^\u2019]{12,})\u2019/g)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter(q => q.length >= 12 && !/^[\w./-]+\.[A-Za-z0-9]{1,5}$/.test(q))
}
const flat = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[\u2019\u2018]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').toLowerCase()
export function quotesASentFile(text: string, sentTexts: string[] | undefined): boolean {
  const quotes = longQuotes(text)
  if (!quotes.length) return false
  const bodies = (sentTexts ?? []).filter(t => !!t).map(flat)
  if (!bodies.length) return true
  return quotes.some(q => { const n = flat(q); return bodies.some(b => b.includes(n)) })
}

const FAULT = new RegExp([
  '\\bwrong\\b', '\\bincorrect', '\\binaccura', '\\buntrue\\b', '\\bnot true\\b', '\\bfalse(?:ly)?\\b', '\\btypos?\\b', 'misspel', 'mis-?quot', 'misstat', 'overstat', 'exaggerat',
  'unsupported', 'not supported', 'no (?:verified )?fact', 'contradict', 'inconsisten', 'mismatch', "does(?: not|n['\\u2019]t) match", 'disagree', 'differs? from', 'conflict',
  'exceed', 'over (?:the |its |a )?(?:limit|cap|maximum)', 'above (?:the |its )?(?:limit|cap|maximum)', 'too long', 'too many',
  '\\bmissing\\b', '\\bomit', 'leaves? out', 'left out', "does(?: not|n['\\u2019]t) (?:mention|say|answer|include|name)", 'not mentioned', '\\black', 'absent from',
  '\\bstale\\b', 'outdated', 'out of date', '\\bstill (?:says|reads|calls|carries|has|lists|names|contains|quotes|claims|shows|uses|gives|mentions|present|there|in)\\b',
  '\\bshould (?:be|say|read|not|have)\\b', '\\bmust (?:be|say|read|not|have)\\b', '\\bneeds? (?:to be )?(?:fix|chang|correct|updat|remov|cut)',
  '\\bviolat', '\\bbreach', 'not allowed', 'forbidden', 'not permitted', 'unanswered', 'not answered', '\\bblank\\b', 'empty (?:field|answer|box)', '\\bduplicat',
  '\\b(?:an?|one|two|three|four|five|several|some|\\d+) (?:em[- ]?|en[- ]?)?(?:dash|dashes|banned)\\b', '\\bfound (?:a|an|one|two|three|four|five|\\d+|some|several)\\b', '\\bdefect', '\\bfault', '\\bfails? (?:the|its|to)\\b', 'wrong file', 'old print',
  "(?:is|are|was|were)(?: not|n['\\u2019]t) (?:supported|backed|accurate|correct|right|true|consistent|answered|included|mentioned)", 'not backed', 'no (?:source|evidence) (?:for|supports?)', 'not (?:accurate|correct|consistent)',
  "(?:do|did|does)(?: not|n['\\u2019]t) (?:match|fit|agree|line up)", 'overclaim', 'fabricat', 'invent(?:s|ed)\\b',
  "(?:over|above|beyond|past|more than) (?:the |its |a )?[\\w-]*(?:word|character|char)?[- ]?(?:limit|cap|maximum|max)\\b", 'longer than (?:the |its )?(?:limit|cap|maximum|allowed)', 'not within', '\\babsent\\b'
].join('|'), 'i')
const COUNT = /(\d[\d,]*)\s+(?:words?|characters?|chars?|ord|tegn)\b/gi
const LIMIT = /(?:\blimit|\bmaximum|\bmax\b\.?|\bcap\b|at most|up to|no more than|\ballowed)[^\d.;]{0,15}(\d[\d,]*)|(\d[\d,]*)[- ](?:words?|characters?|chars?)[- ](?:limit|maximum|max|cap)\b/gi
const num = (s: string): number => Number(s.replace(/,/g, ''))
function countOverLimit(text: string): boolean {
  const limits = [...text.matchAll(LIMIT)].map(m => num(m[1] ?? m[2] ?? '')).filter(n => Number.isFinite(n) && n > 0)
  if (!limits.length) return false
  const least = Math.min(...limits)
  return [...text.matchAll(COUNT)].some(m => num(m[1]!) > least)
}
const sentences = (text: string): string[] => (text ?? '').split(/(?<=[.!?])\s+|;\s*/).map(s => s.trim()).filter(Boolean)
const clauses = (s: string): string[] => s.split(/,\s*|\s+(?:but|so|which|while|although|however|and)\s+/i).map(c => c.trim()).filter(Boolean)
const UNSURE = /unprove|not proven|not (?:established|shown|confirmed|verified)|can(?:no|['\u2019])t (?:show|tell|prove|confirm|verify)|could(?: not|n['\u2019]t) (?:show|tell|prove|confirm|verify|be (?:shown|proven|confirmed|verified|measured|checked))/i
const DOC = /[\w.-]+\.[A-Za-z0-9]{1,5}\b|\b(?:report|proposal|letter|answers?|form|e-?mail|q\d+)\b/i
function excusedExtent(s: string): boolean {
  if (!aboutEditExtent(s)) return false
  const faulty = clauses(s).filter(c => FAULT.test(c))
  return faulty.length > 0 && faulty.every(c => (aboutEditExtent(c) || UNSURE.test(c)) && !DOC.test(c))
}
const EDIT_EXTENT = /pre-?edit|baseline|byte[- ]?(?:counts?|diff|for[- ]byte)|\bbytes?\b|sha-?256|\bsha\b|checksum|\bhash(?:es)?\b|before[/ ](?:and )?after|line[- ]for[- ]line|(?:earlier|previous|prior|older|pre-edit) (?:version|copy|copies|history|print)s?|no (?:edit )?history|\bdiff\b|(?:only|nothing else)(?: [\w'-]+){0,4} (?:differs?|changed|change)|allowed lines|size command|nothing else changed/i
export function aboutEditExtent(text: string): boolean { return EDIT_EXTENT.test(text ?? '') }
export function reportsFault(text: string, opts: { editLane?: boolean } = {}): boolean {
  const plain = unquoted(text ?? '')
  return countOverLimit(plain) || sentences(plain).some(s => FAULT.test(s) && !(opts.editLane && excusedExtent(s)))
}
export function onlyEditExtent(text: string): boolean {
  return aboutEditExtent(text ?? '') && !reportsFault(text, { editLane: true })
}
export function blockedCheckHolds(c: { id: string; observed?: string; evidence?: string[] }, sent: string[], texts: string[] | undefined, opts: { editLane?: boolean } = {}): boolean {
  if (isPackageScenario(c.id)) return true
  if (!opts.editLane && /print/i.test(c.id)) return true
  const obs = c.observed ?? ''
  if (!reportsFault(obs, opts)) return false
  const names = namesASentFile(obs, sent) || namesSentFile(obs, sent) || namesSentBase(obs, sent) || placeNamesSentStem(obs, sent) || (c.evidence ?? []).some(e => !/^https?:/i.test(e) && namesASentFile(e, sent))
  if (names || (longQuotes(obs).length > 0 && quotesASentFile(obs, texts))) return true
  if (c.id.startsWith('finding-') || isBookkeepingCheck(c.id) || isToolCheck(c.id)) return false
  return filesIn(stripUrls(obs)).length === 0
}
const stripUrls = (text: string): string => (text ?? '').replace(/https?:\/\/\S+/gi, ' ')

const STYLE = new RegExp([
  '\\b(?:sequence|pattern|list|run|series|string|set|group|chain|stack)s? of three\\b', '\\bthree[- ](?:step|part|beat|item|clause|verb)s?\\b', '\\bthree (?:steps|clauses|verbs|beats|items|parts)\\b', '\\btriplets?\\b', '\\btricolon', '\\brule[- ]of[- ]three\\b', 'a and b,? then c',
  '\\brhythm', '\\bcadence', '\\bword choice', '\\bchoice of words?\\b', '\\bwording\\b', '\\bphrasing\\b', '\\bstock (?:phrase|phrasing|line|opener|opening|closer|closing|expression)s?\\b', '\\bclich[e\\u00e9]', '\\bbuzzwords?\\b', '\\bfiller\\b',
  '\\bflowery\\b', '\\bverbose\\b', '\\bwordy\\b', '\\bstilted\\b', '\\bawkward', '\\bclunky\\b', '\\brepetiti', '\\bsentence (?:length|structure|shape|rhythm)', '\\bparallel(?:ism| structure)', '\\bstyle\\b', '\\bstylistic', '\\bvoice tic', '\\bverbal tic',
  '\\bai[- ](?:sounding|tells?|cadence|phrasing|style)\\b', '\\bsounds? (?:templated|robotic|stiff|formulaic|canned)\\b', '\\bformulaic\\b'
].join('|'), 'i')
const NOT_STYLE = new RegExp([
  '\\bclaim', '\\bfacts?\\b', 'support', '\\btrue\\b', '\\buntrue\\b', '\\bfalse', 'accura', 'overstat', 'overclaim', 'exaggerat', 'verif', 'invent', 'fabricat', '\\bimpl(?:y|ies|ied)\\b', '\\bhonest', '\\bmislead',
  '\\bnames?\\b', '\\bnamed\\b', 'spell', 'misspel', '\\btypos?\\b', '\\bgrammar', '\\bnumbers?\\b', '\\bfigures?\\b', '\\bpercent', '%', '\\bstatistic', '\\bmetric', '\\bcounts?\\b', '\\bamount',
  '\\b\\d[\\d,.]*\\s*(?:k|m|bn|kr|dkk|eur|usd|million|billion|thousand|users?|people|customers?|clients?|engineers?|years?|months?|weeks?|hours?|days?|words?|characters?|pages?)\\b', '[$\\u20ac\\u00a3]\\s*\\d',
  '\\bdates?\\b', '\\bdated\\b', '\\bdateline', '\\bweekday', '\\bdeadline', '\\byears?\\b', '\\bmonths?\\b', '\\b(?:19|20)\\d\\d\\b',
  '\\bcompany', '\\bfirm\\b', '\\borgani[sz]ation', '\\broles?\\b', '\\bcontacts?\\b', '\\bsalutation', '\\brecipient', '\\baddressed', '\\bdear\\b',
  '\\bquestions?\\b', '\\basks?\\b', '\\basked\\b', '\\blimits?\\b', '\\bexceed', '\\btoo long', '\\bunanswered', '\\bnot answer', "\\bdoes(?: not|n['\\u2019]t) answer", '\\bmissing\\b', '\\brequire',
  '\\bsecond[- ]person', '\\bfirst[- ]person', '\\bown voice', '\\bgeneric praise', '\\boff[- ](?:topic|question)',
  '\\bdash', '[\\u2014\\u2013]', '\\bcut\\b', '\\bold print', '\\bstale\\b', '\\bwrong\\b', '\\bincorrect', '\\berrors?\\b', '\\bduplicat', '\\bplaceholder', '\\blorem\\b', '\\blinks?\\b', '\\burl\\b', '\\bai\\b(?![- ](?:sounding|tells?|cadence|phrasing|style)\\b)','\\bdamon\\b', '\\bchatgpt\\b', '\\bgpt\\b', '\\bclaude\\b'
].join('|'), 'i')
const PLACE_NUMBER = /\b(?:q|question|paragraph|para|line|bullet|section|sentence|point|item|answer|page|box|field)\s*\d+\b|\bq\d+\b/gi
const withoutQuotes = (text: string): string => unquoted(text ?? '')
  .replace(/(^|[\s(\[])'(?=\S)[\s\S]*?\S'(?=$|[\s.,;:!?)\]])/g, '$1 ')
  .replace(/(^|[\s(\[])\u2018(?=\S)[\s\S]*?\S\u2019(?=$|[\s.,;:!?)\]])/g, '$1 ')
export function onlyStyle(...texts: string[]): boolean {
  const plain = texts.filter(t => !!t).map(t => stripUrls(withoutQuotes(t)).replace(FILE_IN, ' ').replace(PLACE_NUMBER, ' '))
  if (!plain.length || !plain.some(t => STYLE.test(t))) return false
  return !plain.some(t => NOT_STYLE.test(t))
}

export function packageFindingHolds(f: { where: string; what: string }, sent: string[], opts: { evidence?: string[]; sentTexts?: string[] } = {}): boolean {
  const where = f.where ?? '', what = f.what ?? ''
  if (namesASentFile(where, sent) || placeNamesSentStem(where, sent) || namesSentFile(what, sent)) return true
  if ((opts.evidence ?? []).some(e => !/^https?:/i.test(e) && namesASentFile(e, sent))) return true
  return quotesASentFile(where + '\n' + what, opts.sentTexts)
}
export function filedOnlyInUnsentFiles(where: string, sent: string[]): boolean {
  const files = filesIn(where ?? '')
  return files.length > 0 && files.every(p => outsideFiles(p, sent))
}

export function scenarioHolds(id: string): boolean {
  return id !== 'handoff' && id !== 'recovery'
}

export function withBeside(onCard: string[], previousFiles: string[], beside: string[], exists: (path: string) => boolean): string[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  const have = new Set(onCard.map(norm))
  const folders = [...new Set(onCard.map(f => f.replace(/\\/g, '/')).filter(f => f.includes('/') && !f.startsWith('attachments/')).map(f => f.slice(0, f.lastIndexOf('/')).toLowerCase()))]
  const sticky = previousFiles.filter(p => { const n = norm(p); return !have.has(n) && isOutgoingName(nameOf(n)) && folders.some(d => n.startsWith(d + '/')) })
  const out = [...onCard]
  const siblings = [...onCard, ...beside, ...previousFiles].map(f => nameOf(f.replace(/\\/g, '/')))
  for (const p of [...beside, ...sticky]) { const n = norm(p); if (!have.has(n) && !isBackupName(nameOf(n), siblings) && exists(p)) { have.add(n); out.push(p.replace(/\\/g, '/')) } }
  return out
}
const NOT_OUTGOING_STEM = /^(?:.*[-_.])?(?:submission|how-?to|readme|notes|checklist|prep|brief|answers?|review|tracker|pipeline|decisions|intel|research)(?:[-_.].*)?\.[A-Za-z0-9]{1,5}$/i
const isOutgoingName = (name: string): boolean => (/\.pdf$/i.test(name) || /(?:^|[-_])(?:e-?mail|mail|message)(?:[-_.]|$)/i.test(name)) && !NOT_OUTGOING_STEM.test(name)
export function sentBeside(sent: string[], texts: string[]): string[] {
  const folders = [...new Set(sent.map(f => f.replace(/\\/g, '/')).filter(f => f.includes('/') && !f.startsWith('attachments/')).map(f => f.slice(0, f.lastIndexOf('/'))))]
  if (!folders.length) return []
  const out = new Set<string>()
  for (const text of texts) {
    for (const m of (text ?? '').replace(/https?:\/\/\S+/gi, ' ').matchAll(FILE_IN)) {
      const p = m[0].replace(/\\/g, '/'), name = nameOf(p)
      if (!isOutgoingName(name)) continue
      if (p.includes('/')) { if (folders.some(d => p.toLowerCase().startsWith(d.toLowerCase() + '/'))) out.add(p) }
      else for (const d of folders) out.add(d + '/' + p)
    }
  }
  const siblings = [...sent, ...out].map(f => nameOf(f.replace(/\\/g, '/')))
  return [...out].filter(p => !sent.some(s => s.replace(/\\/g, '/').toLowerCase() === p.toLowerCase()) && !isBackupName(nameOf(p), siblings))
}

const CLAIM_FAULT = /unsupported|not supported|no (?:verified )?facts? (?:supports?|backs?|says?|for)|not (?:in|backed by) (?:his|the) facts|overstat|exaggerat|overclaim|fabricat|\binvent(?:s|ed)\b|\buntrue\b|\bnot true\b|\bfalsely\b|\bfalse (?:claim|statement)|misstat|inflat|says more than|goes beyond (?:his|the) facts?/i
const unquotedAll = (text: string): string => unquoted(text ?? '').replace(/(^|[^\w])['\u2018][^'\u2018\u2019\n]*['\u2019](?=[^\w]|$)/g, '$1 ')
const GENERIC_DOC = /\b(?:report|proposal|letter|answers?|form|e-?mail|q\d+)\b/i
export function wordsHold(text: string, sent?: string[]): boolean {
  const plain = unquotedAll(text ?? '')
  if (CLAIM_FAULT.test(plain)) return true
  const doc = (s: string): boolean => GENERIC_DOC.test(stripFiles(s)) || (sent ? namesASentFile(s, sent) : DOC.test(s))
  return sentences(plain).some(s => doc(s) && FAULT.test(s))
}
export function notesHeadings(text: string): string[] {
  const out: string[] = []
  let level = 0, inside = false
  for (const line of (text ?? '').split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!h) continue
    const lv = h[1]!.length
    if (inside && lv <= level) inside = false
    if (!inside && lv > 1 && ANSWERS_HEADING.test(h[2]!)) { inside = true; level = lv; continue }
    if (!inside && lv > 1) out.push(h[2]!.trim())
  }
  return out
}
export function sectionUnder(text: string, heading: string): string {
  const lines = (text ?? '').split(/\r?\n/)
  const parts: string[] = []
  let level = 0
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (level) { if (h && h[1]!.length <= level) break; parts.push(line); continue }
    if (h && h[2]!.trim() === heading) level = h[1]!.length
  }
  return parts.join('\n')
}
const PLACE_FILLER = new Set(['heading', 'headings', 'section', 'sections', 'paragraph', 'paragraphs', 'bullet', 'bullets', 'line', 'lines', 'under', 'intro', 'item', 'items', 'list', 'note', 'notes', 'part', 'near', 'sentence', 'third', 'second', 'first', 'fourth', 'fifth', 'what', 'that', 'this', 'with', 'from'])
export function placeNamesNotesHeading(where: string, headings: string[]): string | undefined {
  const lower = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const quotes = [...(where ?? '').matchAll(/"([^"]{6,})"|\u201c([^\u201d]{6,})\u201d|'([^'\n]{6,})'|\u2018([^\u2019]{6,})\u2019|`([^`]{6,})`/g)].map(m => lower(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '')).filter(q => !/^[\w./-]+\.[a-z0-9]{1,5}$/.test(q))
  const byQuote = headings.find(h => quotes.some(q => lower(h).includes(q)))
  if (byQuote) return byQuote
  const words = [...new Set((stripFiles(unquotedAll(where ?? '')).toLowerCase().match(/[a-z\u00e6\u00f8\u00e5]{4,}/g) ?? []).filter(w => !PLACE_FILLER.has(w)))]
  return headings.find(h => words.filter(w => lower(h).includes(w)).length >= 2)
}
export function quotesSentOutsideSection(text: string, sentTexts: string[] | undefined, section: string): boolean {
  const quotes = longQuotes(text)
  if (!quotes.length) return false
  const bodies = (sentTexts ?? []).filter(t => !!t).map(flat)
  if (!bodies.length) return true
  const own = flat(section ?? '')
  return quotes.some(q => { const n = flat(q); return bodies.some(b => b.includes(n)) && !own.includes(n) })
}
export function placeInAnswersText(where: string, answers: string): boolean {
  const body = flat(answers ?? '')
  const quotes = [...(where ?? '').matchAll(/"([^"]{6,})"|'([^'\n]{6,})'|`([^`]{6,})`/g)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter(q => !/^[\w./-]+\.[A-Za-z0-9]{1,5}$/.test(q))
  if (quotes.some(q => body.includes(flat(q)))) return true
  const words = [...new Set((stripFiles(unquotedAll(where ?? '')).toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !PLACE_FILLER.has(w)))]
  const lines = (answers ?? '').split(/\r?\n/).map(l => l.toLowerCase())
  if (lines.some(l => words.filter(w => l.includes(w)).length >= 2)) return true
  return words.length === 1 && lines.some(l => new RegExp('^[\\s>*-]*' + words[0] + '\\b[^:\\n]{0,30}:').test(l))
}

export interface SealedTexts {
  docs: { file: string; text: string | null }[]
  sheets: { file: string; answers: string; headings: string[] }[]
  filedIn?: { file: string; text: string }[]
}
const SEALED_DOC = /\b(?:reports?|proposals?|letters?|answers?|e-?mails?|q\d+)\b/i
const faultIn = (text: string): boolean => reportsFault(text) || CLAIM_FAULT.test(unquotedAll(text ?? ''))
function sealedFileNamed(text: string, files: string[]): string | undefined {
  const t = unquotedAll(text ?? '')
  return files.find(f => namesASentFile(t, [f]) || placeNamesSentStem(t, [f]))
}
function sealedDocNamed(text: string, files: string[]): string | undefined {
  return sealedFileNamed(text, files) ?? SEALED_DOC.exec(stripFiles(unquotedAll(text ?? '')))?.[0]
}
const LABEL_STOP = new Set(['field', 'fields', 'value', 'values', 'email', 'e-mail', 'phone', 'title', 'city', 'name', 'comment', 'country', 'street', 'notes', 'note', 'answer', 'question'])
export function answerLabels(answers: string): string[] {
  const out = new Set<string>()
  const clean = (s: string): string => s.replace(/\*+/g, '').replace(/\([^)]*\)/g, ' ').replace(/[:"\u201c\u201d]/g, ' ').replace(/\s+/g, ' ').trim()
  for (const line of (answers ?? '').split(/\r?\n/)) {
    const row = /^\s*\|\s*([^|]+?)\s*\|/.exec(line)
    const bullet = /^\s*[-*]\s+(?:"([^"\n]{2,80})"|\*\*([^*\n]{2,60})\*\*|([^:\n"]{2,40}?))\s*:/.exec(line)
    const raw = row ? row[1]! : bullet ? (bullet[1] ?? bullet[2] ?? bullet[3] ?? '') : ''
    const label = clean(raw)
    if (!label || /^-+$/.test(label) || label.length < 5 || LABEL_STOP.has(label.toLowerCase())) continue
    out.add(label)
  }
  return [...out]
}
const labelIn = (text: string, labels: string[]): string | undefined => {
  const t = flat(unquotedAll(text ?? ''))
  return labels.find(l => new RegExp('(?:^|[^\\p{L}\\p{N}])' + flat(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\p{L}\\p{N}])', 'u').test(t))
}
const SHEET_SUBJECT = /^(?:\*\*[^*\n]{1,80}\*\*:?\s*)?(?:(?:it|this|that|the (?:sheet|notes?|bullet|line|list|heading|intro|item|entry|record|section|sentence|paragraph))\s+)?(?:(?:still|now|also|only)\s+)?(?:says|said|reads|states|lists|records|calls|gives|suggests|implies|names|dates|describes|mentions|counts|claims)\b/i
const DOC_VERB = /^(?:\s+[\p{L}\p{N}-]+){0,3}?\s+(?:is|are|was|were|has|have|had|claims?|says?|said|states?|reads?|lists?|mentions?|calls?|gives?|names?|describes?|puts?|uses?|contains?|includes?|shows?|credits?|cites?|attributes?|asserts?|implies|suggests|overstat\w*|exaggerat\w*|misstat\w*|inflat\w*|presents?|frames?|writes?|wrote|counts?|dates?|spells?|gets?|got)\b/iu
const PLAIN_PASSIVE = /^(?:\s+[\p{L}\p{N}-]+){0,3}?\s+(?:is|are|was|were|has been|have been|had been)\s+(?:not\s+|never\s+|only\s+|also\s+|since\s+)?(?:[a-z]+-)?(?:[a-z]+(?:ed|en)|read|run|sent|done|made|kept|left)\b(?!\s+(?:as|to be)\b)/iu
const AFTER_CONTRAST = /(?:^|[\s,])(?:but|while|whereas|however|although|though|yet)\b([\s\S]*)$/i
function docIsOnlyObject(sentence: string, docs: string[]): boolean {
  const label = /^\*\*([^*\n]{1,80})\*\*/.exec(sentence)
  if (label && sealedDocNamed(label[1]!, docs)) return false
  const body = stripFiles(sentence)
  const contrast = AFTER_CONTRAST.exec(body)
  if (contrast && (sealedDocNamed(contrast[1]!, docs) || docs.some(f => namesASentFile(contrast[1]!, [f])))) return false
  for (const m of body.matchAll(new RegExp(SEALED_DOC.source, 'gi'))) {
    const rest = body.slice(m.index! + m[0].length)
    if (/^['\u2019]s\b/.test(rest)) return false
    if (DOC_VERB.test(rest)) {
      const passive = PLAIN_PASSIVE.exec(rest)
      if (!passive || faultIn(passive[0])) return false
    }
  }
  for (const f of docs) {
    const n = nameOf(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const m of sentence.matchAll(new RegExp(n, 'gi'))) {
      const rest = sentence.slice(m.index! + m[0].length)
      if (DOC_VERB.test(rest) && !PLAIN_PASSIVE.test(rest)) return false
    }
  }
  return true
}
function placeQuotesOnlySheet(where: string, sheetText: string): boolean {
  const quotes = [...(where ?? '').matchAll(/"([^"]{6,})"|\u201c([^\u201d]{6,})\u201d|`([^`]{6,})`/g)].map(m => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter(q => !/^[\w./-]+\.[A-Za-z0-9]{1,5}$/.test(q))
  const body = flat(sheetText ?? '')
  return quotes.every(q => body.includes(flat(q)))
}
function aboutSheetLine(where: string, plain: string, docs: string[], sealed: SealedTexts): boolean {
  if (!where) return false
  const named = (sealed.filedIn ?? []).filter(f => namesASentFile(where, [f.file]))
  if (!named.length) return false
  const outsideAnswers = named.every(f => { const fa = formAnswers(f.text); return !!fa && !placeInAnswers(where, fa.headings) && !placeInAnswersText(where, fa.answers) && placeQuotesOnlySheet(where, f.text) })
  if (!outsideAnswers) return false
  return sentences(plain).filter(s => !!sealedDocNamed(s, docs)).every(s => SHEET_SUBJECT.test(s.trim()) && docIsOnlyObject(s.trim(), docs))
}
export function sealedWordFault(item: { where?: string; what: string; evidence?: string[]; finding?: { where: string; what: string } }, sealed: SealedTexts): string | null {
  const docs = sealed.docs.map(d => d.file)
  if (!docs.length && !sealed.sheets.length) return null
  const what = item.what ?? ''
  const where = item.where ?? item.finding?.where ?? ''
  if (!faultIn(what)) return null
  if (onlyStyle(what, ...(item.finding ? [item.finding.what] : []))) return null
  const quotes = longQuotes(`${where}\n${what}`)
  if (quotes.length && docs.length) {
    const read = sealed.docs.filter(d => d.text !== null)
    const own = (sealed.filedIn ?? []).filter(f => !!where && namesASentFile(where, [f.file])).map(f => { const h = placeNamesNotesHeading(where, notesHeadings(f.text)); return h ? flat(sectionUnder(f.text, h)) : '' }).join(' | ')
    const hit = read.find(d => quotes.some(q => { const n = flat(q); return flat(d.text!).includes(n) && !(own && own.includes(n)) }))
    if (hit) return `quotes ${nameOf(hit.file)}`
    if (!read.length) return 'quotes a file that leaves, and Damon could not read the files that leave to compare'
  }
  const placed = where ? sealedDocNamed(where, docs) : undefined
  if (placed) return `names ${nameOf(placed)}`
  const sheetWords = (sealed.filedIn ?? []).map(f => flat(f.text)).join(' | ')
  const quotedPlace = [...where.matchAll(/"([^"]{4,})"|\u201c([^\u201d]{4,})\u201d|'([^'\n]{4,})'|\u2018([^\u2019]{4,})\u2019/g)].map(m => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()).filter(q => !sheetWords.includes(flat(q))).map(q => SEALED_DOC.exec(stripFiles(q))?.[0] ?? sealedFileNamed(q, docs)).find(Boolean)
  if (quotedPlace) return `names ${nameOf(quotedPlace)}`
  const byEvidence = (item.evidence ?? []).map(e => /^https?:/i.test(e) ? undefined : sealedFileNamed(e, docs)).find(Boolean)
  if (byEvidence) return `names ${nameOf(byEvidence)}`
  const plain = unquotedAll(what)
  if (aboutSheetLine(where, plain, docs, sealed)) return sealedSheetFault(item, where, quotes, sealed)
  const said = sentences(plain).find(s => FAULT.test(s) && !!sealedDocNamed(s, docs))
  if (said) return `names ${nameOf(sealedDocNamed(said, docs)!)}`
  if (CLAIM_FAULT.test(plain) && sealedDocNamed(plain, docs)) return `names ${nameOf(sealedDocNamed(plain, docs)!)}`
  return sealedSheetFault(item, where, quotes, sealed)
}
function sealedSheetFault(item: { where?: string; what: string; finding?: { where: string; what: string } }, where: string, quotes: string[], sealed: SealedTexts): string | null {
  const what = item.what ?? ''
  for (const s of sealed.sheets) {
    const label = labelIn(`${where}\n${what}`, answerLabels(s.answers))
    if (label) return `names the form answer "${label}"`
    const inSheet = (p: string): boolean => !!p && namesASentFile(p, [s.file])
    const places = [where, item.finding?.where ?? ''].filter(inSheet)
    if (places.some(p => placeInAnswers(p, s.headings) || placeInAnswersText(p, s.answers))) return `is placed in the form answers of ${nameOf(s.file)}`
    if (quotes.some(q => flat(s.answers).includes(flat(q)))) return `quotes the form answers of ${nameOf(s.file)}`
  }
  return null
}
