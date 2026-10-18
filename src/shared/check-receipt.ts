export interface RunStep {
  id?: string
  tool: string
  detail?: string
  summary?: string
  ok?: boolean
  proof?: readonly string[]
  background?: boolean
}

const SHELL = /^(?:Bash|shell|exec_command|local_shell)$/i
export const isShellTool = (tool: string): boolean => SHELL.test(tool ?? '')

const NUMBERED = /^\s*\d+(?:→|\t)/
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const clean = (line: string): string => line.replace(ANSI, '').replace(NUMBERED, '').replace(/\r$/, '')
const CARGO_SUMMARY = /^test result: /
const VITEST_SUMMARY = /^\s*(?:Test Files|Tests)\s{2,}\S/
const JEST_SUMMARY = /^(?:Tests|Test Suites):\s/
const STATUS = /^[A-Za-z_][\w -]{0,20}[=: ]\s*-?\d{1,3}$/
const FAILURE = /^test result: FAILED\b|^error: test failed\b|^error: \d+ targets? failed\b|^error: could not compile\b|\berror TS\d+\b|\bERR!|\bBuild failed\b|\berror during build\b|^error(?:\[E\d+\])?:/i
const SUMMARY_FAILED = /^\s*(?:Test Files|Tests|Test Suites:|Tests:)\b.*\bfailed\b/i
export const failureLine = (line: string): boolean => { const l = clean(line); return FAILURE.test(l.trim()) || SUMMARY_FAILED.test(l) }

export function proofLines(text: string): string[] {
  const lines = String(text ?? '').split('\n').map(clean)
  const picked: { i: number; line: string; must: boolean }[] = []
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    const must = failureLine(line) || STATUS.test(t)
    if (must || CARGO_SUMMARY.test(t) || VITEST_SUMMARY.test(line) || JEST_SUMMARY.test(t)) picked.push({ i, line: (CARGO_SUMMARY.test(t) || JEST_SUMMARY.test(t) || STATUS.test(t) || FAILURE.test(t) ? t : line).slice(0, 200), must })
  })
  const must = picked.filter((p) => p.must).slice(-200)
  const room = Math.max(0, 40 - must.length)
  const rest = room ? picked.filter((p) => !p.must).slice(-room) : []
  return [...must, ...rest].sort((a, b) => a.i - b.i).map((p) => p.line)
}

export interface Pipeline { op: string; stages: string[] }

export function pipelines(command: string): Pipeline[] {
  const s = String(command ?? '')
  const out: Pipeline[] = []
  let op = ''
  let stages: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  const endStage = (): void => { stages.push(cur); cur = '' }
  const endPipeline = (next: string): void => {
    endStage()
    const kept = stages.map(unwrap).filter(Boolean)
    if (kept.length) out.push({ op, stages: kept })
    stages = []
    op = next
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) { cur += c + s[++i]; continue }
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    const prev = cur.trimEnd().slice(-1)
    if (c === '\n' || c === ';') { endPipeline(c === ';' ? ';' : '\n'); continue }
    if (c === '&') {
      if (s[i + 1] === '&') { endPipeline('&&'); i++; continue }
      if (prev === '>' || s[i + 1] === '>' || /[<>]$/.test(cur)) { cur += c; continue }
      endPipeline('&')
      continue
    }
    if (c === '|') {
      if (s[i + 1] === '|') { endPipeline('||'); i++; continue }
      if (/>$/.test(cur)) { cur += c; continue }
      endStage()
      if (s[i + 1] === '&') i++
      continue
    }
    cur += c
  }
  endPipeline('')
  return out
}
function unwrap(stage: string): string {
  let t = stage.trim()
  while (t.startsWith('(') || t.startsWith('{ ')) t = t.replace(/^\(|^\{ /, '').trim()
  while (t.endsWith(')') && !/\$\([^)]*\)$/.test(t) && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1).trim()
  while (/(?:^|\s)}$/.test(t)) t = t.replace(/\s*}$/, '').trim()
  return t
}

const PREFIX = /^(?:env(?:\s+(?:-u\s+\S+|-i|--?[A-Za-z][\w-]*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)))*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)|time(?:\s+-p)?|timeout(?:\s+-\S+(?:\s+\d+[smhd]?)?)*\s+\d+(?:\.\d+)?[smhd]?|nice(?:\s+-n\s*-?\d+|\s+-\d+)?)\s+/
export function runnerAt(stage: string): string {
  let s = stage.trim()
  for (let guard = 0; guard < 12; guard++) {
    const m = PREFIX.exec(s)
    if (!m) break
    s = s.slice(m[0].length)
  }
  return s
}
export function runnerStages(command: string): string[] {
  return pipelines(command).flatMap((p) => p.stages.map(runnerAt)).filter(Boolean)
}

const TEST_RUNNER = /^(?:cargo\s+(?:test|nextest)|(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?test\b|(?:npx|bunx|pnpm(?:\s+exec)?|yarn)\s+(?:vitest|jest|mocha|playwright\s+test)\b|vitest\b|jest\b|mocha\b|playwright\s+test|go\s+test|pytest|python3?\s+-m\s+(?:pytest|unittest)|dotnet\s+test|mvn\b|(?:\.\/)?gradlew?\s+test|mix\s+test|(?:bundle\s+exec\s+)?rspec|phpunit|ctest|deno\s+test)/i
const BUILD = /^(?:(?:npx|bunx|yarn|pnpm(?:\s+exec)?)\s+)?(?:tsc|vue-tsc|svelte-check|vite\s+build|ng\s+build)\b|^(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+(?:run\s+)?(?:build|typecheck|type-check|check|tsc)\b/i
const SCRIPT = /^(?:npm|pnpm|yarn|bun)(?:\s+--prefix\s+\S+)?\s+run\s+\S/i
const isBuild = (r: string): boolean => BUILD.test(r) && !TEST_RUNNER.test(r)
const isRunner = (r: string): boolean => TEST_RUNNER.test(r) || BUILD.test(r) || SCRIPT.test(r)

const HARMLESS_VALUE = new Set(['--manifest-path', '--target-dir', '--prefix', '--config', '-c', '--color', '--jobs', '-j', '--reporter', '--pool', '--maxworkers', '--max-workers', '--profile', '--mode', '--environment', '--test-threads', '--testtimeout', '--hooktimeout'])
const HARMLESS = new Set(['--workspace', '--all', '--all-targets', '--all-features', '--no-fail-fast', '--release', '--locked', '--offline', '--frozen', '--quiet', '-q', '--run', '--ci', '--silent', '--coverage', '--no-watch', '--nocapture', '--show-output', '--include-ignored', '--runinband', '-i', '--forceexit', '--detectopenhandles', '--no-cache', '--passwithnotests', '--no-file-parallelism', '--verbose', '-v', '--logheapusage', '--bail'])
const HARMLESS_EQ = /^(?:--color|--reporter|--maxworkers|--max-workers|--pool|--testtimeout|--hooktimeout|--bail|--test-threads|--jobs|--profile|--manifest-path|--target-dir|--config|--mode|--environment|--prefix)=|^--watchall=false$|^--watch=false$/
const unquote = (t: string): string => t.replace(/^(["'])(.*)\1$/, '$2')

export function narrowingArgs(rest: string): string[] {
  const tokens = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
  const bare: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = unquote(tokens[i]!)
    if (t === '--') continue
    if (/^\d?>>?$|^<$|^&>>?$/.test(t)) { i++; continue }
    if (/^\d?[<>]|^&>/.test(t)) continue
    if (t.startsWith('-')) {
      const low = t.toLowerCase()
      if (HARMLESS_VALUE.has(low)) { i++; continue }
      if (HARMLESS.has(low) || HARMLESS_EQ.test(low)) continue
      bare.push(t)
      continue
    }
    if (/^\.?\/?\.\.\.$/.test(t)) continue
    bare.push(t)
  }
  return bare
}

function stdoutFile(stage: string): string | undefined {
  const m = /(?:^|\s)(?:1|&)?>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/.exec(stage)
  if (!m || m[1]!.startsWith('&')) return undefined
  return unquote(m[1]!)
}
export function redirectTargets(command: string): string[] {
  const out: string[] = []
  for (const m of String(command ?? '').matchAll(/(?:^|\s)(?:\d|&)?>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    if (!m[1]!.startsWith('&')) out.push(baseName(unquote(m[1]!)))
  }
  return out.filter(Boolean)
}
const baseName = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/["']/g, '').split('/').pop()!.toLowerCase()
const ECHO = /^(?:echo|Write-Output|Write-Host)\s+(?:-\w+\s+)?["']?\s*([A-Za-z_][\w -]{0,20}?)\s*[=:]\s*\$(?:\?|LASTEXITCODE)(?!\w)/i
const READER = /(?:^|[\s;&|(])(?:cat|tail|head|type|less|more|Get-Content|gc|grep|egrep|rg|findstr|Select-String|sls)\b/i
function transparent(stage: string): boolean {
  const s = runnerAt(stage)
  if (/^(?:tail|cat|tee)\b/i.test(s)) return true
  if (/^Select-Object\s+-Last\b/i.test(s)) return true
  if (/^(?:grep|egrep|rg|findstr|Select-String|sls)\b/i.test(s)) return !/(?:^|\s)-[A-Za-z]*v[A-Za-z]*\b|--invert-match|-NotMatch/i.test(s) && /fail/i.test(s)
  return false
}
const statusOf = (proof: readonly string[], label: string): number[] => {
  const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s*[=: ]\\s*(-?\\d{1,3})$`, 'i')
  return proof.map((l) => re.exec(clean(l).trim())).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]))
}
const passes = (proof: readonly string[]): boolean => proof.some((raw) => {
  const l = clean(raw)
  return /^test result: ok\./.test(l.trim()) || (/^\s*Test Files\s/.test(l) && /\bpassed\b/.test(l)) || (/^Tests:\s/.test(l.trim()) && /\bpassed\b/.test(l))
})
const fails = (proof: readonly string[]): boolean => proof.some(failureLine)
const TEST_FAILURE = /^test result: FAILED\b|^error: test failed\b|^error: \d+ targets? failed\b/i
const testFails = (proof: readonly string[]): boolean => proof.some((raw) => { const l = clean(raw); return TEST_FAILURE.test(l.trim()) || SUMMARY_FAILED.test(l) })

export interface Receipt { index: number; command: string; kind: 'test' | 'build' }

export function receipts(steps: readonly RunStep[]): Receipt[] {
  const out: Receipt[] = []
  steps.forEach((st, index) => {
    const tool = st.tool ?? ''
    const command = String(st.detail ?? st.summary ?? '').trim()
    if (!command) return
    if (/^run_project_check$/i.test(tool)) {
      if (st.ok === true) for (const r of runnerStages(command)) if (isRunner(r)) out.push({ index, command: r, kind: isBuild(r) ? 'build' : 'test' })
      return
    }
    if (!isShellTool(tool) || st.ok !== true) return
    const own = st.proof ?? []
    const later = steps.slice(index + 1).filter((s) => s.ok === true)
    const readsOf = (file: string): (readonly string[])[] => {
      const name = baseName(file)
      if (!name) return []
      return later.filter((s) => (/^Read$/i.test(s.tool) && baseName(s.detail ?? '') === name) || (isShellTool(s.tool) && READER.test(s.detail ?? '') && (s.detail ?? '').toLowerCase().includes(name))).map((s) => s.proof ?? [])
    }
    const pipes = pipelines(command)
    pipes.forEach((p, k) => {
      p.stages.forEach((stage, j) => {
        const r = runnerAt(stage)
        if (!isRunner(r)) return
        if (isBuild(r)) {
          if (!st.background && !fails(own)) out.push({ index, command: r, kind: 'build' })
          return
        }
        const last = j === p.stages.length - 1
        const pipefail = pipes.slice(0, k).some((q) => q.stages.some((s) => /^set\b[^\n]*\bpipefail\b/.test(s.trim())))
        const after = pipes.slice(k + 1)
        const file = stdoutFile(stage)
        const next = after[0]
        const echo = next && [';', '\n', '&&', '||'].includes(next.op) ? ECHO.exec(next.stages[0] ?? '') : null
        const sameStepReads = (f: string): boolean => after.some((q) => q.stages.some((s) => READER.test(s) && s.toLowerCase().includes(baseName(f))))
        const sourcesFor = (f: string | undefined): (readonly string[])[] => (f ? [...readsOf(f), ...(sameStepReads(f) && !st.background ? [own] : [])] : st.background ? [] : [own])
        let counted = false
        if (!st.background && (last || pipefail) && after.every((q) => q.op === '&&') && !testFails(own)) counted = true
        else if (echo) {
          const echoFile = stdoutFile(next!.stages[0]!)
          const statusSources = sourcesFor(echoFile)
          const all = [...statusSources, ...(file && file !== echoFile ? readsOf(file) : [])]
          const label = echo[1]!.trim()
          const codes = all.flatMap((src) => statusOf(src, label))
          counted = codes.includes(0) && codes.every((c) => c === 0) && !all.some(testFails) && (!st.background || !!echoFile)
        } else if (p.stages.slice(j + 1).every(transparent)) {
          const sources = sourcesFor(file)
          counted = sources.some(passes) && !sources.some(testFails) && (!st.background || !!file)
        }
        if (counted) out.push({ index, command: r, kind: 'test' })
      })
    })
  })
  return out
}

export function countedRuns(steps: readonly RunStep[]): string[] {
  return receipts(steps).map((r) => r.command)
}
