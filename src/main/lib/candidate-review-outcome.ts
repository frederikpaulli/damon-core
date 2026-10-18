import type { CandidateRecord } from '../../shared/candidates'
import type { CandidateStore } from './candidate-store'
import type { CandidateReviewStore } from './candidate-review'

export function latestCandidateFor(candidates: CandidateStore, taskId: string): CandidateRecord | undefined {
  const records = candidates.read()
    .filter(record => record.taskScope?.taskId === taskId)
    .sort((a, b) => a.at.localeCompare(b.at))
  const latest = records[records.length - 1]
  if (!latest) return undefined
  const byPath = new Map<string, CandidateRecord['files'][number]>()
  for (const record of records) for (const file of record.files) byPath.set(file.path.toLowerCase(), file)
  const own = new Set(latest.files.map(file => file.path.toLowerCase()))
  const files = [...latest.files, ...[...byPath.entries()].filter(([key]) => !own.has(key)).map(([, file]) => file)]
  const inputs = new Map<string, CandidateRecord['inputs'][number]>()
  for (const record of records) for (const input of record.inputs) inputs.set(input.path.toLowerCase(), input)
  return { ...latest, files, inputs: [...inputs.values()] }
}

export function candidateReviewBrief(candidate: CandidateRecord): string {
  const files = candidate.files.map(file => file.status === 'available' ? `${file.path} (available)` : `${file.path} (unavailable: ${file.reason})`)
  return [
    '',
    'WHERE THE WORK IS. This job produced a DRAFT, held privately by Damon; its files are not on disk and not in the project folder, so do not look for them there and do not treat their absence as a finding.',
    `The draft under review is ${candidate.id} and it contains: ${files.join('; ')}.`,
    ...(candidate.files.some(file => /\.html?$/i.test(file.path)) ? ['A .pdf named beside an .html page in this job is printed by Damon on the host after your review; it is never part of a draft and its absence is not a finding. Judge the page with look_at_my_page instead.'] : []),
    'HOW TO REVIEW IT. Call list_review_files, then read_review_file for EVERY available file, then record your judgement with submit_review. A verdict written only in prose is not recorded and counts as no review.',
    'submit_review takes a verdict of meets, does-not-meet or cannot-tell, a summary in plain words, and findings each with a severity; a blocking finding and "meets" contradict each other and will be refused. Applying, releasing or accepting the draft is the owner\'s decision, never yours.'
  ].join('\n')
}

export function recordedBeforeCutOff(o: { ok: boolean; draft: boolean; critic: boolean; uses: readonly { tool: string; ok?: boolean }[]; recorded: () => boolean }): boolean {
  if (o.ok || !o.draft || o.critic) return false
  if (!o.uses.some(use => use.ok === true && /(?:^|__)submit_review$/.test(use.tool))) return false
  return o.recorded()
}

export function candidateReviewOutcome(reviews: CandidateReviewStore, candidateId: string, reviewerId: string): { answered: boolean; satisfied: boolean; objections: string[]; stale?: boolean } {
  const mine = reviews.forCandidate(candidateId)
    .filter(record => record.reviewerId === reviewerId)
    .sort((a, b) => b.at.localeCompare(a.at))
  const latest = mine[0]
  if (!latest) return { answered: false, satisfied: false, objections: ['The reviewer recorded no verdict on the draft, so it has not actually been reviewed.'] }
  const standing = reviews.standing(latest)
  if (!standing.usable) return { answered: true, satisfied: false, stale: true, objections: ['The review no longer describes the current draft: ' + standing.issues.join(' ')] }
  if (latest.verdict === 'meets') return { answered: true, satisfied: true, objections: [] }
  const findings = [...latest.findings].sort((a, b) => (a.severity === 'blocking' ? 0 : 1) - (b.severity === 'blocking' ? 0 : 1)).map(finding => `${finding.severity}: ${finding.statement} (${finding.evidence})`)
  const head = latest.verdict === 'cannot-tell' ? 'The reviewer could not tell whether the draft meets the criteria.' : 'The reviewer found the draft does not meet the criteria.'
  return { answered: true, satisfied: false, objections: [head, latest.summary, ...findings].filter(Boolean) }
}
