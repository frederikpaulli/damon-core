import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './json-file'
import type { Coverage } from '../../shared/checklists'

export interface TeamPlanNode {
  name: string
  role: string
  label?: string
  model: string
  modelWhy?: string
  kind: 'agent' | 'submanager'
  parent?: string
}

export interface TeamPlan {
  id: string
  map: string
  nodes: TeamPlanNode[]
  createdAt: string
  checklists?: string[]
  coverage?: Coverage[]
}

interface ApprovedPlan {
  plan: TeamPlan
  adjustment?: string
  remaining: number
}

export interface OwnerHire {
  id: string
  name: string
  label?: string
  role: string
  model: string
  kind: 'agent' | 'submanager'
  agentId?: string
  action: string
  approvedAt: string
  headcount: 1
}

interface PersistShape {
  pending?: TeamPlan
  approved?: ApprovedPlan
  ownerHires?: OwnerHire[]
}

export class TeamPlanStore {
  private file: string
  constructor(stateDir: string) {
    this.file = join(stateDir, 'team-plan.json')
  }

  private load(): PersistShape {
    return readJson<PersistShape>(this.file, {})
  }

  private save(s: PersistShape): void {
    writeJson(this.file, s)
  }

  proposePlan(
    map: string,
    nodes: TeamPlanNode[],
    checked?: { coverage?: Coverage[]; checklists?: string[] }
  ): TeamPlan {
    const plan: TeamPlan = {
      id: randomUUID(),
      map,
      nodes,
      createdAt: new Date().toISOString(),
      checklists: checked?.checklists,
      coverage: checked?.coverage
    }
    this.save({ pending: plan, ownerHires: this.load().ownerHires })
    return plan
  }

  pending(): TeamPlan | null {
    return this.load().pending ?? null
  }

  setNodeModel(planId: string, nodeName: string, model: string): boolean {
    const s = this.load()
    if (!s.pending || s.pending.id !== planId) return false
    const node = s.pending.nodes.find((n) => n.name === nodeName)
    if (!node) return false
    node.model = model
    this.save(s)
    return true
  }

  approved(): { plan: TeamPlan; adjustment?: string } | null {
    const a = this.load().approved
    return a ? { plan: a.plan, adjustment: a.adjustment } : null
  }

  hasApprovedPlan(): boolean {
    return Boolean(this.load().approved)
  }

  recordOwnerHire(hire: Omit<OwnerHire, 'id' | 'approvedAt' | 'headcount'>): OwnerHire {
    const s = this.load()
    const saved: OwnerHire = { ...hire, id: randomUUID(), approvedAt: new Date().toISOString(), headcount: 1 }
    s.ownerHires = [...(s.ownerHires ?? []), saved]
    this.save(s)
    return saved
  }

  ownerHires(): OwnerHire[] {
    return this.load().ownerHires ?? []
  }

  isExtraHire(): boolean {
    const a = this.load().approved
    return Boolean(a && a.remaining <= 0)
  }

  approve(planId: string, adjustment?: string): void {
    const s = this.load()
    if (!s.pending || s.pending.id !== planId) return
    s.approved = { plan: s.pending, adjustment, remaining: s.pending.nodes.length }
    s.pending = undefined
    this.save(s)
  }

  consumeApproval(): void {
    const s = this.load()
    if (!s.approved) return
    s.approved.remaining = Math.max(0, s.approved.remaining - 1)
    this.save(s)
  }

  clearApproved(): void {
    const s = this.load()
    s.approved = undefined
    this.save(s)
  }
}
