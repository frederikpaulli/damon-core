import type { ChatMessage, TaskInfo } from '../../../shared/types'
import { useDamon } from '../store'

export type OwnerNeedGo = 'chat' | 'fleet' | 'spend'

export interface OwnerNeed {
  key: string
  verb: 'Answer' | 'Approve' | 'Decide'
  title: string
  what: string
  context?: string
  go: OwnerNeedGo
}

export interface OwnerNeedsInput {
  questionsPersisted?: boolean
  chat: ChatMessage[]
  managerBusy: boolean
  teamProposed: boolean
  budgetHit?: { spentUsd: number; limitUsd: number }
  tasks: TaskInfo[]
  hasTeam: boolean
  waitingUntil?: number
  now?: number
  held?: boolean
}

function lastExchange(chat: ChatMessage[]): ChatMessage | undefined {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const m = chat[i]!
    if (m.role === 'manager' || m.role === 'user') return m
  }
  return undefined
}

export function questionIn(text: string): string | undefined {
  const t = text.trim()
  if (!t.includes('?')) return undefined
  const tail = t.slice(-600).replace(/[*_`]+/g, '')
  const sentences = tail.split(/(?<=[.!?])\s+/).map((s) => s.trim())
  const q = [...sentences].reverse().find((s) => s.endsWith('?'))
  if (!q) return undefined
  const clean = q.replace(/^[#>\-\s]+/, '')
  return clean.length > 220 ? clean.slice(0, 219) + '…' : clean
}

export function contextOf(text: string, question: string, max = 700): string | undefined {
  const plain = text
    .replace(/[*_`#>]+/g, '')
    .replace(question.replace(/…$/, ''), '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (plain.length < 20) return undefined
  return plain.length > max ? '…' + plain.slice(-max).replace(/^\S*\s/, '') : plain
}

export function ownerNeeds(o: OwnerNeedsInput): OwnerNeed[] {
  const out: OwnerNeed[] = []

  const last = lastExchange(o.chat)
  if (!o.questionsPersisted && last && last.role === 'manager' && !o.managerBusy) {
    const q = questionIn(last.text)
    if (q) {
      out.push({
        key: `question:${last.id}`,
        verb: 'Answer',
        title: 'Damon asked you something',
        what: q,
        context: contextOf(last.text, q),
        go: 'chat'
      })
    }
  }

  if (o.teamProposed) {
    out.push({
      key: 'approve-team',
      verb: 'Approve',
      title: 'I have put a team together',
      what: 'Nothing happens until you press Build it. Look at the chart and build it, ask for fewer or more people, or say what to change.',
      go: 'fleet'
    })
  }

  if (o.budgetHit) {
    out.push({
      key: 'budget',
      verb: 'Decide',
      title: 'The spend limit was reached',
      what: 'This project reached the spending limit you set, so new work is on hold until you change the limit.',
      go: 'spend'
    })
  }

  return out
}

export function needsInput(o: {
  chat?: ChatMessage[]
  managerBusy?: boolean
  proposal?: unknown
  budgetHit?: { spentUsd: number; limitUsd: number } | null
  tasks?: TaskInfo[]
  roster?: unknown[]
  waitingUntil?: number
  held: boolean
}): OwnerNeedsInput {
  return {
    questionsPersisted: true,
    held: o.held,
    chat: o.chat ?? [],
    managerBusy: o.managerBusy ?? false,
    teamProposed: Boolean(o.proposal),
    budgetHit: o.budgetHit ?? undefined,
    tasks: o.tasks ?? [],
    hasTeam: (o.roster ?? []).length > 0,
    waitingUntil: o.waitingUntil
  }
}

export function useOwnerNeeds(projectId: string): OwnerNeed[] {
  const chat = useDamon((s) => s.chats[projectId])
  const managerBusy = useDamon((s) => s.busy[projectId] ?? false)
  const proposal = useDamon((s) => s.proposals[projectId])
  const budgetHit = useDamon((s) => s.budgetReached[projectId])
  const tasks = useDamon((s) => s.tasks[projectId])
  const roster = useDamon((s) => s.rosters[projectId])
  const waitingUntil = useDamon((s) => s.autopilotWaiting[projectId])
  const held = useDamon((s) => s.holds[projectId] ?? false)
  return ownerNeeds(needsInput({ chat, managerBusy, proposal, budgetHit, tasks, roster, waitingUntil, held }))
}
