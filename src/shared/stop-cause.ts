export const OWNER_STOP = 'The owner stopped this turn.'
export const INPUT_CHANGED_STOP = 'Damon stopped this turn because a file it reads changed.'
export const WATCHER_STOP = 'Damon stopped this turn because a file or a permission it works from changed.'

export type StopCause = 'owner' | 'input-changed' | 'watcher'

export function stopCause(text: string | undefined): StopCause | null {
  const said = (text ?? '').trimStart()
  if (said.startsWith(INPUT_CHANGED_STOP)) return 'input-changed'
  if (said.startsWith(WATCHER_STOP)) return 'watcher'
  if (said.startsWith(OWNER_STOP)) return 'owner'
  return null
}

export function stopLabel<R extends { ok: boolean; cancelled?: boolean; error?: string }>(result: R, damonsReason: string | undefined, ownerStopped: boolean): R {
  if (result.ok || !result.cancelled || !damonsReason) return result
  return ownerStopped ? result : { ...result, error: damonsReason }
}

export function isStopSentence(text: string | undefined): boolean {
  return stopCause(text) !== null
}
