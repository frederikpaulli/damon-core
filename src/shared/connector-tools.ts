import type { Connection } from './connectors'

export type ToolsProbe =
  | { ok: true; names: string[]; at: string }
  | { ok: false; error: string; at: string }

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function toolsLine(probe: ToolsProbe | undefined, claimed: number | undefined): string {
  if (probe && !probe.ok) {
    const claim = claimed === undefined ? '' : ` The publisher says ${count(claimed, 'tool')}.`
    return `Could not ask this connector what it offers: ${probe.error}.${claim}`
  }

  if (probe) {
    const n = probe.names.length
    if (n === 0) {
      return 'We asked this connector what it offers and it listed no tools.'
    }
    const observed = `We asked and it offers ${count(n, 'tool')}: ${probe.names.slice(0, 6).join(', ')}${n > 6 ? ', and more' : ''}.`
    if (claimed !== undefined && claimed !== n) {
      return `${observed} The publisher's description says ${claimed}.`
    }
    return observed
  }

  if (claimed !== undefined) {
    return `The publisher says ${count(claimed, 'tool')}. Nobody has checked.`
  }
  return ''
}

export function identityOf(conn: Connection): string {
  if (conn.transport === 'http') {
    const raw = (conn.url ?? '').trim()
    try {
      const u = new URL(raw)
      return `http:${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
    } catch {
      return `http:${raw.toLowerCase().replace(/\/+$/, '')}`
    }
  }
  return `stdio:${[conn.command ?? '', ...(conn.args ?? [])].join(' ').trim()}`
}

export interface Duplicate {
  identity: string
  names: string[]
  ids: string[]
}

export function duplicatesOf(connections: Connection[]): Duplicate[] {
  const groups = new Map<string, Connection[]>()
  for (const conn of connections) {
    const key = identityOf(conn)
    if (key === 'stdio:' || key === 'http:') continue
    groups.set(key, [...(groups.get(key) ?? []), conn])
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([identity, group]) => ({ identity, names: group.map((c) => c.name), ids: group.map((c) => c.id) }))
}

export interface ConfigReadResult {
  read: boolean
  missing: string[]
  failed: string[]
}

export function configWasRead(
  reported: Array<{ name: string; status?: string }>,
  expected: string[]
): ConfigReadResult {
  const seen = new Map(reported.map((s) => [s.name, s.status ?? '']))
  const missing = expected.filter((name) => !seen.has(name))
  const failed = expected.filter((name) => /^(failed|error)$/i.test(seen.get(name) ?? ''))
  return { read: reported.length > 0, missing, failed }
}
