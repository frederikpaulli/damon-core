export interface Criterion {
  id: string
  text: string
}

export interface CriteriaComparison {
  needsApproval: boolean
  nothingApproved: boolean
  unchanged: boolean
  removed: string[]
  added: string[]
  edited: { before: string; after: string }[]
  attached: string[]
  merged: string[]
  before: string[]
  after: string[]
  line: string
}

function normalise(text: string): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
}

export function sameCriterion(a: string, b: string): boolean {
  return normalise(a) === normalise(b)
}

const FUNCTION_WORDS = new Set(['the', 'and', 'any', 'are', 'for', 'from', 'has', 'have', 'his', 'her', 'its', 'into', 'not', 'nor', 'one', 'onto', 'our', 'out', 'that', 'them', 'then', 'there', 'they', 'this', 'was', 'were', 'with', 'you', 'your', 'all', 'but', 'can', 'each', 'ever', 'never', 'only', 'than', 'these', 'those', 'what', 'when', 'where', 'which', 'who', 'will', 'would', 'about', 'after', 'before', 'being', 'does', 'else', 'every', 'here', 'itself', 'just', 'more', 'most', 'much', 'must', 'over', 'same', 'should', 'some', 'such', 'their', 'under', 'until', 'upon', 'very', 'also', 'both', 'either', 'still', 'while', 'without'])
export function looksLike(a: string, b: string): boolean {
  const words = (s: string): Set<string> => new Set(normalise(s).split(' ').filter((w) => w.length > 2 && !FUNCTION_WORDS.has(w)))
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared += 1
  return shared >= 2 && shared / Math.max(wa.size, wb.size) >= 0.5
}

function list(items: string[]): string {
  return items.map((i) => `"${i}"`).join(', ')
}

export function compareCriteria(approved: Criterion[], proposed: string[]): CriteriaComparison {
  const before = approved.map((c) => c.text)
  const after = [...proposed]

  const usedProposed = new Set<number>()
  const survived = new Set<string>()
  for (const c of approved) {
    const hit = after.findIndex((p, i) => !usedProposed.has(i) && sameCriterion(c.text, p))
    if (hit >= 0) {
      usedProposed.add(hit)
      survived.add(c.id)
    }
  }

  const lost = approved.filter((c) => !survived.has(c.id))
  const extra = after.filter((_, i) => !usedProposed.has(i))

  const edited: { before: string; after: string }[] = []
  const removed: string[] = []
  const pairedExtra = new Set<number>()
  for (const c of lost) {
    const hit = extra.findIndex((p, i) => !pairedExtra.has(i) && looksLike(c.text, p))
    if (hit >= 0) {
      pairedExtra.add(hit)
      edited.push({ before: c.text, after: extra[hit]! })
    } else {
      removed.push(c.text)
    }
  }
  const added = extra.filter((_, i) => !pairedExtra.has(i))

  if (approved.length === 0) {
    return {
      needsApproval: true,
      nothingApproved: true,
      unchanged: false,
      removed: [],
      added,
      edited: [],
      attached: [],
      merged: after,
      before,
      after,
      line: 'These acceptance criteria were not approved by you. Nothing has been agreed for this work yet, so there is no standard to hold the team to.'
    }
  }

  const merged = [...before, ...added]
  const needsApproval = edited.length > 0
  const unchanged = !needsApproval && added.length === 0 && removed.length === 0

  let line: string
  if (unchanged) {
    line = 'The acceptance criteria are the same ones you approved. Nothing has moved.'
  } else if (needsApproval) {
    line = `The standards you approved for this work have been changed: ${list(edited.map((e) => e.before))}. Damon has not let that through. Both sets are below in full, so you can see what changed rather than being told about it.`
  } else if (removed.length > 0) {
    const count =
      removed.length === 1
        ? 'the approved standard'
        : removed.length === before.length
          ? `all ${removed.length} approved standards`
          : `the ${removed.length} approved standards`
    line =
      added.length > 0
        ? `Damon attached ${count} the team left out, and the team added: ${list(added)}.`
        : `Damon attached ${count} the team left out.`
  } else {
    line = `The team added to what you approved and changed none of it. Added: ${list(added)}.`
  }

  return { needsApproval, nothingApproved: false, unchanged, removed, added, edited, attached: removed, merged, before, after, line }
}
