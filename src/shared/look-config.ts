import { z } from 'zod'

export type Scheme = 'light' | 'dark'
export interface LookPlace { name: string; path: string }
export type LookMode = 'tool' | 'reading' | 'promotion' | 'experience'
export interface LookDirection { surface: string; task: string; mode: LookMode; anchor: string; preserve: string[]; states: string[] }
export interface LookConfig { command?: string; places: LookPlace[]; before?: string; states: string[]; schemes: Scheme[]; schemeScripts?: Partial<Record<Scheme, string>>; design?: string[]; direction?: LookDirection; problem?: string }

const DEFAULT: LookConfig = { places: [{ name: 'Start', path: '/' }], states: [], schemes: ['light', 'dark'] }
const fallback = (problem?: string): LookConfig => ({ ...DEFAULT, places: [...DEFAULT.places], schemes: [...DEFAULT.schemes], ...(problem ? { problem } : {}) })

const inside = (p: string): boolean => !!p && !/^[a-z]:/i.test(p) && !p.startsWith('/') && !p.startsWith('\\') && !p.replace(/\\/g, '/').split('/').includes('..')

const schema = z.object({
  command: z.string().min(1).max(500).optional(),
  places: z.array(z.object({ name: z.string().min(1).max(60), path: z.string().min(1).max(300) }).strict()).min(1).max(12),
  before: z.string().min(1).max(300).optional(),
  states: z.array(z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/)).max(3).optional(),
  schemes: z.array(z.enum(['light', 'dark'])).min(1).max(2).optional(),
  schemeScripts: z.object({ light: z.string().min(1).max(300).optional(), dark: z.string().min(1).max(300).optional() }).strict().optional(),
  design: z.array(z.string().min(1).max(300)).max(8).optional(),
  direction: z.unknown().optional()
}).strict()

const STATE = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/)
const directionSchema = z.object({
  surface: z.string().min(1).max(80),
  task: z.string().min(1).max(200),
  mode: z.enum(['tool', 'reading', 'promotion', 'experience']),
  anchor: z.string().min(1).max(200),
  preserve: z.array(z.string().min(1).max(120)).max(5).optional(),
  states: z.array(STATE).max(3).optional()
}).strict()

export function directionFor(direction: LookDirection | undefined, job: { title?: string; piece?: string }, own: boolean): LookDirection | undefined {
  if (!direction) return undefined
  if (own) return direction
  const surface = direction.surface.trim().toLowerCase()
  return surface && [job.title, job.piece].some((w) => (w ?? '').toLowerCase().includes(surface)) ? direction : undefined
}

export function parseLookConfig(raw: unknown): LookConfig {
  if (raw === null || raw === undefined) return fallback()
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return fallback(`damon-look.json was not used: ${parsed.error.issues.map(i => `${i.path.join('.') || 'file'} ${i.message}`).join('; ')}`)
  const c = parsed.data
  if (c.before && !inside(c.before)) return fallback('damon-look.json was not used: "before" must be a file inside the project, named by a relative path.')
  if (Object.values(c.schemeScripts ?? {}).some(p => !!p && !inside(p))) return fallback('damon-look.json was not used: a scheme script must be a file inside the project, named by a relative path.')
  if ((c.design ?? []).some(p => !inside(p))) return fallback('damon-look.json was not used: a design document must be a file inside the project, named by a relative path.')
  const scripts = c.schemeScripts ? Object.fromEntries(Object.entries(c.schemeScripts).filter(([, p]) => !!p).map(([k, p]) => [k, p!.replace(/\\/g, '/')])) as Partial<Record<Scheme, string>> : undefined
  const dir = c.direction === undefined ? undefined : directionSchema.safeParse(c.direction)
  const direction: LookDirection | undefined = dir?.success ? { ...dir.data, preserve: dir.data.preserve ?? [], states: dir.data.states ?? [] } : undefined
  const dirProblem = dir && !dir.success ? `damon-look.json: its direction was not used: ${dir.error.issues.map(i => `${['direction', ...i.path].join('.')} ${i.message}`).join('; ')}` : undefined
  return { ...(c.command ? { command: c.command } : {}), places: c.places, ...(c.before ? { before: c.before.replace(/\\/g, '/') } : {}), states: c.states ?? [], schemes: [...new Set(c.schemes ?? DEFAULT.schemes)], ...(scripts && Object.keys(scripts).length ? { schemeScripts: scripts } : {}), ...(c.design?.length ? { design: c.design.map(p => p.replace(/\\/g, '/')) } : {}), ...(direction ? { direction } : {}), ...(dirProblem ? { problem: dirProblem } : {}) }
}

export function errorState(state: string | undefined): boolean {
  return !!state && /(?:^|[-_])(?:error|errors|offline|unreachable|down|fail|failed|failure|fejl|broken)(?:$|[-_])/i.test(state)
}
export function jobWantsErrorState(words: string): boolean {
  return /\b(?:error|offline|unreachable|failure|fejl)[- ](?:state|screen|page|message|view|banner|notice)s?\b/i.test(words ?? '')
}

const SCRIPTS = ['dev', 'start', 'serve', 'preview'] as const

export function lookCommand(pkg: { scripts?: Record<string, string> } | null, config: LookConfig, port: number): string | null {
  if (config.command) return config.command.replace(/\{port\}/g, String(port))
  const name = SCRIPTS.find(s => pkg?.scripts?.[s])
  if (!name) return null
  const script = pkg!.scripts![name]!
  return /\bvite\b/.test(script) && !/\bvite\s+build\b/.test(script) ? `npm run ${name} -- --port ${port} --strictPort --host 127.0.0.1` : `npm run ${name}`
}

export function choosePlaces(config: LookConfig, names?: string[]): { places: LookPlace[]; unknown: string[] } {
  if (!names?.length) return { places: config.places, unknown: [] }
  const wanted = names.map(n => n.trim().toLowerCase())
  return {
    places: config.places.filter(p => wanted.includes(p.name.toLowerCase())),
    unknown: names.filter(n => !config.places.some(p => p.name.toLowerCase() === n.trim().toLowerCase()))
  }
}
