// The slice of the app's renderer store that the Your turn screen reads.
// The full app keeps chat, fleet, files and settings state here as well;
// this showcase keeps only what YourTurnView and owner-needs use.
import { create } from 'zustand'
import type { AgentInfo, ChatMessage, TaskInfo } from '../../shared/types'
import type { TeamPlan } from '../../main/lib/team-plan-store'
import type { Blocker } from '../../main/lib/blocker-store'
import type { YourTurnItem } from '../../shared/your-turn'

export type WorkspaceTab = 'chat' | 'history' | 'files' | 'fleet' | 'yours' | 'limits'

export interface DamonState {
  selectedId: string | null
  tabs: Record<string, WorkspaceTab>
  autopilotWaiting: Record<string, number>
  budgetReached: Record<string, { spentUsd: number; limitUsd: number }>
  chats: Record<string, ChatMessage[]>
  busy: Record<string, boolean>
  holds: Record<string, boolean>
  rosters: Record<string, AgentInfo[]>
  tasks: Record<string, TaskInfo[]>
  proposals: Record<string, TeamPlan | null>
  blockers: Record<string, Blocker[]>
  yourTurn: Record<string, YourTurnItem[]>
  connectionsOpen: boolean
  accountsOpen: boolean
  spendLimitOpen: boolean
  receiveYourTurn: (payload: { projectId: string; items: YourTurnItem[] }) => void
  setConnectionsOpen: (open: boolean, forBlocker?: { projectId: string; blockerId: string; search?: string }) => void
  setAccountsOpen: (open: boolean) => void
  setSpendLimitOpen: (open: boolean) => void
  send: (text: string) => Promise<void>
  setTab: (projectId: string, tab: WorkspaceTab) => void
}

export const useDamon = create<DamonState>((set, get) => ({
  selectedId: null,
  tabs: {},
  autopilotWaiting: {},
  budgetReached: {},
  chats: {},
  busy: {},
  holds: {},
  rosters: {},
  tasks: {},
  proposals: {},
  blockers: {},
  yourTurn: {},
  connectionsOpen: false,
  accountsOpen: false,
  spendLimitOpen: false,
  receiveYourTurn: (payload) => set((s) => ({ yourTurn: { ...s.yourTurn, [payload.projectId]: payload.items } })),
  setConnectionsOpen: (open) => set({ connectionsOpen: open }),
  setAccountsOpen: (open) => set({ accountsOpen: open }),
  setSpendLimitOpen: (open) => set({ spendLimitOpen: open }),
  send: async (text) => {
    const id = get().selectedId
    if (!id) return
    await window.damon.sendToManager(id, text)
  },
  setTab: (projectId, tab) => set((s) => ({ tabs: { ...s.tabs, [projectId]: tab } }))
}))
