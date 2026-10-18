import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson, writeJson, corruptCopiesOf } from '../src/main/lib/json-file'

const dir = (): string => mkdtempSync(join(tmpdir(), 'damon-test-'))

describe('json-file', () => {
  test('preserves each distinct corruption, while repeated reads reuse the same evidence', () => {
    const file = join(dir(), 'twice.json')
    for (const raw of ['{first damage', '{second damage', '{second damage']) {
      writeFileSync(file, raw)
      expect(readJson(file, [])).toEqual([])
    }
    expect(corruptCopiesOf(file).map(copy => readFileSync(copy, 'utf8')).sort()).toEqual(['{first damage', '{second damage'])
  })
  test('readJson returns fallback when file is missing', () => {
    expect(readJson(join(dir(), 'nope.json'), { a: 1 })).toEqual({ a: 1 })
  })

  test('writeJson then readJson round-trips, creating parent dirs', () => {
    const file = join(dir(), 'deep', 'nested', 'data.json')
    writeJson(file, { hello: 'world', n: 2 })
    expect(readJson(file, {})).toEqual({ hello: 'world', n: 2 })
  })

  test('readJson returns fallback on corrupt JSON', () => {
    const file = join(dir(), 'bad.json')
    writeJson(file, 'placeholder')
    writeFileSync(file, '{not json', 'utf8')
    expect(readJson(file, { ok: true })).toEqual({ ok: true })
  })
})
