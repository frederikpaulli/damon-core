const PLUMBING = /^Error invoking remote method '[^']+': (?:Error: )?/

export function errorText(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback
  const said = reason.message.replace(PLUMBING, '').trim()
  return said || fallback
}
