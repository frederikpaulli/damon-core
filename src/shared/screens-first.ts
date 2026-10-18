import { areaPath, changeClass, codeRole, type CodeContext } from './change-class'
import type { LookConfig } from './look-config'

const LOOK_FILE = 'damon-look.json'

export function screenStageRefusal(writes: readonly string[], ctx: CodeContext, look: LookConfig | null): string | null {
  const allowed = new Set([LOOK_FILE, ...(look?.before ? [look.before] : []), ...Object.values(look?.schemeScripts ?? {})].map((p) => p.toLowerCase()))
  const wrong = writes.filter((w) => {
    const p = w.replace(/\\/g, '/').trim()
    if (allowed.has(p.toLowerCase())) return false
    const role = codeRole(/[*?]/.test(p) ? areaPath(p) : p, ctx)
    return role !== 'frontend' && !(role === 'tests' && !changeClass([p], ctx).backend)
  })
  return wrong.length ? `Nothing was assigned: a screen stage builds the screen on sample data only, and ${wrong.join(', ')} would change the backend, a contract or a config. Give ${wrong.length === 1 ? 'it' : 'them'} to the wire stage (stage "wire", waiting for this job).` : null
}

export function screenStageCriteria(look: LookConfig | null): string[] {
  const states = look?.states.length ? look.states.join(', ') : 'empty, one, full'
  return [
    look ? `The screen works with sample data in every state ${LOOK_FILE} names (${states}), and the sample data (${look.before ?? 'a before script named in ' + LOOK_FILE}) answers every call the screen makes, so no picture shows an error or an empty place where data should be.` : `Create ${LOOK_FILE} at the project root naming this screen's place, the states empty, one and full, and a before script that answers every call the screen makes with invented data; then the screen works in every state.`,
    'The full state holds the longest names, the largest amounts and the most rows the real data can have.',
    'It was looked at on phone and desktop width, in light and dark, in every state, and it looks right by the design documents.',
    'Nothing in the backend, a contract or the real data layer is changed; the screen reaches its data through one place in the screen code that the wire stage connects.',
    "Every call the screen makes and every sample answer uses the shapes the project's contracts define (its contract, schema or type files); where a shape is missing, the screen names it in its report for the wire stage. For a web app the sample-data script answers the screen's requests (for example by answering fetch); it never reaches a real server.",
    `For a new surface, ${LOOK_FILE} also holds its direction, written once as "direction": {"surface": its name (at most 80 characters), "task": what a person does there (at most 200), "mode": one of tool, reading, promotion, experience, "anchor": the one thing the eye goes to first (at most 200), "preserve": up to 5 things that must stay (at most 120 each), "states": up to 3 of its states}. It replaces an earlier surface's direction; it is part of this job, never a job of its own.`
  ]
}

export function wireStageCriteria(): string[] {
  return [
    'The screen now shows the real data, through the place the screen stage left for it.',
    "The sample data still answers every call the screen makes, so the screen's look keeps working.",
    'The screen was looked at again on phone and desktop width, in light and dark, in every state.'
  ]
}

export function stageCriteria(stage: 'screen' | 'wire' | undefined, own: readonly string[], look: LookConfig | null): string[] {
  if (!stage) return [...own]
  const extra = stage === 'screen' ? screenStageCriteria(look) : wireStageCriteria()
  const said = new Set(own.map((c) => c.trim().toLowerCase()))
  return [...own, ...extra.filter((c) => !said.has(c.trim().toLowerCase()))]
}
