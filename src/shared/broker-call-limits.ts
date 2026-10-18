export const LOOK_TOTAL_MS = 240_000
export const CHECK_MAX_MS = 900_000
export const ISOLATED_MAX_MS = 125_000
export const BROKER_CALL_TIMEOUT_MS = Math.max(LOOK_TOTAL_MS, CHECK_MAX_MS, ISOLATED_MAX_MS) + 30_000

export const TOOL_ANSWER_MS = 60_000
export const ANSWER_MARGIN_MS = 20_000
export const LOOK_ANSWER_MS = LOOK_TOTAL_MS + ANSWER_MARGIN_MS
export const CHECK_ANSWER_MS = CHECK_MAX_MS + ANSWER_MARGIN_MS
export const ISOLATED_ANSWER_MS = ISOLATED_MAX_MS + ANSWER_MARGIN_MS
export function answerBudgetMs(ms: number | undefined): number {
  const asked = typeof ms === 'number' && Number.isFinite(ms) && ms >= 1 ? Math.floor(ms) : TOOL_ANSWER_MS
  return Math.min(asked, BROKER_CALL_TIMEOUT_MS - 10_000)
}

export const MAX_COUNTED_CHECKS = 2
export const TURN_PAUSE_ALLOWANCE_MS = MAX_COUNTED_CHECKS * CHECK_MAX_MS
