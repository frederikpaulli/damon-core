export type LeanSwitch =
  | 'adminNotesFree'
  | 'carryDrafts'
  | 'unchangedCodeStands'
  | 'severityByRole'
  | 'styleByRole'
  | 'packageOnWhatLeaves'
  | 'bookkeepingSignsOff'
  | 'managerKeepsLeads'
  | 'idleWatch'
  | 'processFollowUps'
  | 'checkpoints'
  | 'carefulVisual'
  | 'checksByChange'
  | 'screensFirst'
  | 'featureJobs'
  | 'checksFirst'
  | 'smallFixLane'
  | 'ownerFactsLedger'

export const LEAN_DEFAULTS: Record<LeanSwitch, boolean> = {
  adminNotesFree: true,
  carryDrafts: true,
  unchangedCodeStands: true,
  severityByRole: true,
  styleByRole: true,
  packageOnWhatLeaves: true,
  bookkeepingSignsOff: true,
  managerKeepsLeads: true,
  idleWatch: true,
  processFollowUps: true,
  checkpoints: true,
  carefulVisual: true,
  checksByChange: true,
  screensFirst: true,
  featureJobs: true,
  checksFirst: true,
  smallFixLane: true,
  ownerFactsLedger: false
}

export function leanOn(settings: { lean?: Partial<Record<LeanSwitch, boolean>> } | null | undefined, key: LeanSwitch): boolean {
  const set = settings?.lean?.[key]
  return typeof set === 'boolean' ? set : LEAN_DEFAULTS[key]
}

export const LEAN_BEFORE = { from: '2026-09-28', to: '2026-10-04' } as const
