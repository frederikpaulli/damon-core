import type { ManagerEvent } from '../../../shared/types'
import type { AgentLaunch, AgentLaunchRequest, ProviderAdapter, ProviderReader } from './types'
import { isLimitError, parseResetsAt } from '../stream-parser'
import { inSeconds } from './claude'
import { quoteCli } from '../manager-session'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOKEN_PATHS = [
  ['totalTokens'],
  ['total_tokens'],
  ['tokens', 'total'],
  ['tokens', 'totalTokens'],
  ['usage', 'totalTokens'],
  ['usage', 'total_tokens']
]

function tokensFrom(stats: any): number {
  if (!stats || typeof stats !== 'object') return 0
  for (const path of TOKEN_PATHS) {
    let node: any = stats
    for (const key of path) node = node?.[key]
    if (typeof node === 'number' && node > 0) return node
  }
  const prompt = stats.promptTokenCount ?? stats.prompt_tokens ?? stats.inputTokens ?? 0
  const answer = stats.candidatesTokenCount ?? stats.completion_tokens ?? stats.outputTokens ?? 0
  return (typeof prompt === 'number' ? prompt : 0) + (typeof answer === 'number' ? answer : 0)
}

class GeminiReader implements ProviderReader {
  private buffer = ''

  stdout(chunk: string): ManagerEvent[] {
    this.buffer += chunk
    return []
  }

  close({ code, stderrTail }: { code: number | null; stderrTail: string }): ManagerEvent[] {
    const out: ManagerEvent[] = []
    let parsed: any = null
    try {
      parsed = JSON.parse(this.buffer.trim())
    } catch {
    }

    const text = typeof parsed?.response === 'string' ? parsed.response : this.buffer.trim()
    if (text) out.push({ kind: 'assistant_text', text })

    const tokens = tokensFrom(parsed?.stats)
    const failed = code !== 0 || Boolean(parsed?.error)
    if (!failed) {
      out.push({ kind: 'result', ok: true, costUsd: 0, tokens })
      return out
    }

    const reported = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
    const error =
      reported ||
      (/auth|login|credential|sign/i.test(`${stderrTail}${this.buffer}`)
        ? 'The Google (Gemini) account is not signed in. Open Accounts to see how to sign it in.'
        : stderrTail.trim() || `The Gemini agent stopped unexpectedly (code ${String(code)}).`)
    const limited = isLimitError(error)
    out.push({
      kind: 'result',
      ok: false,
      error,
      costUsd: 0,
      tokens,
      limited,
      resetsAt: limited ? inSeconds(parseResetsAt(error)) : undefined
    })
    return out
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  name: 'Gemini',
  canLead: false,
  reportsCost: false,
  verified: false,
  reportsMcp: false,
  launch(req: AgentLaunchRequest): AgentLaunch {
    return {
      command: 'gemini',
      args: [
        '-p',
        quoteCli('Follow the full instructions provided on standard input.'),
        '--output-format',
        'json',
        '--approval-mode',
        'yolo'
      ]
    }
  },
  reader: () => new GeminiReader()
}
