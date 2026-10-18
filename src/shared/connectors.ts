export interface Connection {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  preset?: string
}

export interface ConnectorPreset {
  key: string
  name: string
  blurb: string
  category: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  needs?: string
  auth?: 'oauth' | 'api-key' | 'none'
  publisher: string
  source: string
  version: string
}

export interface PresetChange {
  name: string
  before: string
  after: string
}

export function syncToPresets(
  saved: Connection[],
  presets: ConnectorPreset[] = CONNECTOR_PRESETS
): { connections: Connection[]; changed: PresetChange[] } {
  const changed: PresetChange[] = []
  const connections = saved.map((conn) => {
    if (!conn.preset) return conn
    const preset = presets.find((p) => p.key === conn.preset)
    if (!preset) return conn

    const before = [conn.command ?? '', ...(conn.args ?? [])].join(' ').trim()
    const after = [preset.command ?? '', ...(preset.args ?? [])].join(' ').trim()
    if (before === after && conn.transport === preset.transport) return conn

    changed.push({ name: preset.name, before, after })
    return {
      ...conn,
      transport: preset.transport,
      command: preset.command,
      args: preset.args ? [...preset.args] : undefined,
      env: mergeEnv(preset.env, conn.env)
    }
  })
  return { connections, changed }
}

function mergeEnv(
  wanted: Record<string, string> | undefined,
  had: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!wanted && !had) return undefined
  const out: Record<string, string> = { ...(wanted ?? {}) }
  for (const [key, value] of Object.entries(had ?? {})) {
    if (value && key in out) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function isPinned(preset: ConnectorPreset): boolean {
  if (!preset.version || /latest/i.test(preset.version)) return false
  const line = [preset.command ?? '', ...(preset.args ?? [])].join(' ')
  if (/@latest\b/i.test(line)) return false
  return line.includes(preset.version)
}

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    key: 'browser',
    name: 'Web browser (Chrome)',
    blurb: 'Let the team open and control a real Chrome browser: click, type, fill forms, read pages, take screenshots.',
    category: 'Web',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.78'],
    needs:
      "Google Chrome installed. The team drives a Chrome of its own, with its own logins: open it from the Connections screen for a project, sign in there to the sites the team needs, and the logins stay. It opens on your screen while the team uses it.",
    publisher: 'Microsoft',
    source: 'github.com/microsoft/playwright-mcp',
    version: '0.0.78'
  },
  {
    key: 'scrapling',
    name: 'Scrape websites (Scrapling)',
    blurb:
      'Pull data off websites at scale, prices, listings, tables, whole pages, without opening a browser on your screen. Handles sites that fight back.',
    category: 'Web',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'scrapling[ai]==0.4.15', 'scrapling-mcp'],
    needs:
      'Python with uv installed (get it at astral.sh/uv). It installs itself on first use. Reading ordinary pages works straight away. For sites that block robots, or ones that only fill in once opened, run "scrapling install" once in a terminal to fetch the browser engines those two modes need.',
    publisher: 'Karim Shoair (D4Vinci)',
    source: 'github.com/D4Vinci/Scrapling',
    version: '0.4.15'
  },
  {
    key: 'memory',
    name: 'Long-term knowledge',
    blurb: 'A shared memory the team can write facts into and look back on, beyond each teammate\'s own notes.',
    category: 'Memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'],
    needs: 'Nothing. Stored locally on your machine.',
    publisher: 'Anthropic',
    source: 'github.com/modelcontextprotocol/servers',
    version: '2026.7.4'
  },
  {
    key: 'thinking',
    name: 'Deeper step-by-step thinking',
    blurb: 'Gives the team a scratchpad for working through hard problems one careful step at a time.',
    category: 'Reasoning',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.7.4'],
    needs: 'Nothing.',
    publisher: 'Anthropic',
    source: 'github.com/modelcontextprotocol/servers',
    version: '2026.7.4'
  },
  {
    key: 'markitdown',
    name: 'Read any document (MarkItDown)',
    blurb:
      'Let the team turn PDFs, Word, Excel, PowerPoint, images and web pages into clean text they can actually read and work with. Microsoft open-source.',
    category: 'Documents',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'markitdown-mcp==0.0.1a4', 'markitdown-mcp'],
    needs:
      'Python with uv installed (get it at astral.sh/uv). It installs itself on first use. This one is still an early release: Microsoft has never published a finished version of it, so 0.0.1a4 is the newest there is.',
    publisher: 'Microsoft',
    source: 'github.com/microsoft/markitdown',
    version: '0.0.1a4'
  },
  {
    key: 'perplexity',
    name: 'Perplexity (live web research)',
    blurb: 'Let the team ask Perplexity for up-to-date, cited answers from across the web. Great for research.',
    category: 'Research',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@perplexity-ai/mcp-server@1.2.0'],
    env: { PERPLEXITY_API_KEY: '' },
    needs: 'A Perplexity API key. Add it after enabling (get one at perplexity.ai/settings/api).',
    publisher: 'Perplexity',
    source: 'github.com/perplexityai/modelcontextprotocol',
    version: '1.2.0'
  }
]

export function connectionServerKey(conn: Connection): string {
  return (conn.preset ?? conn.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function connectionToServerDef(conn: Connection): Record<string, unknown> | null {
  if (conn.transport === 'http') {
    if (!conn.url) return null
    return { type: 'http', url: conn.url }
  }
  if (!conn.command) return null
  const def: Record<string, unknown> = { command: conn.command }
  if (conn.args && conn.args.length > 0) def.args = conn.args
  if (conn.env && Object.keys(conn.env).length > 0) def.env = conn.env
  return def
}

export interface McpBundle {
  servers: Record<string, unknown>
  toolPrefixes: string[]
}

export function buildConnectionBundle(connections: Connection[]): McpBundle {
  const servers: Record<string, unknown> = {}
  const toolPrefixes: string[] = []
  for (const conn of connections) {
    if (!conn.enabled) continue
    const def = connectionToServerDef(conn)
    if (!def) continue
    const key = connectionServerKey(conn)
    if (!key || servers[key]) continue
    servers[key] = def
    toolPrefixes.push(`mcp__${key}`)
  }
  return { servers, toolPrefixes }
}

export function buildMcpBundle(damonUrl: string, connections: Connection[]): McpBundle {
  const servers: Record<string, unknown> = { damon: { type: 'http', url: damonUrl } }
  const toolPrefixes = ['mcp__damon']
  for (const conn of connections) {
    if (!conn.enabled) continue
    const def = connectionToServerDef(conn)
    if (!def) continue
    const key = connectionServerKey(conn)
    if (!key || servers[key]) continue
    servers[key] = def
    toolPrefixes.push(`mcp__${key}`)
  }
  return { servers, toolPrefixes }
}

export function connectionsForJob<T extends { name: string; preset?: string }>(all: T[], wanted: string[] | undefined): T[] {
  if (wanted === undefined) return all
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const asked = wanted.map(norm).filter((w) => w.length > 0)
  if (asked.length === 0) return []
  return all.filter((c) => {
    const key = norm(c.preset ?? '')
    const name = norm(c.name)
    return asked.some((w) => w === key || w === name || (w.length >= 3 && (name.includes(w) || key.includes(w))))
  })
}
