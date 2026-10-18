export const ADMIN_NOTE = /^(?:Prerequisite \S+ replaced by |The agreed needs or inputs for "|Recovered an owner input for "|Critical project information changed: )/
export function isAdminNote(entry: string): boolean {
  return typeof entry === 'string' && ADMIN_NOTE.test(entry)
}
export function qualityRounds(feedback: readonly string[] | undefined): number {
  return (feedback ?? []).filter((f) => typeof f === 'string' && !isAdminNote(f)).length
}
export const MAX_FEEDBACK_ENTRIES = 8
