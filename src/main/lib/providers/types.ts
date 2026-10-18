import type { ManagerEvent } from '../../../shared/types'

export interface AgentLaunchRequest {
  cliPath: string
  model: string
  cwd: string
  sessionId?: string
  skipPermissions: boolean
  strictMcpConfig?: boolean
  mcpConfigPath?: string
  mcpServers?: Record<string, unknown>
  mcpToolPrefixes?: string[]
  baseTools?: string[]
  maxTurns?: number
}

export interface AgentLaunch {
  command: string
  args: string[]
  reportFile?: string
}

export interface ProviderReader {
  stdout(chunk: string): ManagerEvent[]
  close(input: { code: number | null; stderrTail: string; report: string }): ManagerEvent[]
}

export interface ProviderAdapter {
  id: 'claude' | 'openai' | 'gemini'
  name: string
  launch(req: AgentLaunchRequest, reportFile: string): AgentLaunch
  reader(): ProviderReader
  canLead: boolean
  reportsCost: boolean
  verified: boolean
  reportsMcp: boolean
}
