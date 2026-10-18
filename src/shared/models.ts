export interface ManagerModel {
  id: string
  label: string
  hint: string
  provider?: 'claude' | 'openai' | 'gemini'
  legacy?: boolean
}

export const MANAGER_MODELS: ManagerModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Recommended: the best value for almost everything', provider: 'claude' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'The strongest there is, uses credits fastest', provider: 'claude' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Nearly Opus 5.5 at half the price', provider: 'claude' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Quickest and cheapest', provider: 'claude' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Previous Sonnet', provider: 'claude', legacy: true },
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'Previous Opus', provider: 'claude', legacy: true },
  { id: 'claude-fable-5', label: 'Fable 5', hint: 'Previous Fable', provider: 'claude', legacy: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'Older Opus', provider: 'claude', legacy: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Previous Haiku', provider: 'claude', legacy: true }
]

export const OPENAI_AGENT_MODELS: ManagerModel[] = [
  {
    id: 'openai-gpt-5.5',
    label: 'GPT-5.5',
    hint: 'Runs on your ChatGPT sign-in.',
    provider: 'openai'
  },
  { id: 'openai-gpt-5.5-low', label: 'GPT-5.5 quick', hint: 'Answers fast without stopping to think.', provider: 'openai', legacy: true },
  { id: 'openai-gpt-5.5-high', label: 'GPT-5.5 deep', hint: 'Thinks harder before answering.', provider: 'openai', legacy: true }
]

const OPENAI_LAUNCH: Record<string, { model: string; effort?: 'low' | 'medium' | 'high' }> = {
  'openai-gpt': { model: 'gpt-5.5' },
  'openai-gpt-5.5-low': { model: 'gpt-5.5', effort: 'low' },
  'openai-gpt-5.5': { model: 'gpt-5.5', effort: 'medium' },
  'openai-gpt-5.5-high': { model: 'gpt-5.5', effort: 'high' }
}

export function addOpenAiBrains(brains: {
  models: ManagerModel[]
  launch: Record<string, { model: string; effort?: 'low' | 'medium' | 'high' }>
}): void {
  for (const m of brains.models) {
    if (AGENT_MODELS.some((k) => k.id === m.id)) continue
    const entry: ManagerModel = { ...m, provider: 'openai' }
    OPENAI_AGENT_MODELS.push(entry)
    AGENT_MODELS.push(entry)
    KNOWN_BRAINS.push(entry)
  }
  for (const [id, launch] of Object.entries(brains.launch)) {
    if (!(id in OPENAI_LAUNCH)) OPENAI_LAUNCH[id] = launch
  }
}

export function openaiLaunchFor(id: string): { model: string; effort?: 'low' | 'medium' | 'high' } {
  return OPENAI_LAUNCH[id] ?? { model: 'gpt-5.5' }
}

export const GEMINI_AGENT_MODELS: ManagerModel[] = [
  { id: 'gemini', label: 'Gemini (Google)', hint: 'Runs on your Google sign-in', provider: 'gemini' }
]

export const AGENT_MODELS: ManagerModel[] = [...MANAGER_MODELS, ...OPENAI_AGENT_MODELS, ...GEMINI_AGENT_MODELS]

export function brainShort(id: string): string {
  return brainWords(id)
    .replace(/^the /, '')
    .replace(/^a /, '')
    .replace("another provider's brain", 'other brain')
}

export function costShort(id: string): string {
  if (id.startsWith('openai') || id.startsWith('gpt') || id === 'gemini') return 'your sign-in'
  if (id.includes('fable')) return 'costs most'
  if (id.includes('opus')) return 'good value'
  if (id.includes('sonnet')) return 'mid cost'
  if (id.includes('haiku')) return 'costs least'
  return ''
}

export function choiceText(m: { id: string; label: string }): string {
  const cost = costShort(m.id)
  return cost ? `${m.label} · ${cost}` : m.label
}

export function brainWords(id: string): string {
  if (id.startsWith('openai') || id.startsWith('gpt')) return "another provider's brain"
  if (id === 'gemini') return "another provider's brain"
  if (id.includes('fable')) return 'the strongest brain'
  if (id.includes('opus')) return 'a strong brain'
  if (id.includes('sonnet')) return 'a mid brain'
  if (id.includes('haiku')) return 'the quickest brain'
  return 'a brain'
}

export type Seat = 'manager' | 'lead' | 'agent'

const SAFE_LEAD = 'claude-sonnet-5-5'

export function brainsFor(seat: Seat): ManagerModel[] {
  return runnableFor(seat).filter((m) => !m.legacy)
}
function runnableFor(seat: Seat): ManagerModel[] {
  const seated = seat === 'agent' ? AGENT_MODELS : [...MANAGER_MODELS, ...OPENAI_AGENT_MODELS]
  return seated.filter((m) => isReady(m.id))
}
export function offeredBrains(seat: Seat, current?: string): ManagerModel[] {
  const offered = brainsFor(seat)
  if (current && !offered.some((m) => m.id === current)) {
    const known = KNOWN_BRAINS.find((m) => m.id === current)
    if (known) return [...offered, known]
  }
  return offered
}

export const RETIRED_MODELS: ManagerModel[] = [
  { id: 'openai-gpt', label: 'GPT (ChatGPT)', hint: 'An older way of naming GPT', provider: 'openai' }
]

const RETIRED_BUT_RUNNABLE: Record<Seat, string[]> = {
  agent: RETIRED_MODELS.map((m) => m.id),
  lead: [],
  manager: []
}

const KNOWN_BRAINS: ManagerModel[] = [...AGENT_MODELS, ...RETIRED_MODELS]

const READY_PROVIDERS: Record<string, boolean> = {
  claude: true,
  openai: true,
  gemini: false,
  kimi: false
}

export function isReady(model: string): boolean {
  return READY_PROVIDERS[providerForModel(model)] === true
}

export function providerIsReady(providerId: string): boolean {
  return READY_PROVIDERS[providerId] === true
}

export function canRun(seat: Seat, model: string): boolean {
  if (RETIRED_BUT_RUNNABLE[seat].includes(model) && isReady(model)) return true
  return runnableFor(seat).some((m) => m.id === model)
}

export function whyNot(seat: Seat, model: string): string {
  if (canRun(seat, model)) return ''
  const known = KNOWN_BRAINS.find((m) => m.id === model)
  if (!known) return `Damon has no brain called "${model}".`
  if (!isReady(model)) {
    return `${known.label} is not available. Google stopped letting personal accounts use the Gemini tool in June 2026, so it cannot run work for you even when you are signed in. A paid Gemini key would bring it back.`
  }
  if (seat === 'manager') {
    return `${known.label} cannot run Damon itself. Pick an available Claude or GPT brain for this role.`
  }
  return `${known.label} can do the work itself, but it cannot lead a group yet. Pick an available Claude or GPT brain for this role.`
}

export function runnableBrain(seat: Seat, wanted: string, fallback: string): string {
  if (canRun(seat, wanted)) return wanted
  if (canRun(seat, fallback)) return fallback
  return SAFE_LEAD
}

export function providerForModel(id: string): 'claude' | 'openai' | 'gemini' {
  if (id.startsWith('gemini')) return 'gemini'
  if (id.startsWith('openai') || id.startsWith('gpt')) return 'openai'
  return 'claude'
}

export const BRAIN_RANK: Record<string, number> = {
  'claude-haiku-4-5-20251001': 1,
  'claude-haiku-5-5': 1,
  'claude-sonnet-5': 2,
  'claude-sonnet-5-5': 2,
  'claude-opus-4-8': 3,
  'claude-opus-5': 4,
  'claude-opus-5-5': 4,
  'claude-fable-5': 5,
  'claude-fable-5-1': 6
}

export function clampBrain(wanted: string, ceiling: string): string {
  if (!ceiling) return wanted
  if (providerForModel(wanted) !== 'claude') return wanted
  const want = BRAIN_RANK[wanted]
  const cap = BRAIN_RANK[ceiling]
  if (!want || !cap) return wanted
  return want > cap ? currentBrain(ceiling) : wanted
}

const SUCCESSOR: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-opus-4-8': 'claude-opus-5-5',
  'claude-fable-5': 'claude-fable-5-1',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-5-5'
}
export function currentBrain(id: string): string {
  return SUCCESSOR[id] ?? id
}

export function routineBrain(ownerBrain: string): string {
  if (providerForModel(ownerBrain) !== 'claude') return ownerBrain
  const rank = BRAIN_RANK[ownerBrain]
  if (!rank) return ownerBrain
  if (rank <= BRAIN_RANK['claude-sonnet-5']!) return ownerBrain
  return 'claude-sonnet-5-5'
}
