import type { ManagerEvent } from '../../../shared/types'
import type { AgentLaunch, AgentLaunchRequest, ProviderAdapter, ProviderReader } from './types'
import { NdjsonParser, isLimitError, parseResetsAt, shorten, wholeDetail } from '../stream-parser'
import { inSeconds } from './claude'
import { openaiLaunchFor } from '../../../shared/models'
import { quoteCli } from '../manager-session'

/* eslint-disable @typescript-eslint/no-explicit-any */

const KNOWN_SETTINGS: Record<string, readonly string[] | 'any'> = {
  model_reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
}

export function codexMcpArgs(servers: Record<string, unknown> | undefined): string[] {
  const args: string[] = []
  for (const [name, def] of Object.entries(servers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue
    const url = (def as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue
    args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`)
  }
  return args
}

export function codexConfigArgs(settings: Record<string, string>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    const allowed = KNOWN_SETTINGS[key]
    if (allowed === undefined) {
      throw new Error(
        `Damon tried to set an unknown Codex setting "${key}". Codex would have ignored it without saying so. Add it to KNOWN_SETTINGS once you have watched it take effect.`
      )
    }
    if (allowed !== 'any' && !allowed.includes(value)) {
      throw new Error(`Codex setting "${key}" does not take "${value}". It takes: ${allowed.join(', ')}.`)
    }
    args.push('-c', `${key}=${JSON.stringify(value)}`)
  }
  return args
}

function totalTokens(usage: any): number {
  return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
}

function readableCommand(command: string): string {
  const inner = /-Command\s+"?(.*?)"?\s*$/s.exec(command)
  return (inner?.[1] ?? command).replace(/\\+/g, '\\').trim()
}

function summarize(item: any): { summary: string; detail?: string } | null {
  if (item?.type === 'command_execution' && typeof item.command === 'string') {
    const readable = readableCommand(item.command)
    return { summary: `Running: ${shorten(readable)}`, detail: wholeDetail(readable) }
  }
  if (item?.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes.map((c: any) => c?.path).filter((p: unknown): p is string => typeof p === 'string')
    if (paths.length === 0) return { summary: 'Editing files' }
    return {
      summary: paths.length === 1 ? `Editing ${paths[0]}` : `Editing ${paths.length} files`,
      detail: wholeDetail(paths.join('\n'))
    }
  }
  if (item?.type === 'mcp_tool_call') return { summary: `Using ${item.server}: ${item.tool}`, detail: JSON.stringify(item.arguments ?? {}) }
  return null
}

class CodexReader implements ProviderReader {
  private parser = new NdjsonParser()
  private usage: any = null
  private failure: string | null = null
  private sawTurnEnd = false
  private announced = new Set<string>()

  stdout(chunk: string): ManagerEvent[] {
    const out: ManagerEvent[] = []
    for (const raw of this.parser.push(chunk)) {
      const msg = raw as any
      if (!msg || typeof msg !== 'object') continue

      if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
        out.push({ kind: 'session', sessionId: msg.thread_id })
        continue
      }

      if (msg.type === 'item.started' || msg.type === 'item.completed') {
        const item = msg.item
        if (item?.type === 'agent_message') {
          if (msg.type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) {
            out.push({ kind: 'assistant_text', text: item.text })
          }
          continue
        }
        const id = typeof item?.id === 'string' ? item.id : null
        const said = id !== null && this.announced.has(id) ? null : summarize(item)
        if (said) {
          if (id !== null) this.announced.add(id)
          out.push({ kind: 'tool_activity', id: id ?? undefined, tool: String(item.type), ...said })
        }
        if (id !== null && msg.type === 'item.completed') out.push({ kind: 'tool_done', id, ok: item.type === 'command_execution' ? item.exit_code === 0 : item.status === 'completed' && !item.error, outcome: item.aggregated_output?.slice(-2000) ?? (item.error ? JSON.stringify(item.error) : undefined) })
        continue
      }

      if (msg.type === 'turn.completed') {
        this.usage = msg.usage
        this.sawTurnEnd = true
        continue
      }

      if (msg.type === 'turn.failed' || msg.type === 'error') {
        const text = msg.error?.message ?? msg.message
        if (typeof text === 'string' && text) this.failure = text
        if (msg.type === 'turn.failed') this.sawTurnEnd = true
        continue
      }
    }
    return out
  }

  close({ code, stderrTail, report }: { code: number | null; stderrTail: string; report: string }): ManagerEvent[] {
    const out: ManagerEvent[] = []
    if (report.trim()) out.push({ kind: 'assistant_text', text: report })

    const tokens = totalTokens(this.usage)
    const rawTokenUsage = Object.fromEntries(Object.entries(this.usage ?? {}).filter(([key, value]) => key.endsWith('_tokens') && typeof value === 'number' && Number.isFinite(value))) as Record<string, number>
    const tokenUsage = Object.keys(rawTokenUsage).length ? rawTokenUsage : undefined
    const ok = code === 0 && this.failure === null && this.sawTurnEnd
    if (ok) {
      out.push({ kind: 'result', ok: true, costUsd: 0, tokens, tokenUsage })
      return out
    }

    const error =
      this.failure ??
      (/not logged in|auth/i.test(stderrTail)
        ? 'The OpenAI (ChatGPT) account is not signed in. Open Accounts to see the command that signs it in.'
        : stderrTail.trim() || `The GPT agent stopped unexpectedly (code ${String(code)}).`)
    const limited = isLimitError(error)
    out.push({
      kind: 'result',
      ok: false,
      error,
      costUsd: 0,
      tokens,
      tokenUsage,
      limited,
      resetsAt: limited ? inSeconds(parseResetsAt(error)) : undefined
    })
    return out
  }
}

export const codexAdapter: ProviderAdapter = {
  id: 'openai',
  name: 'GPT',
  canLead: true,
  reportsCost: false,
  verified: true,
  reportsMcp: false,
  launch(req: AgentLaunchRequest, reportFile: string): AgentLaunch {
    const permission = req.skipPermissions
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'read-only']
    if (req.sessionId && !/^[a-zA-Z0-9_-]+$/.test(req.sessionId)) throw new Error('Unsafe Codex session id.')
    const chosen = openaiLaunchFor(req.model)
    const effort = chosen.effort ? ['-c', `model_reasoning_effort=${chosen.effort}`] : []
    return {
      command: 'codex',
      args: [
        'exec',
        ...(req.sessionId ? ['resume'] : []),
        '--json',
        '-m',
        chosen.model,
        ...effort,
        ...codexMcpArgs(req.mcpServers),
        ...(req.sessionId && !req.skipPermissions ? ['-c', 'sandbox_mode=read-only'] : permission),
        '--skip-git-repo-check',
        ...(req.sessionId ? [] : ['-C', quoteCli(req.cwd)]),
        '-o',
        quoteCli(reportFile),
        ...(req.sessionId ? [quoteCli(req.sessionId), '-'] : [])
      ],
      reportFile
    }
  },
  reader: () => new CodexReader()
}
