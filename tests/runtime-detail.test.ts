import { describe, expect, test } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NdjsonParser, toManagerEvents } from '../src/main/lib/stream-parser'
import { lastCallFor, LAST_CALL } from '../src/shared/turns'
import { MIN_FREE_BYTES_FOR_ANOTHER, roomForAnother } from '../src/main/lib/machine-load'
import { readJson, writeJson } from '../src/main/lib/json-file'
import { stillAlive } from '../src/main/lib/process-registry'

describe('an error result says what the CLI said', () => {
  test('the errors list is carried when result is empty', () => {
    const [ev] = toManagerEvents({
      type: 'result',
      subtype: 'error_during_execution',
      result: '',
      errors: ['Tool Bash failed: spawn EPERM', 'Session aborted'],
      permission_denials: []
    })
    expect(ev).toMatchObject({ kind: 'result', ok: false })
    expect((ev as { error: string }).error).toContain('spawn EPERM')
    expect((ev as { error: string }).error).toContain('Session aborted')
  })

  test('refused tool calls are counted when nothing else was said', () => {
    const [ev] = toManagerEvents({
      type: 'result',
      subtype: 'error_during_execution',
      result: '',
      errors: [],
      permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Bash' }]
    })
    expect((ev as { error: string }).error).toContain('error_during_execution')
    expect((ev as { error: string }).error).toContain('2 tool calls were refused permission')
  })

  test('a run stopped by its own spend cap is real work with no report, like the step cap', () => {
    const [ev] = toManagerEvents({ type: 'result', subtype: 'error_max_budget_usd', result: '' })
    expect(ev).toMatchObject({ kind: 'result', ok: false, outOfSteps: true })
  })

  test('plain text on stdout is kept for the close report', () => {
    const p = new NdjsonParser()
    p.push('Error: cannot find module foo\n{"type":"system","subtype":"init","session_id":"s"}\nanother line\n')
    expect(p.noise()).toEqual(['Error: cannot find module foo', 'another line'])
  })
})

describe('the last call names its reason', () => {
  test('the step-cap wording is unchanged', () => {
    expect(LAST_CALL).toMatch(/^You have run out of steps/)
    expect(lastCallFor('steps')).toBe(LAST_CALL)
  })

  test('a clock stop does not claim the agent ran out of steps', () => {
    const clock = lastCallFor('clock', 'a command never answered')
    expect(clock).not.toMatch(/run out of steps/)
    expect(clock).toContain('a command never answered')
    expect(clock).toContain('HANDOVER:')
  })
})

describe('room for another agent', () => {
  test('the first agent always runs', () => {
    expect(roomForAnother(0, 0)).toBe(true)
  })

  test('a second agent waits when memory is short, and starts when it is not', () => {
    expect(roomForAnother(MIN_FREE_BYTES_FOR_ANOTHER - 1, 1)).toBe(false)
    expect(roomForAnother(MIN_FREE_BYTES_FOR_ANOTHER, 1)).toBe(true)
  })

  test('an unreadable figure is not a reason to stop', () => {
    expect(roomForAnother(Number.NaN, 2)).toBe(true)
  })
})

describe('a JSON store is written whole or not at all', () => {
  test('the file has the new contents and no temporary file is left beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'damon-atomic-'))
    const file = join(dir, 'tasks.json')
    writeJson(file, { a: 1 })
    writeJson(file, { a: 2, b: [1, 2, 3] })
    expect(readJson(file, null)).toEqual({ a: 2, b: [1, 2, 3] })
    expect(readdirSync(dir)).toEqual(['tasks.json'])
    expect(readFileSync(file, 'utf8')).toContain('"b"')
  })
})

describe('asking the operating system whether a process is gone', () => {
  test('this process is alive, and a pid nobody has is not', () => {
    expect(stillAlive(process.pid)).toBe(true)
    expect(stillAlive(2_147_000_000)).toBe(false)
  })
})
