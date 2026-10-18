import type { ManagerEvent } from '../../../shared/types'
import type { AgentLaunch, AgentLaunchRequest, ProviderAdapter, ProviderReader } from './types'
import { buildManagerArgs, quoteCli } from '../manager-session'
import { NdjsonParser, isLimitError, isLimitNotice, parseResetsAt, toManagerEvents } from '../stream-parser'

export function inSeconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.floor(ms / 1000)
}

class ClaudeReader implements ProviderReader {
  private parser = new NdjsonParser()
  private sawResult = false
  private lastText = ''
  private resetsAt?: number
  private limitStatus?: string

  stdout(chunk: string): ManagerEvent[] {
    const out: ManagerEvent[] = []
    for (const obj of this.parser.push(chunk)) {
      for (const event of toManagerEvents(obj)) {
        if (event.kind === 'assistant_text') this.lastText = event.text
        if (event.kind === 'rate_limit') {
          this.resetsAt = event.resetsAt ?? this.resetsAt
          this.limitStatus = event.status ?? this.limitStatus
          continue
        }
        if (event.kind === 'result') {
          this.sawResult = true
          const noticed = event.ok && isLimitNotice(this.lastText)
          const limited = noticed || isLimitError(event.error) || this.limitStatus === 'rejected'
          const said = noticed ? this.lastText : event.error
          out.push({
            ...event,
            ok: event.ok && !noticed,
            error: said,
            limited,
            resetsAt: limited ? (this.resetsAt ?? inSeconds(parseResetsAt(said))) : undefined
          })
          continue
        }
        out.push(event)
      }
    }
    return out
  }

  close({ code, stderrTail }: { code: number | null; stderrTail: string }): ManagerEvent[] {
    if (this.sawResult) return []
    const noise = this.parser.noise().join('\n').trim()
    const error =
      stderrTail.trim() || noise || `The agent stopped unexpectedly (code ${String(code)}).`
    const limited = isLimitError(error)
    return [
      {
        kind: 'result',
        ok: false,
        error,
        costUsd: 0,
        tokens: 0,
        limited,
        resetsAt: limited ? inSeconds(parseResetsAt(error)) : undefined
      }
    ]
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  name: 'Claude',
  canLead: true,
  reportsCost: true,
  verified: true,
  reportsMcp: true,
  launch(req: AgentLaunchRequest): AgentLaunch {
    return {
      command: quoteCli(req.cliPath),
      args: buildManagerArgs({
        model: req.model,
        sessionId: req.sessionId,
        skipPermissions: req.skipPermissions,
        strictMcpConfig: req.strictMcpConfig,
        mcpConfigPath: req.mcpConfigPath,
        mcpToolPrefixes: req.mcpToolPrefixes,
        baseTools: req.baseTools,
        maxTurns: req.maxTurns
      })
    }
  },
  reader: () => new ClaudeReader()
}
