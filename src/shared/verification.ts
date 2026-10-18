export interface ClaimEvidence {
  report: string
  toolCalls: { tool: string; summary: string; detail?: string }[]
  stderr: string
  exists: (path: string) => boolean
  handover?: string[]
}

export type FindingKind = 'nothing-happened' | 'missing-file' | 'refused' | 'outside-scope' | 'no-plan' | 'outside-folder' | 'stale-pdf' | 'document'

export interface Finding {
  kind: FindingKind
  text: string
  fingerprint?: string
}

export interface Verdict {
  ok: boolean
  findings: Finding[]
  note: string
  notes?: string[]
}

const MAX_FINDINGS = 8

const ACTION = /\b(created?|wrote|written|added|updated|edited|changed|fixed|built|installed|deployed|saved|removed|deleted|renamed|generated|implemented|set up)\b/i

const OWNED_UP =
  /\b(could ?n[o']t|cannot|can ?not|unable to|was not able|failed to|blocked|refused|denied|read-only|not permitted|no permission)\b/i

const REFUSAL = [
  /blocked by policy/i,
  /read-only sandbox/i,
  /read-only file system/i,
  /permission denied/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /operation not permitted/i,
  /not permitted by (the )?sandbox/i,
  /sandbox denied/i,
  /denied by (the )?sandbox/i,
  /refused to write/i,
  /write (was )?blocked/i,
  /requires approval/i
]

const PRODUCT_NAMES =
  /^(node|next|nuxt|vue|react|angular|svelte|solid|ember|express|nest|three|d3|p5|pixi|phaser|chart|alpine|htmx|moment|day|lodash|jquery|backbone|knockout|meteor|electron|deno|bun|vite|webpack|rollup|parcel|babel|tone|anime|gsap)\.js$/i
const WEB_ENDINGS =
  /\.(io|com|app|dev|org|net|ai|co|uk|dk|se|no|nu|fi|is|nl|be|ch|at|pl|es|it|pt|ie|us|ca|au|nz|de|fr|eu|me|tv|cc|gg|fm|info|biz|shop|store|online|tech|xyz|cloud|site|page|vercel|netlify)$/i

const looksLikeFile = (s: string): boolean => {
  if (s.includes('://') || s.startsWith('www.')) return false
  if (/\s/.test(s)) return false
  if (!/[\\/]/.test(s)) {
    if (PRODUCT_NAMES.test(s)) return false
    if (WEB_ENDINGS.test(s)) return false
  }
  if (WEB_ENDINGS.test(s.split(/[\\/]/).pop() ?? '') && !/\.(html?|md|txt|json|pdf|csv)$/i.test(s)) return false
  const m = /\.([A-Za-z][A-Za-z0-9]{0,5})$/.exec(s)
  if (!m) return false
  if (/^[A-Z][a-z]+$/.test(m[1]!)) return false
  if (/\.{2,}/.test(s)) return false
  const name = s.slice(0, s.length - m[0].length).split(/[\\/]/).pop() ?? ''
  if (!name) return false
  if (!/[\\/]/.test(s) && /^(exe|cmd|bat|msi)$/i.test(m[1]!)) return false
  return name.length >= 2 || m[1]!.length >= 2
}

const DENIED_BEFORE = /\b(no|not|without|missing|absent|lacks?|lacking|isn't a|is not a|there's no|there is no|does not have|doesn't have|never (made|created|wrote|touched))\b[^.!?\n]{0,30}$/i
const DENIED_AFTER = /^[^.!?\n]{0,6}\b(does not exist|doesn't exist|is missing|was missing|is not there|isn't there|is absent|was not (made|created|found|written|produced)|wasn't (made|created|found|written|produced)|not (made|created|written|produced|generated|touched|needed)|never (made|created|written|produced)|not present)\b/i

function denied(report: string, at: number, length: number): boolean {
  const before = report.slice(Math.max(0, at - 60), at)
  const after = report.slice(at + length, at + length + 40)
  return DENIED_BEFORE.test(before) || DENIED_AFTER.test(after)
}

export function claimedFiles(report: string): string[] {
  const out: string[] = []
  const push = (raw: string, at: number): void => {
    const cleaned = raw.trim().replace(/^[('"`]+|[)'"`,.;:]+$/g, '')
    if (cleaned.length === 0 || cleaned.length > 200) return
    if (!looksLikeFile(cleaned)) return
    if (/[*?%{}]/.test(cleaned)) return
    if (denied(report, at, raw.length)) return
    if (!out.includes(cleaned)) out.push(cleaned)
  }

  for (const m of report.matchAll(/`([^`\n]+)`/g)) push(m[1]!, m.index)
  for (const m of report.matchAll(/"([^"\n]+)"/g)) push(m[1]!, m.index)
  for (const m of report.matchAll(/'([^'\n]+)'/g)) push(m[1]!, m.index)
  for (const m of report.matchAll(/(?:^|[\s(])([\w.\\/@-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?=[\s,;:.)]|$)/g)) push(m[1]!, m.index + m[0].length - m[1]!.length)

  return out
}

export function refusalsIn(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && REFUSAL.some((r) => r.test(l)))
}

export function verifyReport(e: ClaimEvidence): Verdict {
  const findings: Finding[] = []
  const report = e.report.trim()
  const claimsAction = ACTION.test(report)
  const files = e.handover
    ? e.handover.map((f) => f.trim()).filter((f) => f.length > 0 && looksLikeFile(f) && !/\s/.test(f) && !/^\.[A-Za-z0-9]+$/.test(f.split(/[\\/]/).pop() ?? ''))
    : claimedFiles(report)

  if (report.length > 0 && (claimsAction || files.length > 0) && e.toolCalls.length === 0) {
    findings.push({
      kind: 'nothing-happened',
      text: 'The report describes work being done, and this job has no record of a single thing happening: not one file read or written, and not one command run.'
    })
  }

  const refused = refusalsIn(e.stderr)
  const ownedUp = refused.length > 0 && OWNED_UP.test(report)
  for (const line of refused) {
    if (findings.length >= MAX_FINDINGS) break
    findings.push({
      kind: 'refused',
      text: ownedUp
        ? `Something was refused while this ran, which the report does say: "${line.slice(0, 200)}"`
        : `Something was refused while this ran, and the report does not mention it: "${line.slice(0, 200)}"`
    })
  }

  const pages = files.filter((f) => /\.(html?|md)$/i.test(f)).map((f) => f.replace(/\.(html?|md)$/i, '.pdf').toLowerCase())
  let missing = 0
  for (const path of files) {
    if (/\.pdf$/i.test(path) && pages.includes(path.toLowerCase())) continue
    if (ownedUp) break
    if (e.exists(path)) continue
    missing += 1
    if (findings.length >= MAX_FINDINGS) continue
    findings.push({ kind: 'missing-file', text: `The report says ${path} was produced, and it is not there.` })
  }

  if (findings.length === 0) return { ok: true, findings: [], note: '' }

  const shown = findings.slice(0, MAX_FINDINGS)
  const hidden =
    missing > shown.filter((f) => f.kind === 'missing-file').length ||
    refused.length > shown.filter((f) => f.kind === 'refused').length
  const lines = [
    'Damon checked this report against what actually happened, and they do not match. The report is the claim; what follows is the record.',
    '',
    ...shown.map((f) => `- ${f.text}`)
  ]
  if (hidden) lines.push('- and more of the same, not listed.')
  lines.push(
    '',
    REVIEW_HELD
  )

  return { ok: false, findings: shown, note: lines.join('\n') }
}

export const REVIEW_HELD = "No reviewer has read this job, and none will on its own: Damon's check stopped the round before review, and the review is held for you. Send it back with these exact points (request_revision), or, if you have checked them and they do not hold, call approve_task with despite set to what you found. Until you do one of the two, nothing moves."

export interface CheckedJob {
  verification?: { findings?: Finding[]; overruledWhy?: string }
}

export function heldByCheck(job: CheckedJob): boolean {
  return (job.verification?.findings?.length ?? 0) > 0 && !job.verification?.overruledWhy
}

export function checkedBlock(job: CheckedJob): string {
  const found = job.verification?.findings ?? []
  if (found.length === 0) return ''
  const tail = heldByCheck(job) ? REVIEW_HELD : `You overruled this already: ${job.verification?.overruledWhy}`
  return `\nDAMON CHECKED THIS ALREADY, and what it found does not match the report. These are observations, not opinions, and they outrank anything the report says:\n${found.map((f) => `- ${f.text}`).join('\n')}\n${tail}\n`
}
