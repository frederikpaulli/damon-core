type Kind = 'agent' | 'submanager' | undefined

export function seatKey(name: string, kind: Kind): string {
  return `${kind === 'submanager' ? 'submanager' : 'agent'}:${name.trim().toLowerCase()}`
}

export interface PlanEffect {
  joins: number
  stays: number
  standsDown: number
}

export function planEffect(
  nodes: Array<{ name: string; kind?: Kind }>,
  current: Array<{ name: string; kind?: Kind }>
): PlanEffect {
  const bySeat = new Set(current.map((a) => seatKey(a.name, a.kind)))
  const taken = new Set<string>()
  let joins = 0
  let stays = 0
  for (const n of nodes) {
    const key = seatKey(n.name, n.kind)
    if (bySeat.has(key) && !taken.has(key)) {
      taken.add(key)
      stays++
    } else {
      joins++
    }
  }
  return { joins, stays, standsDown: current.length - stays }
}

const people = (n: number): string => (n === 1 ? 'person' : 'people')

export function proposalHeadline(effect: PlanEffect, n: number): string {
  const { joins, stays, standsDown } = effect
  if (stays + standsDown === 0) return `I propose a team of ${n}.`
  if (standsDown === 0) {
    if (joins === 0) return `I propose no new people; ${stays === 1 ? 'the one you have stays' : `the ${stays} you have stay`}.`
    const keep = stays === 1 ? 'the one you have stays' : `the ${stays} you have stay`
    return `I propose ${joins} more ${people(joins)}; ${keep}.`
  }
  return `I propose a team of ${n}: ${joins} join, ${stays} stay, ${standsDown} stand down.`
}
