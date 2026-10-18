export interface ContractStamp {
  file: string
  hash: string
}

const OURS_AND_GENERATED = /^(damon-)?(roadmap|notes|notes-archive|damon-notes|damon-notes-archive|report|damon-report|runbook)\.md$/i

export const ATTACHMENTS_DIR = 'attachments'

export function isContractFile(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.includes('node_modules/') || p.startsWith('.')) return false
  const parts = p.split('/')
  const name = parts[parts.length - 1] ?? ''
  if (parts.length === 2 && parts[0]?.toLowerCase() === ATTACHMENTS_DIR && !name.startsWith('.')) return true
  if (!name.toLowerCase().endsWith('.md')) return false
  if (OURS_AND_GENERATED.test(name)) return false
  if (parts.length === 1) return true
  return parts[0]?.toLowerCase() === 'docs'
}

export function driftBetween(builtOn: ContractStamp[], now: ContractStamp[]): string[] {
  const current = new Map(now.map((s) => [s.file, s.hash]))
  const moved: string[] = []
  for (const was of builtOn) {
    const is = current.get(was.file)
    if (is !== was.hash) moved.push(was.file)
  }
  return moved
}

export function driftBacklogPrompt(jobs: { job: string; files: string[] }[]): string {
  if (jobs.length === 0) return ''
  const counts = new Map<string, number>()
  for (const j of jobs) for (const f of j.files) counts.set(f, (counts.get(f) ?? 0) + 1)
  const worst = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, n]) => `- “${file}” moved under ${n} finished ${n === 1 ? 'job' : 'jobs'}`)
  return [
    `CATCHING YOU UP: ${jobs.length} finished ${jobs.length === 1 ? 'job was' : 'jobs were'} built on contract files that have since changed, and until today none of it was reported to you. It went to the owner instead, who has no way to judge it. This is the backlog.`,
    '',
    ...worst,
    '',
    'Every job carries its own list in the `drifted` field, so list_tasks and get_task have the detail whenever you want it, you have always had this, nobody ever pointed you at it.',
    '',
    'Do NOT work through all of it, and do not forward it to the owner. Most of it is the ordinary consequence of a project moving. Look at the handful where a changed contract would genuinely break finished work, deal with those, and carry on with what you were doing.'
  ].join('\n')
}

export function driftPrompt(moved: { job: string; files: string[] }[]): string {
  if (moved.length === 0) return ''
  return [
    'ALSO: work you already signed off was built on files that have since changed.',
    ...moved.map((m) => `- “${m.job}” was built on ${m.files.map((f) => `“${f}”`).join(', ')}, which ${m.files.length === 1 ? 'has' : 'have'} changed since.`),
    '',
    'Check whether that work still holds. If it does, carry on and say nothing: this is the ordinary consequence of a project moving, not an incident. If it genuinely no longer fits, send it back with concrete feedback or redo it, and tell the owner in ONE sentence what changed and what you did. Do not hand him this list, he has no way to judge it, and it was going to him instead of you until today.'
  ].join('\n')
}

