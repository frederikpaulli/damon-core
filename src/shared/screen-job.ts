import { hasDocumentSurface, hasVisibleSurface, interfaceFiles } from './review'

type ScreenJobInput = { title: string; instructions?: string; acceptance?: string; writes?: readonly string[] }

export function carefulJobOf(t: ScreenJobInput, visualByChange?: boolean): boolean {
  if (visualByChange !== undefined) return visualByChange
  return hasVisibleSurface(`${t.title} ${t.instructions ?? ''} ${t.acceptance ?? ''}`) || interfaceFiles((t.writes ?? []).filter((w) => !/[*?]/.test(w))).length > 0
}

const UI_EXT = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less)$/i
const DOC_HTML = /(?:letter|report|proposal|invoice)/i
const DOC_FOLDER = /^(?:outgoing|pipeline|docs?|data|reports?|notes|research|brain|content)(?:\/|$)/i
const UI_FOLDER = /(?:^|\/)(?:renderer|components|screens|views|pages|ui|styles|app)(?:\/|$)/i
const wild = (w: string): boolean => /[*?]/.test(w)
const prefixOf = (w: string): string => w.replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?]/)[0]!
export function reviewChangesNoScreen(o: { files: readonly string[]; filesVisual?: boolean; job: boolean }): boolean {
  if (o.job) return false
  if (o.filesVisual !== undefined) return !o.filesVisual
  return interfaceFiles(o.files.filter((f) => !/[*?]/.test(f))).length === 0
}

export function screenSkillJob(t: ScreenJobInput, visualByChange?: boolean): boolean {
  const text = `${t.title} ${t.instructions ?? ''} ${t.acceptance ?? ''}`
  const all = t.writes ?? []
  const writes = all.filter((w) => !wild(w))
  const wilds = all.filter(wild)
  const uiWild = wilds.some((w) => UI_EXT.test(w) || UI_FOLDER.test(prefixOf(w) || w.replace(/\\/g, '/')))
  const ui = writes.some((w) => UI_EXT.test(w)) || uiWild
  const docHtml = writes.some((w) => /\.html?$/i.test(w) && DOC_HTML.test(w))
  const docFolder = all.some((w) => DOC_FOLDER.test(w.replace(/\\/g, '/').replace(/^\.\//, '')))
  if (!ui && (hasDocumentSurface(text) || docHtml || docFolder)) return false
  if (visualByChange !== undefined) return visualByChange
  if (writes.length) return interfaceFiles(writes).length > 0
  if (wilds.length) return uiWild ? true : carefulJobOf(t)
  return carefulJobOf(t)
}
