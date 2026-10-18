const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /opus/i, input: 5, output: 25 },
  { match: /sonnet-5-5/i, input: 2.5, output: 12.5 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 1, output: 5 }
]

export function estimateCostUsd(model: string, usage: Record<string, number>): number | undefined {
  const price = PRICES.find((p) => p.match.test(model))
  if (!price) return undefined
  const m = 1_000_000
  const cost =
    ((usage.input_tokens ?? 0) * price.input +
      (usage.cache_creation_input_tokens ?? 0) * price.input * 2 +
      (usage.cache_read_input_tokens ?? 0) * price.input * 0.1 +
      (usage.output_tokens ?? 0) * price.output) / m
  return Math.round(cost * 10_000) / 10_000
}

export function sumStepUsage(steps: Iterable<Record<string, number>>): Record<string, number> {
  const total: Record<string, number> = {}
  for (const step of steps) for (const [k, v] of Object.entries(step)) if (Number.isSafeInteger(v) && v >= 0) total[k] = (total[k] ?? 0) + v
  return total
}
