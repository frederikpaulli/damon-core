export const HEAVY_CONTEXT = 60_000

const KEEP_MESSAGES = 12

export function contextSizeOf(totalTokens: number, steps: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0
  if (!Number.isFinite(steps) || steps < 1) return totalTokens
  return Math.round(totalTokens / steps)
}

export function isHeavy(contextTokens: number): boolean {
  return contextTokens >= HEAVY_CONTEXT
}

export interface SeedParts {
  brain: string
  openTasks: { title: string; status: string; who: string }[]
  people: { name: string; role: string }[]
  recent: { role: string; text: string }[]
}

const trim = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + `… [cut, ${s.length} characters in all]` : s

export function seedFrom(parts: SeedParts): string {
  const lines: string[] = [
    'You are picking this project up mid-flight.',
    '',
    'You have led this work already. The earlier conversation is not in front of you any more, because carrying it was costing the owner more than it was worth. Nothing has been lost: everything below is the real, current state, read from Damon\'s own records rather than remembered.',
    '',
    'Do not start again, do not re-plan what is already underway, and do not greet the owner as though this were a new job. Carry on from here. If something you need is missing below, go and look for it with read_brain, list_tasks or list_agents rather than guessing or asking the owner to repeat themselves.'
  ]

  const brain = parts.brain.trim()
  lines.push('', '## What this project knows', brain ? trim(brain, 8000) : '(nothing recorded yet)')

  lines.push('', '## Jobs not yet finished')
  if (parts.openTasks.length === 0) lines.push('(none open)')
  else for (const t of parts.openTasks) lines.push(`- "${t.title}", ${t.status}, with ${t.who}`)

  lines.push('', '## Your team')
  if (parts.people.length === 0) lines.push('(nobody has been hired yet)')
  else for (const p of parts.people) lines.push(`- ${p.name}: ${trim(p.role, 300)}`)

  lines.push('', '## The last part of your conversation with the owner')
  if (parts.recent.length === 0) lines.push('(nothing said yet)')
  else for (const m of parts.recent) lines.push(`${m.role}: ${trim(m.text, 700)}`)

  return lines.join('\n')
}

export function recentTalk(
  messages: { role: string; text: string }[],
  keep = KEEP_MESSAGES
): { role: string; text: string }[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'owner' || m.role === 'manager')
    .slice(-keep)
    .map((m) => (m.role === 'user' ? { role: 'owner', text: m.text } : m))
}

export interface StateParts {
  openTasks: { title: string; status: string; who: string }[]
  people: { name: string }[]
  held: boolean
  ownersList: number
  ready: { company: string; role: string }[]
  unscreened?: string[]
}

export function stateBlock(p: StateParts): string {
  const lines = ['[Where the project stands right now, from Damon\'s records. This is NOT a message from the owner. You do not need list_tasks or list_agents to know this; call them only for details.]']
  if (p.held) lines.push('- Everything is on hold by the owner. Nothing starts until they press Start again.')
  const open = p.openTasks.slice(0, 12)
  if (open.length === 0) lines.push('- No open jobs.')
  else {
    lines.push(`- Open jobs (${p.openTasks.length}):`)
    for (const t of open) lines.push(`  - "${t.title.length > 90 ? t.title.slice(0, 89) + '…' : t.title}", ${t.status}, ${t.who}`)
    if (p.openTasks.length > open.length) lines.push(`  - and ${p.openTasks.length - open.length} more`)
  }
  lines.push(p.people.length === 0 ? '- Nobody hired yet.' : `- Team: ${p.people.map((x) => x.name).join(', ')}.`)
  if (p.ownersList > 0) lines.push(`- ${p.ownersList} thing${p.ownersList === 1 ? '' : 's'} on the owner's list, waiting for them.`)
  if (p.ready.length > 0) lines.push(`- Ready for the owner to submit: ${p.ready.map((r) => `${r.company} (${r.role})`).join('; ')}.`)
  if ((p.unscreened ?? []).length > 0) lines.push(`- Found but not screened yet (${p.unscreened!.length}): ${p.unscreened!.slice(0, 8).join(', ')}. Screening comes before any writing.`)
  return lines.join('\n') + '\n\n'
}

export function digestBlock(items: string[]): string {
  if (items.length === 0) return ''
  return ['[Since your last turn, Damon did these on its own. Nothing to do about them unless you see a reason. This is NOT a message from the owner.]', ...items.slice(-12).map((i) => `- ${i}`)].join('\n') + '\n\n'
}
