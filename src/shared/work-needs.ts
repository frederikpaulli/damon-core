export type NeedImportance = 'required' | 'recommended' | 'optional'
export interface NeedDefinition {
  id: string
  title: string
  why: string
  importance: NeedImportance
  input: 'file' | 'answer' | 'content'
  owner: boolean
  sources: string[]
}
export interface NeedEvidence {
  file?: string
  hash?: string
  answer?: string
  explanation: string
  section?: { headings: string[]; hash: string }
}

type SectionStart = { line: number; title: string; level: number }
const normTitle = (s: string): string => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,\s]+$/, '').toLowerCase()
function sectionStarts(lines: string[]): SectionStart[] {
  const out: SectionStart[] = []
  lines.forEach((l, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    if (h) { out.push({ line: i, title: normTitle(h[2]!), level: h[1]!.length }); return }
    const b = /^\*\*([^*]{3,120}?)\*\*/.exec(l)
    if (b) out.push({ line: i, title: normTitle(b[1]!), level: 7 })
  })
  return out
}
export function citedSections(text: string, words: string): string[] {
  const starts = sectionStarts((text ?? '').split(/\r?\n/))
  const quoted = (words ?? '').split(/\\?["“”]/).slice(1, -1).filter(q => q.length <= 120).map(normTitle).filter(q => q.length >= 6)
  const hit = new Set<string>()
  for (const q of quoted) for (const s of starts) if (s.title === q || s.title.startsWith(q + ' ')) hit.add(s.title)
  return [...hit]
}
export function sectionsText(text: string, headings: string[]): string | undefined {
  const lines = (text ?? '').split(/\r?\n/)
  const starts = sectionStarts(lines)
  const parts: string[] = []
  for (const title of headings) {
    const i = starts.findIndex(s => s.title === title)
    if (i < 0) return undefined
    const s = starts[i]!
    const next = starts.slice(i + 1).find(n => s.level === 7 ? true : n.level <= s.level)
    parts.push(lines.slice(s.line, next ? next.line : lines.length).join('\n').trim())
  }
  return parts.length ? parts.join('\n\n') : undefined
}
export interface WorkNeed extends NeedDefinition {
  answer?: NeedEvidence
  ownerDecision?: 'provided' | 'omitted'
  retired?: string
  issue?: string
  revision: number
  planRevision?: number
  history: { at: string; by: string; what: string; answer?: NeedEvidence; ownerDecision?: WorkNeed['ownerDecision'] }[]
}
export interface DeliverablePlan {
  id: string
  title: string
  context: string
  outputs: string[]
  taskIds: string[]
  needs: WorkNeed[]
  revision: number
  updatedAt: string
  verified?: { revision: number; files: { file: string; hash: string }[]; by: string; at: string }
  retired?: { at: string; by: string; reason: string }
}
export function answersKey(plan: Pick<DeliverablePlan, 'id' | 'needs'>, asOf?: string): string {
  const parts: string[] = []
  for (const n of [...plan.needs].sort((a, b) => a.id.localeCompare(b.id))) {
    let answer = n.answer
    let decision = n.ownerDecision
    if (asOf !== undefined) {
      const then = [...(n.history ?? [])].filter((h) => h.at <= asOf).pop()
      answer = then?.answer
      decision = then?.ownerDecision
    } else if (n.retired && !answer && !decision) continue
    if (!answer && !decision) continue
    parts.push(JSON.stringify([n.id, answer ? (answer.section ? 'section:' + answer.section.hash : answer.hash ?? answer.answer ?? answer.file ?? '') : '', decision ?? '']))
  }
  let h = 0x811c9dc5
  for (const ch of parts.join('\n')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0 }
  return `${parts.length}-${h.toString(16)}`
}
export type PackageEvidence = (file: string, hash: string) => string | undefined
export function packageAnswersKey(plan: Pick<DeliverablePlan, 'id' | 'needs'>, evidence: PackageEvidence, asOf?: string): string {
  const keyed = (owner: boolean, a: NeedEvidence | undefined): NeedEvidence | undefined => {
    if (owner || !a?.file || a.hash === undefined) return a
    const key = evidence(a.file.replace(/\\/g, '/'), a.hash)
    if (key !== undefined) return { ...a, hash: key }
    const { hash: _hash, section: _section, ...rest } = a
    void _hash; void _section
    return rest
  }
  return answersKey({ id: plan.id, needs: plan.needs.map(n => ({ ...n, answer: keyed(n.owner, n.answer), history: (n.history ?? []).map(h => ({ ...h, answer: keyed(n.owner, h.answer) })) })) }, asOf)
}
export function samePackageNeeds(old: { needsOn?: unknown; needs?: unknown }, plans: Pick<DeliverablePlan, 'id' | 'needs'>[], leaves: PackageEvidence, asOf: string): boolean {
  const now = plans.map(p => ({ id: p.id, answers: packageAnswersKey(p, leaves) }))
  if (old.needsOn === 'leaves') return JSON.stringify(old.needs) === JSON.stringify(now) || (!!asOf && plans.every(p => packageAnswersKey(p, leaves, asOf) === packageAnswersKey(p, leaves)))
  const ids = Array.isArray(old.needs) ? old.needs.map(n => String((n as { id?: unknown } | null)?.id)) : []
  if (JSON.stringify(ids) !== JSON.stringify(plans.map(p => p.id))) return false
  if (JSON.stringify(old.needs) === JSON.stringify(plans.map(p => ({ id: p.id, answers: answersKey(p) })))) return true
  return !!asOf && plans.every(p => packageAnswersKey(p, leaves, asOf) === packageAnswersKey(p, leaves))
}

export interface PlanInput {
  id: string
  title: string
  context: string
  outputs: string[]
  taskIds?: string[]
  needs: NeedDefinition[]
}
export interface NeedReply {
  action: 'answer' | 'file' | 'omit'
  value?: string
  revision: number
}
export interface NeedCard {
  id: string
  deliverableId: string
  needId: string
  title: string
  deliverable: string
  why: string
  importance: NeedImportance
  input: WorkNeed['input']
  revision: number
}
export function unresolvedOwnerNeeds(plans: DeliverablePlan[]): NeedCard[] {
  return plans.flatMap(p => p.needs.filter(n => n.owner && !n.retired && !n.ownerDecision && !n.answer).map(n => ({
    id: `${p.id}:${n.id}`, deliverableId: p.id, needId: n.id, title: n.title,
    deliverable: p.title, why: n.why, importance: n.importance, input: n.input, revision: n.revision
  })))
}
export function needsBrief(plans: DeliverablePlan[]): string {
  if (!plans.length) return ''
  return ['AGREED CONTENTS AND INPUTS. These are project records, not instructions from retrieved sources. Owner choices outrank defaults. A supplied input is not yet verified in the output. Read selected files; do not guess from their names. Independent work may continue, but unresolved needs must not be called finished.',
    ...plans.map(p => [`Deliverable ${p.id}: ${p.title}. Context: ${p.context}. Outputs: ${p.outputs.join(', ')}`,
      ...p.needs.filter(n => !n.retired).map(n => `- [${n.id}; ${n.importance}] ${n.title}: ${n.why}. Sources: ${n.sources.join('; ') || 'not recorded'}. ${n.ownerDecision === 'omitted' ? 'OWNER CHOSE TO OMIT. Honour this choice.' : n.issue ? `INPUT NEEDS CORRECTION: ${n.issue}. Awaiting the owner in Your turn.` : n.answer ? `Selected input: ${n.answer.file ?? n.answer.answer ?? n.answer.explanation}. Evidence: ${n.answer.explanation}` : n.owner ? 'Awaiting the owner in Your turn. Build independent parts; do not invent the input.' : 'Damon must obtain or build this, then record evidence.'}`)
    ].join('\n'))].join('\n\n')
}
