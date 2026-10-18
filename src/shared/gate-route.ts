export type GateName = 'standards' | 'reviewer' | 'evidence-of-files' | 'deliverables' | 'needs' | 'coverage' | 'foundation-review' | 'critique'

export interface GateRoute {
  size: 'small' | 'large'
  gates: GateName[]
  skipped: GateName[]
  because: string[]
  bookkeeping?: true
}

export const PACKAGE_FILES_MAX = 8

const SMALL: GateName[] =['standards', 'reviewer', 'evidence-of-files']
const LARGE_ONLY: GateName[] = ['deliverables', 'needs', 'coverage', 'foundation-review', 'critique']

const OUTWARD = /\b((?:publish|post|launch|send|email|submit|pay|buy|purchase)(?:es|s|ing)? (?:it|this|that|them|the|an?|to|for|out)\b|go live|outreach|checkout)/i

export function outwardAction(text: string): string | null {
  const hit = OUTWARD.exec(text ?? '')
  return hit ? hit[0].trim() : null
}

const GOES_OUT = /\b(?:clients?|customers?|publish\w*|to send|to submit|for the owner to|authorit(?:y|ies))\b/i

export function gateRouteFor(input: { writes: readonly string[]; reads?: readonly string[]; text: string; teamMode?: boolean; bookkeeping?: (path: string) => boolean; packageFolder?: (path: string) => string | undefined }): GateRoute {
  const because: string[] = []
  const writes = input.writes.map(w => w.trim()).filter(Boolean)
  const oneFile = writes.length === 1 && !/[*?]/.test(writes[0]!) && !writes[0]!.endsWith('/')
  if (!oneFile) because.push(writes.length === 1 ? 'the write scope is an area, not one file' : `${writes.length} write areas`)
  const outward = OUTWARD.exec(input.text)
  if (outward) because.push(`outward action "${outward[0].trim()}"`)
  const exact = writes.length > 1 && writes.length <= PACKAGE_FILES_MAX && writes.every((w) => !/[*?]/.test(w) && !w.endsWith('/') && !/^(?:[a-z]:|[\\/])/i.test(w) && !w.split(/[\\/]/).includes('..'))
  const folders = exact && input.packageFolder ? [...new Set(writes.map((w) => input.packageFolder!(w.replace(/\\/g, '/'))))] : []
  const onePackage = folders.length === 1 && !!folders[0]
  if (onePackage && !outward) {
    return { size: 'small', gates: [...SMALL], skipped: [...LARGE_ONLY], because: [...because, 'exact files in one outgoing folder'] }
  }
  if (input.bookkeeping && writes.length > 0 && !outward && !GOES_OUT.test(input.text) && writes.every((w) => !/[*?]/.test(w) && input.bookkeeping!(w))) {
    return { size: 'small', gates: ['standards', 'evidence-of-files'], skipped: ['reviewer', ...LARGE_ONLY], because: [...because.filter((b) => !b.startsWith('one output file')), "only Damon's own bookkeeping"], bookkeeping: true }
  }
  const small = oneFile && !outward
  if (small) because.push('one output file, no outward action')
  return small
    ? { size: 'small', gates: [...SMALL], skipped: [...LARGE_ONLY], because }
    : { size: 'large', gates: [...SMALL, ...LARGE_ONLY], skipped: [], because }
}

export function describeRoute(route: GateRoute): string {
  if (route.bookkeeping) return `Gates for this job: ${route.gates.join(', ')}. No reviewer: it only changes Damon's own bookkeeping, and Damon signs it off when its report matches what it did.`
  const applied = route.gates.join(', ')
  const why = route.because.includes('exact files in one outgoing folder') ? 'exact files in one outgoing folder' : 'one-file job'
  return route.size === 'small'
    ? `Gates for this job: ${applied}. Not applied (${why}): ${route.skipped.join(', ')}.`
    : `Gates for this job: ${applied}.`
}
