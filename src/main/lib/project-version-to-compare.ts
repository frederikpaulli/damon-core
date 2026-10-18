import { inspectExecutionInput, readApprovedInput } from './execution-policy'

export function projectVersionToCompare(root: string, path: string, beforeSha256: string): { text: string; against: 'replaced' | 'current' } {
  try { return { text: readApprovedInput(root, { path, sha256: beforeSha256 }).toString('utf8'), against: 'replaced' } }
  catch (e) {
    if (!(e instanceof Error) || !/approved input changed/i.test(e.message)) throw e
    return { text: inspectExecutionInput(root, path).content, against: 'current' }
  }
}
