export const RENDERED_VIEWS: readonly string[] = ['TASKS.md', 'TASKS.csv']

export function isRenderedView(path: string): boolean {
  const f = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return RENDERED_VIEWS.includes(f)
}

export const viewNotAnInput = (path: string): string =>
  `${path} is drawn by Damon from its own records, so it is not on the approved list: every teammate reads it as Damon's own record, and the records themselves with their list tool.`

export const viewNotATarget = (path: string): string =>
  `${path} is drawn by Damon from its own records and redrawn on every change, so a draft of it would be lost. Change the record with its record tool instead.`

export function viewsInWrites(writes: readonly string[] | undefined): string {
  const views = (writes ?? []).filter((w) => isRenderedView(w))
  if (!views.length) return ''
  const one = views.length === 1
  return `${views.join(' and ')}, in your writes, ${one ? 'is' : 'are'} drawn by Damon from its own records and redrawn on every change, so a draft of ${one ? 'it' : 'them'} is never kept. Change the record with its record tool and read it back: the file follows on its own.`
}
