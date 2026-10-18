// Provider adapters: one interface over the Claude, Codex and Gemini command-line tools.
import { providerForModel } from '../../../shared/models'
import type { ProviderAdapter } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { geminiAdapter } from './gemini'

export type { AgentLaunch, AgentLaunchRequest, ProviderAdapter, ProviderReader } from './types'

const BY_ID: Record<string, ProviderAdapter> = {
  claude: claudeAdapter,
  openai: codexAdapter,
  gemini: geminiAdapter
}

export function adapterFor(model: string): ProviderAdapter {
  return BY_ID[providerForModel(model)] ?? claudeAdapter
}

export function adapterById(id: string): ProviderAdapter | undefined {
  return BY_ID[id]
}

export const ALL_ADAPTERS: ProviderAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter]
