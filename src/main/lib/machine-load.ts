export const MAX_AT_ONCE = 3

const RESERVED_FOR_THE_OWNER = 2

const THREADS_PER_AGENT = 4

export function agentsAtOnce(logicalCores: number): number {
  if (!Number.isFinite(logicalCores) || logicalCores < 1) return 1
  return Math.max(1, Math.min(MAX_AT_ONCE, Math.floor(logicalCores / THREADS_PER_AGENT)))
}

export function buildJobs(logicalCores: number, atOnce: number): number {
  if (!Number.isFinite(logicalCores) || logicalCores < 1) return 1
  const sharers = Math.max(1, Math.floor(atOnce) || 1)
  return Math.max(1, Math.floor((logicalCores - RESERVED_FOR_THE_OWNER) / sharers))
}

export function buildThreadLimits(logicalCores: number): Record<string, string> {
  const jobs = String(buildJobs(logicalCores, agentsAtOnce(logicalCores)))
  return { CARGO_BUILD_JOBS: jobs, RAYON_NUM_THREADS: jobs, RUST_TEST_THREADS: jobs, MAKEFLAGS: `-j${jobs}` }
}

export const MIN_FREE_BYTES_FOR_ANOTHER = 1.5 * 1024 * 1024 * 1024

export function roomForAnother(freeBytes: number, alreadyRunning: number): boolean {
  if (alreadyRunning <= 0) return true
  if (!Number.isFinite(freeBytes)) return true
  return freeBytes >= MIN_FREE_BYTES_FOR_ANOTHER
}
