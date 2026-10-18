export const CLOCK_STOP = 'waited on the clock'
export const CLOCK_RETRY_LINE = 'The last run waited on the clock and was stopped: set the date in the test instead.'
export const NEVER_WAIT_ON_THE_CLOCK = 'Never wait for the real clock or a time of day. A check that depends on the date sets the date itself: a fixed or injected clock, an environment variable or a test argument. A test that fails only on some dates is a finding to report, with the date it fails on, never something to wait out. No sleep longer than a minute or two.'

export const LONG_SLEEP_SECONDS = 300
const MAX_READ = 8000

export function stoppedOnTheClock(text: string | undefined): boolean {
  return !!text && /\bwaited on the clock\b/i.test(text)
}

export function clockWait(command: string): string | null {
  return readCommand(command.slice(0, MAX_READ), 0)
}

function readCommand(text: string, depth: number): string | null {
  if (!text.trim()) return null
  const code = codeOnly(text)
  const tainted = dateVariables(text)
  const readsDate = (from: number, to: number): boolean => {
    for (const m of code.slice(from, to).matchAll(DATE_WORD)) if (atCommandStart(code, from + m.index!)) return true
    return POWERSHELL_DATE.test(text.slice(from, to))
  }
  for (const m of code.matchAll(SLEEP_WORD)) {
    const at = m.index!
    if (!atCommandStart(code, at)) continue
    const words = wordsAfter(text, at + m[0].length)
    const said = excerpt(text.slice(at, at + m[0].length) + (words.length ? ' ' + words.join(' ') : ''))
    const { seconds, computed } = sleepLength(words)
    if (seconds >= LONG_SLEEP_SECONDS) return `${CLOCK_STOP}: "${said}" sleeps ${howLong(seconds)}`
    if (computed && words.some(w => fromTheDate(w, tainted))) return `${CLOCK_STOP}: "${said}" sleeps until a time worked out from the date`
  }
  for (const m of text.matchAll(START_SLEEP)) {
    const unit = (m[1] ?? '').toLowerCase(), value = m[2]!
    const said = excerpt(m[0])
    if (/^[$(]/.test(value)) {
      const rest = text.slice(m.index! + m[0].length - value.length).split(/[;\n|}]/)[0]!
      if (POWERSHELL_DATE.test(rest) || fromTheDate(rest, tainted)) return `${CLOCK_STOP}: "${excerpt(m[0].slice(0, -value.length) + rest)}" sleeps until a time worked out from the date`
      continue
    }
    const seconds = Number(value) / (unit.startsWith('m') ? 1000 : 1)
    if (seconds >= LONG_SLEEP_SECONDS) return `${CLOCK_STOP}: "${said}" sleeps ${howLong(seconds)}`
  }
  for (const m of text.matchAll(CMD_TIMEOUT)) {
    const seconds = Number(m[1]) < 0 ? Infinity : Number(m[1])
    if (seconds >= LONG_SLEEP_SECONDS) return `${CLOCK_STOP}: "${excerpt(m[0])}" sleeps ${howLong(seconds)}`
  }
  for (const m of code.matchAll(LOOP_WORD)) {
    const at = m.index!
    if (!atCommandStart(code, at)) continue
    const doAt = indexOfWord(code, 'do', at + m[0].length)
    if (doAt < 0) continue
    const doneAt = indexOfWord(code, 'done', doAt)
    const end = doneAt < 0 ? code.length : doneAt
    if (!readsDate(at + m[0].length, doAt)) continue
    for (const s of code.slice(doAt, end).matchAll(SLEEP_WORD)) if (atCommandStart(code, doAt + s.index!)) return `${CLOCK_STOP}: a loop sleeps until the date or the time changes ("${excerpt(text.slice(at, end + 4))}")`
  }
  for (const m of text.matchAll(POWERSHELL_LOOP)) if (POWERSHELL_DATE.test(m[1]!) && /\b(?:Start-Sleep|sleep)\b/i.test(m[2]!)) return `${CLOCK_STOP}: a loop sleeps until the date or the time changes ("${excerpt(m[0])}")`
  if (depth < 2) for (const m of text.matchAll(NESTED_SHELL)) {
    const found = readCommand(m[1]!.slice(1, -1), depth + 1)
    if (found) return found
  }
  return null
}

const SLEEP_WORD = /(?<![\w.$\/\\-])(?:\/(?:usr\/)?bin\/)?sleep(?![\w.\/\\-])/g
const DATE_WORD = /(?<![\w.$\/\\-])date(?![\w.\/\\-])/g
const LOOP_WORD = /(?<![\w.$\/\\-])(?:while|until)(?![\w.\/\\-])/g
const POWERSHELL_DATE = /\bGet-Date\b|\[(?:System\.)?DateTime\]::(?:Utc)?(?:Now|Today)\b/i
const START_SLEEP = /\bStart-Sleep\b(?:\s+-(s\w*|m\w*)(?:\s*:\s*|\s+))?\s*(\$|\(|\d+(?:\.\d+)?)/gi
const CMD_TIMEOUT = /\btimeout(?:\.exe)?\s+\/t\s+(-?\d+)/gi
const POWERSHELL_LOOP = /\b(?:while|until)\s*\(([^{}]{0,600})\{([^{}]{0,600})/gi
const NESTED_SHELL = /(?<![\w.\/-])(?:ba|z|da)?sh(?:\.exe)?\s+(?:-[a-z]+\s+)*-[a-z]*c\s+("(?:[^"\\]|\\.)*"|'[^']*')/gi

function codeOnly(text: string): string {
  const out: string[] = []
  const stack: { kind: 'code' | 'dq' | 'sq' | 'tick'; depth: number }[] = [{ kind: 'code', depth: 0 }]
  let i = 0
  while (i < text.length) {
    const c = text[i]!, top = stack[stack.length - 1]!
    if (top.kind === 'sq') { if (c === "'") stack.pop(); out.push(' '); i++; continue }
    if (c === '\\') { out.push(' ', ' '); i += 2; continue }
    if (top.kind === 'dq') {
      if (c === '"') stack.pop()
      if (c === '$' && text[i + 1] === '(') { stack.push({ kind: 'code', depth: 0 }); out.push('$'); i++; continue }
      if (c === '`') { stack.push({ kind: 'tick', depth: 0 }); out.push('`'); i++; continue }
      out.push(' '); i++; continue
    }
    if (c === "'") { stack.push({ kind: 'sq', depth: 0 }); out.push(' '); i++; continue }
    if (c === '"') { stack.push({ kind: 'dq', depth: 0 }); out.push(' '); i++; continue }
    if (c === '`') { if (top.kind === 'tick') stack.pop(); else stack.push({ kind: 'tick', depth: 0 }); out.push('`'); i++; continue }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]!))) { while (i < text.length && text[i] !== '\n') { out.push(' '); i++ } continue }
    if (c === '(') top.depth++
    if (c === ')') { top.depth--; if (top.depth <= 0 && top.kind === 'code' && stack.length > 1) { stack.pop(); out.push(')'); i++; continue } }
    out.push(c); i++
  }
  return out.join('').slice(0, text.length)
}

const WRAPPER = /(?:^|(?<=[\s;&|({`!]))(?:then|do|else|elif|if|while|until|time|nohup|exec|command|builtin|sudo|env|[A-Za-z_][A-Za-z0-9_]*=\S*)$/
const GNU_TIMEOUT = /(?:^|(?<=[\s;&|({`!]))timeout(?:[ \t]+-{1,2}[A-Za-z-]+(?:=\S+|[ \t]+(?=[^-\s])\S+)?)*[ \t]+[\d.]+[smhd]?$/
function atCommandStart(code: string, at: number): boolean {
  let before = code.slice(Math.max(0, at - 400), at)
  for (let n = 0; n < 8; n++) {
    before = before.replace(/[ \t]+$/, '')
    if (!before || /[;&|({`!\n]$/.test(before)) return true
    const unwrapped = before.replace(WRAPPER, '')
    if (unwrapped !== before) { before = unwrapped; continue }
    const untimed = before.replace(GNU_TIMEOUT, '')
    if (untimed !== before) { before = untimed; continue }
    return false
  }
  return false
}

function wordsAfter(text: string, from: number, max = 6): string[] {
  const words: string[] = []
  let i = from
  while (words.length < max) {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
    if (i >= text.length || /[;&|\n)}<>#]/.test(text[i]!)) break
    let word = '', depth = 0, quote = ''
    while (i < text.length && word.length < 400) {
      const c = text[i]!
      if (quote) { word += c; if (c === quote) quote = ''; i++; continue }
      if (c === '"' || c === "'") { quote = c; word += c; i++; continue }
      if (c === '(') depth++
      if (c === ')') { if (depth === 0) break; depth-- }
      if (depth === 0 && /[\s;&|<>}]/.test(c)) break
      word += c; i++
    }
    if (!word) break
    words.push(word)
  }
  return words
}

const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }
function sleepLength(words: string[]): { seconds: number; computed: boolean } {
  let seconds = 0, computed = false
  for (const raw of words) {
    const word = raw.replace(/^(["'])([\s\S]*)\1$/, '$2')
    if (/[$`]/.test(word)) { computed = true; continue }
    const n = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/i.exec(word)
    if (n) { seconds += Number(n[1]) * UNIT[n[2]!.toLowerCase()]!; continue }
    if (/^inf(?:inity)?$/i.test(word)) { seconds = Infinity; continue }
    if (word.startsWith('-')) continue
    break
  }
  return { seconds, computed }
}

function dateVariables(text: string): Set<string> {
  const tainted = new Set<string>()
  for (const m of text.matchAll(/(?<![\w$.-])\$?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/g)) {
    const shell = m[0].startsWith('$') ? false : !/[ \t]=$/.test(m[0])
    const start = m.index! + m[0].length
    const value = shell ? (wordsAfter(text, start, 1)[0] ?? '') : text.slice(start).split(/[;\n|]/)[0]!.slice(0, 400)
    if (DATE_IN.test(value) || POWERSHELL_DATE.test(value) || [...tainted].some(name => mentions(value, name))) tainted.add(m[1]!)
  }
  return tainted
}
const DATE_IN = /(?<![\w.$\/\\-])date(?![\w.\/\\-])/
function mentions(value: string, name: string): boolean {
  return new RegExp(`(?<![\\w])\\$?\\{?${name}(?![\\w])`).test(value)
}
function fromTheDate(value: string, tainted: Set<string>): boolean {
  return DATE_IN.test(value) || POWERSHELL_DATE.test(value) || [...tainted].some(name => mentions(value, name))
}

function indexOfWord(code: string, word: string, from: number): number {
  const re = new RegExp(`(?<![\\w.$\\/-])${word}(?![\\w.\\/-])`, 'g')
  re.lastIndex = from
  for (let m = re.exec(code); m; m = re.exec(code)) if (atCommandStart(code, m.index)) return m.index
  return -1
}

function excerpt(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 80 ? one.slice(0, 79) + '…' : one
}

function howLong(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'for ever'
  if (seconds >= 5400) return `about ${Math.round(seconds / 3600)} hours`
  if (seconds >= 3000) return 'about an hour'
  return `about ${Math.round(seconds / 60)} minutes`
}
