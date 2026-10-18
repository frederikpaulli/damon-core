export function findKnot(
  edges: Map<string, string[]>,
  from: string,
  needs: string[]
): string[] | null {
  for (const first of needs) {
    if (first === from) return [from, from]
    const path: string[] = [from, first]
    const seen = new Set<string>([first])
    const walk = (at: string): string[] | null => {
      for (const next of edges.get(at) ?? []) {
        if (next === from) return [...path, from]
        if (seen.has(next)) continue
        seen.add(next)
        path.push(next)
        const found = walk(next)
        if (found) return found
        path.pop()
      }
      return null
    }
    const knot = walk(first)
    if (knot) return knot
  }
  return null
}

export function resolveKeys(
  jobs: { key?: string; waits_for?: string[] }[],
  ids: string[]
): string[][] {
  const byKey = new Map<string, string>()
  jobs.forEach((j, i) => {
    if (j.key && ids[i]) byKey.set(j.key, ids[i]!)
  })
  return jobs.map((j) => (j.waits_for ?? []).map((w) => byKey.get(w) ?? w))
}
