import { describe, expect, test } from 'vitest'
import {
  configWasRead,
  duplicatesOf,
  identityOf,
  toolsLine,
  type ToolsProbe
} from '../src/shared/connector-tools'
import type { Connection } from '../src/shared/connectors'

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'a',
  name: 'Web browser (Chrome)',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@playwright/mcp@0.0.78'],
  ...over
})

const probed = (names: string[], at = '2026-08-03T10:00:00.000Z'): ToolsProbe => ({ ok: true, names, at })

describe('what the card says about tools', () => {
  test('once asked, the card reports what was observed and says it observed it', () => {
    const line = toolsLine(probed(['read_thing', 'write_thing', 'list_things']), undefined)

    expect(line).toContain('3 tools')
    expect(line.toLowerCase()).toContain('asked')
  })

  test('a disagreement with the publisher is said out loud, not averaged away', () => {
    const line = toolsLine(probed(['read_thing', 'write_thing', 'list_things']), 15)

    expect(line).toContain('3')
    expect(line).toContain('15')
    expect(line.toLowerCase()).toContain('says')
  })

  test('agreement is not turned into a warning', () => {
    const line = toolsLine(probed(['a', 'b', 'c']), 3)

    expect(line).not.toContain('15')
    expect(line.toLowerCase()).not.toContain('but')
  })

  test('before it has been asked, the claim is still labelled as a claim', () => {
    const line = toolsLine(undefined, 15)

    expect(line.toLowerCase()).toContain('says')
    expect(line).toContain('15')
    expect(line.toLowerCase()).not.toContain('asked')
  })

  test('nothing claimed and nothing observed says nothing at all', () => {
    expect(toolsLine(undefined, undefined)).toBe('')
  })

  test('a failed probe reports the failure, never zero tools', () => {
    const line = toolsLine({ ok: false, error: 'took longer than 10 seconds', at: '2026-08-03T10:00:00.000Z' }, 15)

    expect(line).not.toMatch(/\b0 tools\b/)
    expect(line.toLowerCase()).toContain('could not')
    expect(line).toContain('10 seconds')
  })

  test('a server that genuinely exposes none says so as an observation', () => {
    expect(toolsLine(probed([]), undefined).toLowerCase()).toContain('no tools')
  })
})

describe('the same connector added twice', () => {
  test('two names over the same command are one connector', () => {
    const a = conn({ id: '1', name: 'Browser' })
    const b = conn({ id: '2', name: 'Chrome for the research team' })

    expect(identityOf(a)).toBe(identityOf(b))
  })

  test('a different version is a different connector, because it is different code', () => {
    const a = conn({ args: ['-y', '@playwright/mcp@0.0.78'] })
    const b = conn({ args: ['-y', '@playwright/mcp@0.0.79'] })

    expect(identityOf(a)).not.toBe(identityOf(b))
  })

  test('remote connectors are matched on the address, ignoring case and trailing slash', () => {
    const a = conn({ transport: 'http', command: undefined, args: undefined, url: 'https://Example.com/mcp/' })
    const b = conn({ transport: 'http', command: undefined, args: undefined, url: 'https://example.com/mcp' })

    expect(identityOf(a)).toBe(identityOf(b))
  })

  test('a duplicate is reported with both names, so the owner knows which to remove', () => {
    const dupes = duplicatesOf([conn({ id: '1', name: 'Browser' }), conn({ id: '2', name: 'Chrome' }), conn({ id: '3', name: 'Memory', args: ['-y', 'server-memory@1'] })])

    expect(dupes).toHaveLength(1)
    expect(dupes[0]!.names).toEqual(['Browser', 'Chrome'])
  })

  test('different connectors are not accused of being duplicates', () => {
    expect(duplicatesOf([conn({ id: '1' }), conn({ id: '2', args: ['-y', 'server-memory@1'] })])).toEqual([])
  })

  test('a connector that is switched off still counts, because it is still in the list', () => {
    const dupes = duplicatesOf([conn({ id: '1', name: 'A' }), conn({ id: '2', name: 'B', enabled: false })])

    expect(dupes).toHaveLength(1)
  })
})

describe('did the CLI read the config Damon wrote', () => {
  const servers = [
    { name: 'overclaimer', status: 'pending' },
    { name: 'damon', status: 'connected' }
  ]

  test('a server named in the init event proves the file was read', () => {
    expect(configWasRead(servers, ['overclaimer', 'damon']).read).toBe(true)
  })

  test('a server Damon wrote and the CLI never mentioned is named as missing', () => {
    const r = configWasRead(servers, ['overclaimer', 'damon', 'perplexity'])

    expect(r.read).toBe(true)
    expect(r.missing).toEqual(['perplexity'])
  })

  test('nothing at all in the init event means the file was not read', () => {
    const r = configWasRead([], ['overclaimer'])

    expect(r.read).toBe(false)
    expect(r.missing).toEqual(['overclaimer'])
  })

  test('pending is not failure, and is never reported as one', () => {
    const r = configWasRead(servers, ['overclaimer'])

    expect(r.missing).toEqual([])
    expect(r.failed).toEqual([])
  })

  test('a server the CLI says failed is reported, because that one is observed', () => {
    const r = configWasRead([{ name: 'overclaimer', status: 'failed' }], ['overclaimer'])

    expect(r.failed).toEqual(['overclaimer'])
  })
})
