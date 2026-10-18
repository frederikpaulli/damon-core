import { createHash } from 'node:crypto'

export function compareLineRange(draftText: string, projectText: string, from: number, to: number): {
  identical: boolean; draftRangeSha256: string; projectRangeSha256: string; draftLines: number; projectLines: number
  firstDifferentLine?: number; draftText?: string; projectText?: string
} {
  const lines = (text: string) => text.replace(/\r\n/g, '\n').split('\n')
  const draft = lines(draftText), project = lines(projectText)
  const a = draft.slice(from - 1, to), b = project.slice(from - 1, to)
  const hash = (x: string[]) => createHash('sha256').update(x.join('\n')).digest('hex')
  let first: number | null = null
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { first = from + i; break }
  return {
    identical: first === null, draftRangeSha256: hash(a), projectRangeSha256: hash(b), draftLines: draft.length, projectLines: project.length,
    ...(first !== null ? { firstDifferentLine: first, draftText: (a[first - from] ?? '(no line)').slice(0, 300), projectText: (b[first - from] ?? '(no line)').slice(0, 300) } : {})
  }
}
