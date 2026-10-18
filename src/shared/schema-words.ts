import { ZodError } from 'zod'

export function schemaWords(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.slice(0, 6).map(issue => `${issue.path.length ? issue.path.join('.') : 'the request'}: ${issue.message}`).join('; ')
  }
  return e instanceof Error ? e.message : String(e)
}
