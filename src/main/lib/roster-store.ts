import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentInfo } from '../../shared/types'
import type { TeamPlanNode } from './team-plan-store'
import { readJson, writeJson } from './json-file'
import { runnableBrain } from '../../shared/models'
import { seatKey } from '../../shared/plan-effect'

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5'

export interface TeamRebuild {
  agents: AgentInfo[]
  kept: AgentInfo[]
  hired: AgentInfo[]
  stoodDown: AgentInfo[]
}

export class RosterStore {
  private file: string

  constructor(
    stateDir: string,
    private defaults?: () => { agent: string; lead: string }
  ) {
    this.file = join(stateDir, 'agents.json')
  }

  defaultModelFor(kind: 'agent' | 'submanager'): string {
    const d = this.defaults?.()
    if (!d) return DEFAULT_AGENT_MODEL
    return (kind === 'submanager' ? d.lead : d.agent) || DEFAULT_AGENT_MODEL
  }

  list(): AgentInfo[] {
    return readJson<AgentInfo[]>(this.file, [])
  }

  get(id: string): AgentInfo | undefined {
    return this.list().find((a) => a.id === id)
  }

  add(
    name: string,
    role: string,
    model: string | undefined,
    opts?: {
      kind?: 'agent' | 'submanager'
      parentId?: string
      tools?: string[]
      maxTurns?: number
      whenToUse?: string
      label?: string
    }
  ): AgentInfo {
    const agent: AgentInfo = {
      id: randomUUID(),
      name,
      role,
      label: opts?.label,
      model: model ?? this.defaultModelFor(opts?.kind ?? 'agent'),
      kind: opts?.kind ?? 'agent',
      parentId: opts?.parentId,
      tools: opts?.tools,
      maxTurns: opts?.maxTurns,
      whenToUse: opts?.whenToUse,
      createdAt: new Date().toISOString()
    }
    writeJson(this.file, [...this.list(), agent])
    return agent
  }

  buildFromPlan(nodes: TeamPlanNode[]): TeamRebuild {
    const before = this.list()
    const bySeat = new Map(before.map((a) => [seatKey(a.name, a.kind), a]))
    const taken = new Set<string>()
    const kept: AgentInfo[] = []
    const hired: AgentInfo[] = []
    const after: AgentInfo[] = []
    const idOfLead = new Map<string, string>()

    const seat = (node: TeamPlanNode, parentId: string | undefined): AgentInfo => {
      const kind: 'agent' | 'submanager' = node.kind === 'submanager' ? 'submanager' : 'agent'
      const brain =
        kind === 'submanager'
          ? node.model
            ? runnableBrain('lead', node.model, this.defaultModelFor('submanager'))
            : undefined
          : node.model || undefined
      const key = seatKey(node.name, kind)
      const sitting = taken.has(key) ? undefined : bySeat.get(key)
      if (sitting) {
        taken.add(key)
        const same: AgentInfo = {
          ...sitting,
          role: node.role,
          label: node.label ?? sitting.label,
          model: brain ?? sitting.model,
          kind,
          parentId
        }
        kept.push(same)
        after.push(same)
        return same
      }
      const fresh: AgentInfo = {
        id: randomUUID(),
        name: node.name,
        role: node.role,
        label: node.label,
        model: brain ?? this.defaultModelFor(kind),
        kind,
        parentId,
        createdAt: new Date().toISOString()
      }
      hired.push(fresh)
      after.push(fresh)
      return fresh
    }

    for (const node of nodes.filter((n) => n.kind === 'submanager')) {
      idOfLead.set(node.name, seat(node, undefined).id)
    }
    for (const node of nodes.filter((n) => n.kind !== 'submanager')) {
      seat(node, node.parent ? idOfLead.get(node.parent) : undefined)
    }

    writeJson(this.file, after)
    const staying = new Set(after.map((a) => a.id))
    return { agents: after, kept, hired, stoodDown: before.filter((a) => !staying.has(a.id)) }
  }

  children(parentId: string): AgentInfo[] {
    return this.list().filter((a) => a.parentId === parentId)
  }

  subtree(rootId: string): AgentInfo[] {
    const all = this.list()
    const root = all.find((a) => a.id === rootId)
    if (!root) return []
    return [root, ...all.filter((a) => a.parentId === rootId)]
  }

  tree(): { roots: AgentInfo[]; childrenOf: (id: string) => AgentInfo[] } {
    const all = this.list()
    return {
      roots: all.filter((a) => !a.parentId),
      childrenOf: (id: string) => all.filter((a) => a.parentId === id)
    }
  }

  setModel(id: string, model: string): void {
    writeJson(
      this.file,
      this.list().map((a) => (a.id === id ? { ...a, model } : a))
    )
  }

  remove(id: string): void {
    writeJson(
      this.file,
      this.list().filter((a) => a.id !== id)
    )
  }
}
