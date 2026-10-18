import type { LookDirection } from './look-config'

export interface LookedShot { file: string; place: string; state?: string; width: number; scheme: 'light' | 'dark'; usable: boolean; opened: boolean; measured?: string[] }
export interface VisualResult { place: string; width: number; scheme: 'light' | 'dark'; state?: string; verdict: 'ok' | 'fault'; picture: string; note?: string }

export const DESIGN_SKILLS = ['apple-design', 'impeccable', 'frontend-design:frontend-design', 'ui-ux-pro-max', 'web-design-guidelines']
export function designSkillFor(on: (id: string) => boolean): string | null {
  return DESIGN_SKILLS.find((id) => { try { return on(id) } catch { return false } }) ?? null
}

export const SCREEN_SEVERITY = 'HOW MUCH A DESIGN POINT WEIGHS. Blocking only when the work breaks an owner standard, the project\'s design documents, or a measurable rule: text contrast under 4.5:1 (3:1 for large text), an icon, border or control edge under 3:1 against its background (in dark mode too), content that scrolls sideways or sits off-screen at 390 px, a click target under 24 px on desktop or 44 px on phone, a control with no accessible name, keyboard focus lost or invisible, text clipped or overlapping, or a missing empty, loading or error state. Everything else apple-design suggests is a note and never blocks. When they disagree, owner standards win, then the design documents, then apple-design. This is a Windows desktop app: apply Apple\'s principles, not macOS-only conventions (menu bar, Cmd shortcuts, window controls).'
export const SCREEN_SELF_CLAUSE = 'fix blocking points under the severity rule first; a note is optional'
export const SCREEN_CHECK = `THIS JOB CHANGES SCREENS. Check every screen it changed against apple-design. In round 1, read it with the skills tool and load its always-load references (accessibility, layout, typography, color) plus at most two for what is on screen; do not load designing-for-macos.md or designing-for-ios.md. From round 2 on, check only the points the earlier round named and the files changed since. ${SCREEN_SEVERITY}`

export const LOOK_WORDS = /\b(look|looks|design|visual|layout|colou?r|dark|light mode|font|type|spacing|align|contrast|screen|mobile|phone|desktop|icon|beautiful|polish|premium|clean|important)\b/i

export const RUBRIC = [
  '1. The one thing this screen is for is the most prominent thing on it; the most important number reads first (a note unless a design document or owner standard names it).',
  "2. Spacing and alignment follow the design documents' scale and grid; nothing sits a few pixels off its neighbours (a note unless a design document or owner standard names it).",
  '3. Text: nothing clipped, cut off, overlapping or wrapping badly; the longest names and largest amounts fit (the full state).',
  '4. Contrast: every text readable against its background in both schemes. Damon measured it; any text it reports below 4.5:1 (3:1 for large text) is a finding.',
  '5. Dark: no white flashes or boxes, icons and borders still visible (under 3:1 is blocking), nothing glaring.',
  '6. Phone: no sideways scrolling, nothing off-screen (both blocking), tap targets at least 44 px (Damon measured them).',
  '7. States: the empty state says what to do next; the full state is not cramped; loading and errors look intended.',
  "8. It uses the project's own components and tokens and looks like the rest of the app, not a one-off style.",
  '9. Important surfaces look important; nothing announces itself as plain, temporary or unfinished.'
].join('\n')

export function carefulBrief(input: { designDocs: string[]; standards: string[]; skill: string | null; who: 'reviewer' | 'worker'; docsUnknown?: boolean; direction?: LookDirection }): string {
  const d = input.direction
  const lines = [
    'THE CAREFUL LOOK. Something on screen changed, so how it looks is judged with care, the way the owner asked.',
    input.designDocs.length ? `First read the project's design documents: ${input.designDocs.join(', ')}. Judge against them, not against taste.`
      : input.docsUnknown ? "First read the project's design documents (those damon-look.json names under design; otherwise the files named for design, a style guide or the brand). Judge against them, not against taste."
      : 'This project has no design document; judge against the screens already in the app and say so.',
    input.standards.length ? `The owner's standards about how things look (they win): ${input.standards.join(' | ')}` : '',
    d ? `THE DIRECTION FOR ${d.surface} (damon-look.json): a ${d.mode} for ${d.task}. Anchor: ${d.anchor}.${d.preserve.length ? ` Keep: ${d.preserve.join('; ')}.` : ''}${d.states.length ? ` States: ${d.states.join(', ')}.` : ''}` : '',
    input.skill ? `Read the design skill ${input.skill} with the skills tool before you judge; its rules sit under the owner's.` : '',
    SCREEN_SEVERITY,
    'Do not load designing-for-macos.md or designing-for-ios.md: this is a Windows desktop app.',
    'Photograph with look_at_screens every place this change can show (each state the project names), in light and dark, and open every picture with your Read tool. A picture Damon marks unusable (an error instead of the screen, sample data that did not run) shows nothing: fix the cause or say what you could not see.',
    RUBRIC
  ]
  if (input.who === 'reviewer') lines.push('In your submit_review summary write VISUAL RESULTS: and one JSON array, one entry per picture you judged: {"place", "width", "scheme", "state", "verdict": "ok" or "fault", "picture": "<its file name>", "note"}: one line per picture, never two, in every state the project names for the places you photographed (the full set at 390 and 1280 px in light and dark in one state, and each other state at least at 390 px in light). A fault line is only for a blocking point under the rule above, and is also a blocking finding with that picture named in its evidence; a preference is verdict ok with a note. Damon refuses "meets" unless each place you judged has an opened, usable picture at 390 and 1280 px in light and dark, and no line says fault.')
  else lines.push('Look at it this way yourself before you report; your reviewer will, picture by picture.')
  return lines.filter(Boolean).join('\n')
}

export function parseVisualResults(text: string): { results: VisualResult[]; problem?: string } {
  const at = (text ?? '').search(/VISUAL RESULTS:?\s*\[/i)
  if (at < 0) return { results: [], problem: 'Your summary has no VISUAL RESULTS block.' }
  const from = text.indexOf('[', at)
  for (let end = text.indexOf(']', from); end >= 0; end = text.indexOf(']', end + 1)) {
    try {
      const raw = JSON.parse(text.slice(from, end + 1)) as unknown
      if (!Array.isArray(raw)) break
      const results = raw.filter((r): r is VisualResult => !!r && typeof r === 'object' && typeof (r as VisualResult).place === 'string' && typeof (r as VisualResult).width === 'number' && ((r as VisualResult).scheme === 'light' || (r as VisualResult).scheme === 'dark') && ((r as VisualResult).verdict === 'ok' || (r as VisualResult).verdict === 'fault') && typeof (r as VisualResult).picture === 'string')
      return { results }
    } catch {}
  }
  return { results: [], problem: 'The VISUAL RESULTS block is not one JSON array.' }
}

const nameOf = (p: string): string => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase()

export function visualProblems(input: { summary: string; shots: readonly LookedShot[]; schemes?: readonly ('light' | 'dark')[]; everyPlace?: readonly string[]; states?: readonly string[] }): string[] {
  const out: string[] = []
  const schemes = input.schemes?.length ? input.schemes : (['light', 'dark'] as const)
  const good = input.shots.filter((s) => s.usable && s.opened)
  if (input.shots.some((s) => !s.usable) && !good.length) out.push('Every picture this review took is unusable (an error instead of the screen, or sample data that did not run). Make the screen show, or record "cannot-tell".')
  const parsed = parseVisualResults(input.summary)
  if (parsed.problem) out.push(parsed.problem)
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
  const photographed = new Set(input.shots.map((s) => s.place.trim().toLowerCase()))
  const places = [...new Map([...input.shots.map((s) => s.place), ...parsed.results.map((r) => r.place), ...(input.everyPlace ?? [])].map((p) => p.trim()).filter(Boolean).map((p) => [p.toLowerCase(), p] as const)).values()]
  if (!places.length) out.push('No usable picture was opened in this review. Photograph the changed screens with look_at_screens and open them.')

  const byName = new Map(good.map((s) => [nameOf(s.file), s] as const))
  const judged = new Set<LookedShot>()
  const seen = new Set<string>()
  for (const r of parsed.results) {
    const name = nameOf(r.picture)
    const shot = byName.get(name)
    if (!shot) out.push(`VISUAL RESULTS names ${name}, which is not a usable picture this review opened.`)
    if (r.verdict === 'fault') out.push(`VISUAL RESULTS says fault for ${r.place} at ${r.width} px in ${r.scheme}: that is a blocking finding, not "meets".`)
    const measured = (shot?.measured ?? []).find((m) => /contrast|tap targets|wider than|sideways|error instead|did not run/i.test(m))
    if (r.verdict === 'ok' && measured && !(r.note ?? '').trim()) out.push(`${name}: Damon measured "${measured.slice(0, 160)}". Say in that line's note why it is acceptable, or record it as a fault.`)
    if (!shot) continue
    if (seen.has(name)) { out.push(`${name}: judged twice in VISUAL RESULTS.`); continue }
    seen.add(name)
    const stateDiffers = !!shot.state && !!r.state && !same(shot.state, r.state)
    if (!same(r.place, shot.place) || r.width !== shot.width || r.scheme !== shot.scheme || stateDiffers) {
      const said = (x: { place: string; width: number; scheme: string; state?: string }, withState: boolean): string => `${x.place}, ${x.width} px in ${x.scheme}${withState && x.state ? `, state ${x.state}` : ''}`
      out.push(`${name}: the VISUAL RESULTS line says ${said(r, stateDiffers)}, but the picture is ${said(shot, stateDiffers)}.`)
      continue
    }
    judged.add(shot)
  }

  const states = [...new Set((input.states ?? []).map((s) => s.trim()).filter(Boolean))]
  const stateOf = (s: LookedShot): string => (s.state ?? '').trim().toLowerCase()
  const firstScheme = schemes.includes('light') ? 'light' : schemes[0]!
  for (const place of places) {
    const mine = good.filter((s) => same(s.place, place))
    const at = (width: number, scheme: string, pool: readonly LookedShot[]): LookedShot[] => pool.filter((s) => s.width === width && s.scheme === scheme)
    const cells = [390, 1280].flatMap((width) => schemes.map((scheme) => ({ width, scheme })))
    const candidates = [...new Set(mine.map(stateOf))]
    const score = (st: string): [number, number] => {
      const pool = mine.filter((s) => stateOf(s) === st)
      const shotsAt = cells.map((c) => at(c.width, c.scheme, pool))
      return [shotsAt.filter((x) => !x.length).length, shotsAt.filter((x) => x.length && !x.some((s) => judged.has(s))).length]
    }
    const best = candidates.sort((a, b) => { const [pa, ra] = score(a), [pb, rb] = score(b); return pa - pb || ra - rb })[0]
    const pool = best === undefined ? [] : mine.filter((s) => stateOf(s) === best)
    const need: { width: number; scheme: string; state?: string; shots: LookedShot[] }[] = cells.map((c) => ({ ...c, shots: at(c.width, c.scheme, pool) }))
    if (photographed.has(place.toLowerCase())) {
      for (const st of states) need.push({ width: 390, scheme: firstScheme, state: st, shots: at(390, firstScheme, mine.filter((s) => stateOf(s) === st.toLowerCase())) })
    }
    for (const n of need) {
      const inState = n.state ? ` (state ${n.state})` : ''
      if (!n.shots.length) { out.push(`${place}: no opened, usable picture at ${n.width} px in ${n.scheme}${inState}.`); continue }
      if (n.shots.some((s) => judged.has(s))) continue
      const shot = n.shots[0]!
      const fault = shot.measured?.[0]
      out.push(`${place}: no VISUAL RESULTS line for ${nameOf(shot.file)} (${n.width} px, ${n.scheme}${n.state ? `, state ${n.state}` : ''})${fault ? `; Damon measured "${fault.slice(0, 160)}", judge it` : ''}.`)
    }
  }
  return [...new Set(out)]
}
