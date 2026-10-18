import { describe, expect, test } from 'vitest'
import { CONNECTOR_PRESETS, syncToPresets, type Connection, type ConnectorPreset } from '../src/shared/connectors'

const preset = (over: Partial<ConnectorPreset> = {}): ConnectorPreset => ({
  key: 'research',
  name: 'Research',
  blurb: 'x',
  category: 'Research',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@good/pkg@2.0.0'],
  publisher: 'Good',
  source: 'github.com/good/pkg',
  version: '2.0.0',
  ...over
})

const saved = (over: Partial<Connection> = {}): Connection => ({
  id: 'c1',
  name: 'Research',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'old-unscoped-pkg'],
  preset: 'research',
  ...over
})

describe('bringing already-enabled connectors up to date', () => {
  test('an old command is replaced with what the preset says today', () => {
    const { connections, changed } = syncToPresets([saved()], [preset()])
    expect(connections[0]!.args).toEqual(['-y', '@good/pkg@2.0.0'])
    expect(changed).toHaveLength(1)
    expect(changed[0]!.before).toContain('old-unscoped-pkg')
    expect(changed[0]!.after).toContain('@good/pkg@2.0.0')
  })

  test('an unpinned version is replaced by the pinned one', () => {
    const stale = saved({ args: ['-y', '@good/pkg@latest'] })
    const { connections } = syncToPresets([stale], [preset()])
    expect(connections[0]!.args).toEqual(['-y', '@good/pkg@2.0.0'])
  })

  test('nothing is reported or rewritten when it is already right', () => {
    const current = saved({ args: ['-y', '@good/pkg@2.0.0'] })
    const { connections, changed } = syncToPresets([current], [preset()])
    expect(changed).toEqual([])
    expect(connections[0]).toBe(current)
  })

  test('a key the owner entered survives the update', () => {
    const withKey = saved({
      args: ['-y', 'old-unscoped-pkg'],
      env: { PERPLEXITY_API_KEY: 'pplx-the-owners-real-key' }
    })
    const { connections } = syncToPresets([withKey], [preset({ env: { PERPLEXITY_API_KEY: '' } })])
    expect(connections[0]!.env).toEqual({ PERPLEXITY_API_KEY: 'pplx-the-owners-real-key' })
  })

  test('a setting the preset has newly started asking for is added empty', () => {
    const withKey = saved({ env: { OLD_KEY: 'kept' } })
    const { connections } = syncToPresets([withKey], [preset({ env: { OLD_KEY: '', NEW_KEY: '' } })])
    expect(connections[0]!.env).toEqual({ OLD_KEY: 'kept', NEW_KEY: '' })
  })

  test('a secret for a setting nothing reads any more is not carried around', () => {
    const withKey = saved({ env: { GONE_KEY: 'secret' } })
    const { connections } = syncToPresets([withKey], [preset({ env: undefined })])
    expect(connections[0]!.env).toBeUndefined()
  })

  test('whether it is switched on is the owner decision and is left alone', () => {
    const off = saved({ enabled: false })
    const { connections } = syncToPresets([off], [preset()])
    expect(connections[0]!.enabled).toBe(false)
    expect(connections[0]!.id).toBe('c1')
  })

  test('a connection the owner wrote themselves is never touched', () => {
    const mine = saved({ preset: undefined, args: ['-y', 'my-own-thing'] })
    const { connections, changed } = syncToPresets([mine], [preset()])
    expect(connections[0]).toBe(mine)
    expect(changed).toEqual([])
  })

  test('a preset Damon no longer offers leaves the connection as it is', () => {
    const orphan = saved({ preset: 'something-removed' })
    const { connections, changed } = syncToPresets([orphan], [preset()])
    expect(connections[0]).toBe(orphan)
    expect(changed).toEqual([])
  })
})

describe('against the real presets', () => {
  test('anything enabled on the old Perplexity package is moved to the real one', () => {
    const old: Connection = {
      id: 'p',
      name: 'Perplexity (live web research)',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-perplexity-ask'],
      env: { PERPLEXITY_API_KEY: 'pplx-real' },
      preset: 'perplexity'
    }
    const { connections, changed } = syncToPresets([old], CONNECTOR_PRESETS)
    expect(connections[0]!.args!.join(' ')).toContain('@perplexity-ai/mcp-server@1.2.0')
    expect(connections[0]!.args!.join(' ')).not.toContain('server-perplexity-ask')
    expect(connections[0]!.env).toEqual({ PERPLEXITY_API_KEY: 'pplx-real' })
    expect(changed).toHaveLength(1)
  })

  test('every real preset already matches itself, so launch is quiet in the normal case', () => {
    const asEnabled: Connection[] = CONNECTOR_PRESETS.map((p, i) => ({
      id: String(i),
      name: p.name,
      enabled: true,
      transport: p.transport,
      command: p.command,
      args: p.args ? [...p.args] : undefined,
      env: p.env ? { ...p.env } : undefined,
      preset: p.key
    }))
    expect(syncToPresets(asEnabled, CONNECTOR_PRESETS).changed).toEqual([])
  })
})
