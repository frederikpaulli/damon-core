import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './json-file'

export interface Blocker {
  id: string
  what: string
  why: string
  who?: string
  at: string
  resolvedAt?: string
}

export function matchesConnection(what: string, connectionName: string): boolean {
  const a = what.trim().toLowerCase()
  const b = connectionName.trim().toLowerCase()
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const words = (s: string): string[] => s.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'the' && w !== 'your')
  const aw = words(a)
  const bw = words(b)
  if (aw.length === 0 || bw.length === 0) return false
  return aw.every((w) => bw.includes(w)) || bw.every((w) => aw.includes(w))
}

export function alreadyConnected<T extends { name: string; enabled: boolean }>(
  cannotReach: string,
  connections: T[]
): T | undefined {
  return connections.find((c) => c.enabled && matchesConnection(cannotReach, c.name))
}

export class BlockerStore {
  private file: string

  constructor(stateDir: string) {
    this.file = join(stateDir, 'blockers.json')
  }

  list(): Blocker[] {
    return readJson<Blocker[]>(this.file, [])
  }

  open(): Blocker[] {
    return this.list().filter((b) => !b.resolvedAt)
  }

  add(what: string, why: string, who?: string): Blocker {
    const existing = this.open().find((b) => matchesConnection(b.what, what) && b.who === who)
    if (existing) return existing
    const blocker: Blocker = { id: randomUUID(), what: what.trim(), why: why.trim(), who, at: new Date().toISOString() }
    writeJson(this.file, [...this.list(), blocker])
    return blocker
  }

  resolveFor(connectionName: string): Blocker[] {
    const now = new Date().toISOString()
    const freed = this.open().filter((b) => matchesConnection(b.what, connectionName))
    if (freed.length === 0) return []
    const ids = new Set(freed.map((b) => b.id))
    writeJson(
      this.file,
      this.list().map((b) => (ids.has(b.id) ? { ...b, resolvedAt: now } : b))
    )
    return freed
  }

  dismiss(id: string): Blocker[] {
    const now = new Date().toISOString()
    writeJson(
      this.file,
      this.list().map((b) => (b.id === id ? { ...b, resolvedAt: now } : b))
    )
    return this.open()
  }
}
