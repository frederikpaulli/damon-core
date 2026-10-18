import { describe, expect, test } from 'vitest'
import { verifyReport } from '../src/shared/verification'

const CAPTURED_STDERR =
  'Reading prompt from stdin...\n' +
  '2026-08-01T10:23:51.534736Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings'

const CALLS = [{ tool: 'apply_patch', summary: 'wrote built.txt' }]

describe('case one, replayed', () => {
  test('the shipped signature is caught: confident report, no file, exit zero', () => {
    const v = verifyReport({
      report: 'Created built.txt containing BUILT. The task is complete.',
      toolCalls: CALLS,
      stderr: CAPTURED_STDERR,
      exists: () => false
    })

    expect(v.ok).toBe(false)
    expect(v.findings.some((f) => f.kind === 'refused')).toBe(true)
    expect(v.findings.some((f) => f.kind === 'missing-file')).toBe(true)
    expect(v.note).toContain('read-only sandbox')
  })

  test('the check would have caught it on the error channel alone, before anyone looked at the disk', () => {
    const v = verifyReport({
      report: 'Created built.txt containing BUILT. The task is complete.',
      toolCalls: CALLS,
      stderr: CAPTURED_STDERR,
      exists: () => true
    })

    expect(v.ok).toBe(false)
    expect(v.findings.map((f) => f.kind)).toEqual(['refused'])
  })

  test('the same run, reported honestly, is not called a liar', () => {
    const v = verifyReport({
      report: 'Couldn’t create `built.txt` because the workspace is read-only.',
      toolCalls: CALLS,
      stderr: CAPTURED_STDERR,
      exists: () => false
    })

    expect(v.findings.map((f) => f.kind)).toEqual(['refused'])
    expect(v.note).toContain('which the report does say')
  })

  test('an exit code of zero is never treated as evidence of anything', () => {
    const v = verifyReport({
      report: 'Created built.txt.',
      toolCalls: CALLS,
      stderr: CAPTURED_STDERR,
      exists: () => false
    })

    expect(v.ok).toBe(false)
  })
})
