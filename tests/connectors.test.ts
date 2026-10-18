import { describe, expect, test } from 'vitest'
import {
  buildMcpBundle,
  connectionServerKey,
  connectionToServerDef,
  CONNECTOR_PRESETS,
  type Connection
} from '../src/shared/connectors'

const stdio = (over: Partial<Connection>): Connection => ({
  id: 'x',
  name: 'Web browser (Chrome)',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@playwright/mcp@0.0.78'],
  ...over
})

describe('connectors', () => {
  test('presets are well-formed', () => {
    expect(CONNECTOR_PRESETS.length).toBeGreaterThanOrEqual(3)
    for (const p of CONNECTOR_PRESETS) {
      expect(p.key).toBeTruthy()
      expect(p.command).toBeTruthy()
    }
  })

  test('markitdown preset is present and builds a valid stdio server def', () => {
    const md = CONNECTOR_PRESETS.find((p) => p.key === 'markitdown')
    expect(md).toBeTruthy()
    expect(connectionToServerDef(stdio({ command: md!.command, args: md!.args }))).toEqual({
      command: 'uvx',
      args: ['--from', 'markitdown-mcp==0.0.1a4', 'markitdown-mcp']
    })
  })

  test('server key is a safe slug', () => {
    expect(connectionServerKey(stdio({ name: 'Web Browser (Chrome)!' }))).toBe('web-browser-chrome')
  })

  test('stdio and http server defs', () => {
    expect(connectionToServerDef(stdio({}))).toEqual({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.78'] })
    expect(connectionToServerDef({ id: 'h', name: 'X', enabled: true, transport: 'http', url: 'http://localhost:9' })).toEqual(
      { type: 'http', url: 'http://localhost:9' }
    )
    expect(connectionToServerDef({ id: 'b', name: 'bad', enabled: true, transport: 'stdio' })).toBeNull()
  })

  test('bundle always includes damon, plus only enabled connections', () => {
    const bundle = buildMcpBundle('http://127.0.0.1:5/mcp/p?token=t', [
      stdio({ preset: 'browser', name: 'Web browser (Chrome)' }),
      stdio({ id: 'off', preset: 'memory', name: 'Long-term knowledge', enabled: false })
    ])
    expect(bundle.servers.damon).toEqual({ type: 'http', url: 'http://127.0.0.1:5/mcp/p?token=t' })
    expect(Object.keys(bundle.servers)).toContain('browser')
    expect(Object.keys(bundle.servers)).not.toContain('long-term-knowledge')
    expect(bundle.toolPrefixes).toEqual(['mcp__damon', 'mcp__browser'])
  })
})
