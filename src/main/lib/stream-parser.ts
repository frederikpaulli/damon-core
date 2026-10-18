import { createHash } from 'node:crypto'
import type { ManagerEvent } from '../../shared/types'
import { isShellTool, proofLines, redirectTargets } from '../../shared/check-receipt'

const started = new Map<string, { tool: string; path?: string }>()
const written = new Set<string>()
const remember = <K, V>(map: Map<K, V> | Set<K>, key: K, value?: V): void => {
  if (map instanceof Map) map.set(key, value as V); else map.add(key)
  if (map.size > 2000) { const first = map.keys().next().value as K; map.delete(first) }
}
const LOG_FILE = /\.(?:log|txt|out)$/i
function proofAllowed(id: string): boolean {
  const step = started.get(id)
  if (!step) return false
  if (isShellTool(step.tool)) return true
  if (step.tool !== 'Read' || !step.path) return false
  const name = step.path.replace(/\\/g, '/').split('/').pop()!.toLowerCase()
  return LOG_FILE.test(name) || written.has(name)
}
const textOfContent = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: { text?: unknown }) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : ''

export class NdjsonParser {
  private buffer = ''
  private lastNoise: string[] = []

  push(chunk: string): unknown[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    const parsed: unknown[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        parsed.push(JSON.parse(trimmed))
      } catch {
        this.lastNoise.push(trimmed.slice(0, 300))
        if (this.lastNoise.length > 5) this.lastNoise.shift()
      }
    }
    return parsed
  }

  noise(): string[] {
    return [...this.lastNoise]
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toManagerEvents(raw: unknown): ManagerEvent[] {
  const msg = raw as any
  if (!msg || typeof msg !== 'object') return []

  if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
    const servers = Array.isArray(msg.mcp_servers)
      ? msg.mcp_servers
          .filter((s: any) => s && typeof s.name === 'string')
          .map((s: any) => ({ name: s.name, status: typeof s.status === 'string' ? s.status : undefined }))
      : undefined
    return [{ kind: 'session', sessionId: msg.session_id, mcpServers: servers }]
  }

  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const events: ManagerEvent[] = []
    const u = msg.message.usage
    if (u && typeof u === 'object') {
      const usage = usageTokens(u)
      if (Object.keys(usage).length) events.push({ kind: 'step_usage', usage, ...(typeof msg.message.id === 'string' ? { messageId: msg.message.id } : {}) })
    }
    for (const block of msg.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'assistant_text', text: block.text })
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input ?? {}
        if (typeof block.id === 'string') remember(started, block.id, { tool: block.name, ...(typeof input.file_path === 'string' ? { path: input.file_path } : typeof input.path === 'string' ? { path: input.path } : {}) })
        if (isShellTool(block.name) && typeof input.command === 'string') for (const f of redirectTargets(input.command)) remember(written, f)
        events.push({
          kind: 'tool_activity',
          tool: block.name,
          ...summarizeToolUse(block.name, block.input),
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
          ...(isShellTool(block.name) && input.run_in_background === true ? { background: true } : {})
        })
      }
    }
    return events
  }

  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    const events: ManagerEvent[] = []
    for (const block of msg.message.content) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const failed = block.is_error === true
      const why = failed ? firstLineOf(block.content) : ''
      const text = textOfContent(block.content)
      const proof = proofAllowed(block.tool_use_id) ? proofLines(text) : []
      const background = started.has(block.tool_use_id) && isShellTool(started.get(block.tool_use_id)!.tool) && /Command running in background with ID/i.test(text)
      started.delete(block.tool_use_id)
      events.push({
        kind: 'tool_done',
        id: block.tool_use_id,
        ok: !failed,
        ...(why ? { outcome: why } : {}),
        ...(proof.length ? { proof } : {}),
        ...(background ? { background: true } : {})
      })
    }
    return events
  }

  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info ?? {}
    return [
      {
        kind: 'rate_limit',
        status: info.status,
        resetsAt: info.resetsAt,
        utilization: info.utilization,
        rateLimitType: info.rateLimitType,
        isUsingOverage: info.isUsingOverage
      }
    ]
  }

  if (msg.type === 'stream_event') {
    const delta = msg.event?.type === 'content_block_delta' ? msg.event.delta : null
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ kind: 'assistant_delta', text: delta.text }]
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [{ kind: 'thinking', text: delta.thinking }]
    }
    return []
  }

  if (msg.type === 'result') {
    const u = msg.usage ?? {}
    const rawTokenUsage = usageTokens(u)
    const tokenUsage = Object.keys(rawTokenUsage).length ? rawTokenUsage : undefined
    const tokens =
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
    const costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0
    const steps = typeof msg.num_turns === 'number' ? msg.num_turns : undefined
    if (msg.subtype === 'success' && msg.is_error !== true) return [{ kind: 'result', ok: true, costUsd, tokens, steps, tokenUsage }]
    const errs = Array.isArray(msg.errors)
      ? (msg.errors as unknown[]).filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : []
    const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials.length : 0
    const said = [typeof msg.result === 'string' && msg.result ? msg.result : '', ...errs].filter(Boolean).join('\n')
    const error =
      said ||
      `${String(msg.subtype ?? 'unknown error')}${denials ? ` (${denials} tool call${denials === 1 ? ' was' : 's were'} refused permission)` : ''}`
    if (msg.subtype === 'error_max_turns' || msg.subtype === 'error_max_budget_usd') {
      return [{ kind: 'result', ok: false, error, costUsd, tokens, steps, tokenUsage, outOfSteps: true }]
    }
    return [{ kind: 'result', ok: false, error, costUsd, tokens, steps, tokenUsage }]
  }

  return []
}

export function isLimitError(text: string | undefined): boolean {
  if (!text) return false
  return /usage limit|session limit|rate[ _]?limit|limit reached|reached your (usage|limit)|limit will reset|resets? at|weekly limit|hour limit|out of credits|usage credits|insufficient[ _]quota|resource[ _]exhausted|quota|too many requests|429|overage/i.test(
    text
  )
}

const NOTICE_MAX_CHARS = 240

export function isLimitNotice(text: string | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (!t || t.length > NOTICE_MAX_CHARS) return false
  return /\b(usage|session|weekly|daily|hourly|5-hour|five-hour|token) limit\b|\blimit reached\b|\bout of (usage )?credits\b/i.test(
    t
  )
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

export function parseResetsAt(text: string | undefined, now: number = Date.now()): number | undefined {
  if (!text) return undefined
  const stamp = text.match(/resets?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i)
  if (stamp) {
    const t = Date.parse(stamp[1]!)
    if (!Number.isNaN(t)) return t
  }
  const at = new Date(now)
  const dated = text.match(
    /resets?(?:\s+(?:at|on))?\s+([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
  )
  const month = dated ? MONTHS[dated[1]!.slice(0, 3).toLowerCase()] : undefined
  if (dated && month !== undefined) {
    const day = Number(dated[2])
    if (day < 1 || day > 31) return undefined
    const time = dated[3] ? clockOf(dated[3], dated[4], dated[5]) : { hour: 0, minute: 0 }
    if (!time) return undefined
    at.setMonth(month, day)
    at.setHours(time.hour, time.minute, 0, 0)
    if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1)
    return at.getTime()
  }
  const clock = text.match(/resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!clock) return undefined
  const time = clockOf(clock[1]!, clock[2], clock[3])
  if (!time) return undefined
  at.setHours(time.hour, time.minute, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function clockOf(h: string, m: string | undefined, ampm: string | undefined): { hour: number; minute: number } | undefined {
  let hour = Number(h)
  const minute = m ? Number(m) : 0
  const half = ampm?.toLowerCase()
  if (half === 'pm' && hour < 12) hour += 12
  if (half === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

const DETAIL_MAX = 4000

export function shorten(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export function wholeDetail(text: string): string {
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + `… [cut here, ${text.length} characters in all]` : text
}

const DAMON_TOOL_WORDS: Record<string, string> = {
  propose_team: 'Working out who this job needs, to put in front of you',
  create_agent: 'Taking someone on',
  create_submanager: 'Appointing someone to lead a group',
  delete_agent: 'Letting someone go',
  find_automation: 'Looking for an automation somebody has already built',
  read_automation: 'Reading how somebody built that automation',
  assign_task: 'Handing a job to someone',
  assign_milestone: 'Handing out a whole run of work at once',
  assign_swarm: 'Handing the same job to several people at once',
  get_task: 'Checking how a job is going',
  list_tasks: 'Looking over the jobs on this project',
  list_agents: 'Looking over who is on the team',
  request_revision: 'Sending work back to be fixed',
  approve_task: 'Signing off finished work',
  read_brain: 'Reading what this project already knows',
  write_brain: 'Writing down something worth remembering',
  read_user_profile: 'Reading what it knows about you',
  remember_about_owner: 'Making a note about how you like things done',
  need_connection: 'Flagging something it cannot reach',
  hold_work: 'Stopping the work',
  add_automation: 'Setting up something to happen regularly',
  list_automations: 'Checking what already happens on a clock',
  complete_assignment: 'Reporting its part finished',
  escalate_to_owner: 'Raising something only you can decide',
  add_note: 'Leaving a note for whoever picks this up next',
  look_at_my_work: 'Looking at its own work on the screen',
  Glob: 'Looking for files',
  Grep: 'Searching through the files',
  LS: 'Listing a folder',
  ToolSearch: 'Looking up a tool',
  TodoWrite: 'Updating its to-do list',
  Task: 'Handing part of the job to a helper',
  MultiEdit: 'Editing several places in a file',
  NotebookEdit: 'Editing a notebook',
  BashOutput: 'Reading what a command printed',
  KillBash: 'Stopping a command',
  AskUserQuestion: 'Asking a question',
  browser_snapshot: 'Reading the page in the browser',
  browser_take_screenshot: 'Taking a picture of the browser',
  browser_click: 'Clicking in the browser',
  browser_type: 'Typing in the browser',
  browser_fill_form: 'Filling in a form in the browser',
  browser_press_key: 'Pressing a key in the browser',
  browser_evaluate: 'Running a check in the browser',
  browser_run_code_unsafe: 'Running code in the browser',
  browser_tabs: 'Looking at the browser tabs',
  browser_wait_for: 'Waiting for the page to settle',
  browser_resize: 'Resizing the browser window',
  browser_close: 'Closing its browser tab',
  browser_navigate_back: 'Going back a page in the browser',
  browser_console_messages: "Reading the browser's messages",
  browser_network_requests: 'Reading what the page fetched',
  browser_handle_dialog: 'Answering a pop-up in the browser',
  browser_hover: 'Hovering in the browser',
  browser_select_option: 'Choosing an option in the browser',
  browser_drag: 'Dragging in the browser',
  browser_find: 'Finding something on the page',
  browser_file_upload: 'Uploading a file in the browser'
}

export function plainToolWords(name: string): string | null {
  const bare = name.replace(/^mcp__[a-z0-9_-]*?__/i, '')
  return DAMON_TOOL_WORDS[bare] ?? null
}

const FAILURE_MAX_CHARS = 160

export function firstLineOf(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b: any) => (b && typeof b.text === 'string' ? b.text : ''))
            .join('\n')
        : ''
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > FAILURE_MAX_CHARS ? line.slice(0, FAILURE_MAX_CHARS - 1) + '…' : line
}

const FINGERPRINT_MAX_CHARS = 400

export function inputFingerprint(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, FINGERPRINT_MAX_CHARS) : ''
  const keys = Object.keys(input as Record<string, unknown>).sort()
  if (keys.length === 0) return ''
  const text = JSON.stringify(input, keys)
  return text.length > FINGERPRINT_MAX_CHARS ? text.slice(0, FINGERPRINT_MAX_CHARS - 1) + '…' : text
}

export function summarizeToolUse(name: string, input: any): { summary: string; detail?: string; step?: string } {
  const path = input?.file_path ?? input?.path ?? input?.notebook_path
  if (name === 'Read' && path) return { summary: `Reading ${path}`, detail: String(path) }
  if ((name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') && path) {
    return { summary: `Editing ${path}`, detail: String(path), step: `${path} ${createHash('sha1').update(JSON.stringify(input, Object.keys(input).sort())).digest('hex')}` }
  }
  const plain = plainToolWords(name)
  if (plain) {
    const fingerprint = inputFingerprint(input)
    return { summary: plain, detail: fingerprint ? `${name} ${fingerprint}` : name }
  }
  if (name === 'WebSearch' && typeof input?.query === 'string' && input.query.trim()) {
    return { summary: `Searching the web for: ${shorten(input.query)}`, detail: wholeDetail(input.query) }
  }
  if (name === 'WebFetch' && typeof input?.url === 'string' && input.url.trim()) {
    return { summary: `Reading ${shorten(input.url)}`, detail: wholeDetail(input.url) }
  }
  if (/browser_navigate$/.test(name) && typeof input?.url === 'string' && input.url.trim()) {
    return { summary: `Opening ${shorten(input.url)} in the browser`, detail: wholeDetail(input.url) }
  }
  if (name === 'Bash' && typeof input?.command === 'string') {
    return { summary: `Running: ${shorten(input.command)}`, detail: wholeDetail(input.command) }
  }
  if (name === 'Skill' && typeof input?.skill === 'string' && input.skill.trim()) {
    return { summary: `Using the ${input.skill.trim()} skill`, detail: String(input.skill).trim() }
  }
  if (typeof input?.command === 'string' && input.command.trim()) {
    return { summary: `Running: ${shorten(input.command)}`, detail: wholeDetail(input.command) }
  }
  const fingerprint = inputFingerprint(input)
  return fingerprint ? { summary: `Using ${name}`, detail: `${name} ${fingerprint}` } : { summary: `Using ${name}` }
}

export function usageTokens(u: Record<string, unknown>): Record<string, number> {
  const out = Object.fromEntries(Object.entries(u).filter(([key, value]) => key.endsWith('_tokens') && typeof value === 'number' && Number.isFinite(value))) as Record<string, number>
  const split = u.cache_creation
  if (split && typeof split === 'object') {
    const five = (split as Record<string, unknown>).ephemeral_5m_input_tokens
    const hour = (split as Record<string, unknown>).ephemeral_1h_input_tokens
    if (Number.isSafeInteger(five)) out.cache_creation_5m_input_tokens = five as number
    if (Number.isSafeInteger(hour)) out.cache_creation_1h_input_tokens = hour as number
  }
  return out
}
