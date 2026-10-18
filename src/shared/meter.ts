import { contextSizeOf } from './manager-memory'
import type { SpendEntry } from './types'

export interface QuotaStamp {
  utilization: number
  rateLimitType?: string
  resetsAt?: number
  isUsingOverage?: boolean
}

export interface Meter {
  steps?: number
  contextTokens?: number
  quota?: QuotaStamp
}

export function meterOf(tokens: number, steps?: number, quota?: QuotaStamp): Meter {
  const usable = typeof steps === 'number' && Number.isFinite(steps) && steps >= 1
  return {
    steps: usable ? steps : undefined,
    contextTokens: usable ? contextSizeOf(tokens, steps!) : undefined,
    quota: quota && Number.isFinite(quota.utilization) ? quota : undefined
  }
}

export function spendGroup(entry: SpendEntry): string {
  if (entry.actor === 'lead') return 'leads'
  if (entry.actor === 'agent') return entry.name === 'Reviewer' ? 'the checker' : 'the team doing the work'
  if (entry.turnKind === 'owner') return 'your messages'
  if (entry.turnKind === 'routine') return 'Damon working on its own'
  return 'Damon (not recorded which)'
}

export interface ActorReading {
  runs: number
  tokens: number
  costUsd: number
  allowanceUsed?: number
  averageSteps?: number
  averageContext?: number
}

export interface WhereItWent {
  byActor: Record<string, ActorReading>
  readings: number
}

export function allowanceLines(where: WhereItWent): { lines: string[]; note: string } {
  if (where.readings === 0) {
    return {
      lines: [],
      note: 'Damon has not recorded a reading yet. Your Claude account reports one on every run, so this fills in as you use it.'
    }
  }
  const rows = Object.entries(where.byActor)
    .filter(([, r]) => typeof r.allowanceUsed === 'number' && r.allowanceUsed > 0)
    .sort((a, b) => (b[1].allowanceUsed ?? 0) - (a[1].allowanceUsed ?? 0))

  const lines = rows.map(([group, r]) => {
    const pct = Math.round((r.allowanceUsed ?? 0) * 100)
    const turns = `${r.runs} ${r.runs === 1 ? 'turn' : 'turns'}`
    const shape =
      typeof r.averageSteps === 'number'
        ? `, averaging ${r.averageSteps} ${r.averageSteps === 1 ? 'step' : 'steps'} each`
        : ''
    return `${pct}% of your Claude allowance went on ${group}, ${turns}${shape}.`
  })

  const note = `Worked out from ${where.readings} ${where.readings === 1 ? 'reading' : 'readings'} your Claude account sent. Anything that ran without reporting one is counted against whoever reported next, so treat a small number of readings as a rough answer.`
  return { lines, note }
}

export function whereItWent(entries: SpendEntry[]): WhereItWent {
  const byActor: Record<string, ActorReading> = {}
  const stepped: Record<string, { steps: number; context: number; n: number }> = {}
  let readings = 0
  let previous: QuotaStamp | null = null

  const inOrder = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  for (const e of inOrder) {
    const group = spendGroup(e)
    const row = byActor[group] ?? { runs: 0, tokens: 0, costUsd: 0 }
    row.runs += 1
    row.tokens += Number.isFinite(e.tokens) ? e.tokens : 0
    row.costUsd += Number.isFinite(e.costUsd) ? e.costUsd : 0

    if (typeof e.steps === 'number' && typeof e.contextTokens === 'number') {
      const s = stepped[group] ?? { steps: 0, context: 0, n: 0 }
      s.steps += e.steps
      s.context += e.contextTokens
      s.n += 1
      stepped[group] = s
    }

    const q = e.quota
    if (q && Number.isFinite(q.utilization)) {
      readings += 1
      const sameWindow =
        previous !== null && previous.rateLimitType === q.rateLimitType && previous.resetsAt === q.resetsAt
      if (sameWindow) {
        const used = q.utilization - previous!.utilization
        if (used > 0) row.allowanceUsed = (row.allowanceUsed ?? 0) + used
        else if (row.allowanceUsed === undefined) row.allowanceUsed = 0
      } else if (row.allowanceUsed === undefined) {
        row.allowanceUsed = 0
      }
      previous = q
    }

    byActor[group] = row
  }

  for (const [group, s] of Object.entries(stepped)) {
    const row = byActor[group]
    if (!row || s.n === 0) continue
    row.averageSteps = Math.round(s.steps / s.n)
    row.averageContext = Math.round(s.context / s.n)
  }

  return { byActor, readings }
}
