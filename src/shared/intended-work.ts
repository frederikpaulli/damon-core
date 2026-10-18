export interface IntendedWork {
  outcome: string
  assumptions: string[]
  scenarios: { id: string; when: string; expected: string; check: string }[]
}

export function intentFromBrief(title: string, instructions: string, acceptance: string): IntendedWork {
  return {
    outcome: title,
    assumptions: ['Derived from the original brief. Identify missing requirements; do not invent owner preferences.'],
    scenarios: [
      { id: 'requested-outcome', when: instructions, expected: acceptance || title, check: 'Independently exercise or inspect the actual result against this original brief and acceptance criteria.' },
      { id: 'sources-and-failure', when: 'An input is missing, inconsistent or outdated, or the intended workflow cannot complete', expected: 'The result preserves source facts and owner constraints, and handles or clearly reports the limitation.', check: 'Compare the actual sources and handoffs. Exercise meaningful failure cases for executable work; inspect completeness and limitations for documents.' }
    ]
  }
}

export function intentProblem(value: IntendedWork): string | null {
  if (!value || typeof value.outcome !== 'string' || !value.outcome.trim()) return 'Record the intended outcome.'
  if (!Array.isArray(value.assumptions) || value.assumptions.some(a => typeof a !== 'string')) return 'Record assumptions, including an empty list when none apply.'
  if (!Array.isArray(value.scenarios) || !value.scenarios.length || value.scenarios.length > 30) return 'Record between one and thirty concrete scenarios.'
  const ids = new Set<string>()
  for (const s of value.scenarios) {
    if (!s || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(s.id) || ids.has(s.id)) return 'Scenario IDs must be unique and stable.'
    ids.add(s.id)
    if (![s.when, s.expected, s.check].every(v => typeof v === 'string' && v.trim().length > 0)) return 'Each scenario needs a trigger, expected result and independent check.'
  }
  return null
}

export function intentBrief(intent?: IntendedWork): string {
  if (!intent) return 'Legacy job: no structured intended-behaviour record exists. Identify missing coverage explicitly.'
  return `INTENDED BEHAVIOUR (claims to challenge, not proof):\n${JSON.stringify(intent)}\nChallenge missing scenarios too. Include recovery, handoffs and source completeness where relevant. Preserve owner constraints.`
}

export interface ScenarioResult {
  id: string
  status: 'pass' | 'fail' | 'blocked'
  observed: string
  evidence: string[]
}

export const CHECK_INSTRUCTIONS = `Before the final verdict, write CHECK RESULTS: followed by a JSON array, on one line. Each item: {"id":"scenario-id","status":"pass|fail|blocked","observed":"what actually happened","evidence":["exact file path, URL or command inspected in this run"]}. Cover every required scenario exactly once. Prefer paths copied from successful Read calls. For test execution, cite the exact successful tool command verbatim, not a temporary script filename or a reconstructed absolute path. Evidence entries must have NO arrows, explanations or line-number suffixes; put those details in observed. An evidence entry is the path or address you inspected, never the name of the tool you used (write the page's path, not look_at_my_page). For a card on the owner's list, write "project overview attention card <card id>". Use your own inspection tools; worker claims are not evidence. A tool call corroborates inspection, not successful execution. If a tool fails or the outcome cannot be established, mark blocked. Never send, submit, publish or charge merely to test. A budget limit leaves remaining checks blocked.`

export function checkInstructions(tools?: ReadonlySet<string>): string {
  if (!tools) return CHECK_INSTRUCTIONS
  const reads = ['Read', 'read_project_file'].filter(name => tools.has(name))
  return CHECK_INSTRUCTIONS
    .replace('Prefer paths copied from successful Read calls.', reads.length ? `Prefer paths copied from successful ${reads.join(' or ')} calls.` : 'Prefer the exact paths you opened.')
    .replace(" (write the page's path, not look_at_my_page)", tools.has('look_at_my_page') ? " (write the page's path, not look_at_my_page)" : " (write the page's path)")
}

export function readPathOf(use: { tool: string; detail?: string }): string | undefined {
  if (!use.detail) return undefined
  if (/^(Read|read_file)$/i.test(use.tool)) return use.detail
  if (/^(?:mcp__damon_broker__)?read_project_file$/.test(use.tool)) {
    try { const path = (JSON.parse(use.detail) as { path?: unknown }).path; return typeof path === 'string' ? path : undefined } catch { return undefined }
  }
  return undefined
}

export function vetoingProblems(problems: string[], recordedVerdict: boolean, criteria: readonly { id: string; status: string; observed?: string }[] = []): string[] {
  if (!recordedVerdict) return problems
  const failed = criteria.filter(c => c.status === 'fail')
  const failLine = (p: string): boolean => failed.some(c => p.startsWith(`[${c.id}] fail: `))
  const kept = problems.filter(p => /^[^:\n]+: (fail|blocked): /.test(p) || /^An inspected input /.test(p) || failLine(p))
  for (const c of failed) if (!kept.some(p => p.startsWith(`[${c.id}] fail: `))) kept.push(`[${c.id}] fail: ${c.observed ?? ''}`.trim())
  return kept
}

export function checkResults(text: string, intent: IntendedWork, observedTools: { tool: string; detail?: string; summary: string; ok?: boolean }[]): { results: ScenarioResult[]; problems: string[] } {
  const blocks = [...text.matchAll(/^CHECK RESULTS:[ \t]*(.*)$/gm)]
  const problems: string[] = []
  let results: ScenarioResult[] = []
  if (blocks.length !== 1) return { results, problems: ['Exactly one CHECK RESULTS block is required.'] }
  try {
    const parsed: unknown = JSON.parse(blocks[0]![1]!)
    if (!Array.isArray(parsed)) throw new Error()
    results = parsed
  } catch { return { results: [], problems: ['CHECK RESULTS must be a JSON array.'] } }
  const seen = new Set<string>()
  for (const result of results) {
    if (result && typeof result.id === 'string' && !seen.has(result.id) && !intent.scenarios.some(s => s.id === result.id)) continue
    if (!result || typeof result.id !== 'string' || seen.has(result.id)) {
      problems.push('Unknown, missing or duplicate scenario ID.'); continue
    }
    seen.add(result.id)
    if (!['pass', 'fail', 'blocked'].includes(result.status) || typeof result.observed !== 'string' || !result.observed.trim() || !Array.isArray(result.evidence) || !result.evidence.length || result.evidence.some(e => typeof e !== 'string' || e.trim().length < 4)) {
      problems.push(`${result.id}: incomplete result or evidence.`); continue
    }
    if (result.status !== 'pass') problems.push(`${result.id}: ${result.status}: ${result.observed}`)
    for (const e of result.evidence) {
      if (!independentlyInspected(e, observedTools)) problems.push(`${result.id}: evidence was not independently inspected: ${e}`)
    }
  }
  for (const s of intent.scenarios) if (!seen.has(s.id)) problems.push(`${s.id}: not tested.`)
  return { results, problems }
}

export function independentlyInspected(evidence: string, observedTools: { tool: string; detail?: string; summary: string; ok?: boolean }[]): boolean {
  const normalize = (s: string): string => s.replace(/\\/g, '/').trim()
  if (/^(project overview\b|yours:|attention card\b|owner card\b)/i.test(evidence.trim()) && observedTools.some(t => t.ok === true && /overview/i.test(t.tool))) return true
  if (/\bdecisions\b|DECISIONS\.md|\bverified facts\b/i.test(evidence) && observedTools.some(t => t.ok === true && (/overview/i.test(t.tool) || (/read_brain/i.test(t.tool) && !/"section"\s*:\s*"(?:map|glossary)"/i.test(t.detail ?? ''))))) return true
  const record = /^(?:record)(?:\s*\(?\s*id\b\s*[:=]?)?\s*["']?([a-z0-9][a-z0-9-]{2,})/i.exec(evidence.trim())
  if (record && observedTools.some(t => t.ok === true && /record/i.test(t.tool) && (!(t.detail ?? '').trim() || (t.detail ?? '').toLowerCase().includes(record[1]!.toLowerCase())))) return true
  return observedTools.some(t => t.ok === true && /read|bash|shell|exec|browse|fetch|search|view|open|screenshot|look|isolated|overview|list/i.test(t.tool) && normalize(t.detail || t.summary).includes(normalize(evidence)))
}
