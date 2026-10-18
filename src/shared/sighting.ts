export interface Shot {
  file: string
  what: string
  by: 'damon' | 'owner'
}

export interface OwnerLook {
  why: string
  shots: { what: string; checking: string }[]
}

export type Sighting =
  | {
      kind: 'seen'
      shots: Shot[]
      how: string
      surface?: 'screen' | 'document'
      checks?: string[]
      printed?: string[]
    }
  | { kind: 'nothing-to-see' }
  | { kind: 'out-of-reach'; why: string; askOwner?: OwnerLook; lookYourself?: boolean; surface?: 'screen' | 'document' }
  | { kind: 'failed'; why: string }

export function sawNothing(s: Sighting): boolean {
  return s.kind !== 'seen' || s.shots.length === 0
}

export function blocksApproval(s: Sighting): boolean {
  return s.kind === 'failed'
}

export function sightingNote(s: Sighting): string {
  switch (s.kind) {
    case 'seen':
      return `Damon looked at this ${s.how}.`
    case 'out-of-reach':
      return `Nobody looked at this. ${s.why}`
    case 'failed':
      return `Damon tried to look at this and could not. ${s.why}`
    case 'nothing-to-see':
      return ''
    default: {
      const unreachable: never = s
      return unreachable
    }
  }
}
