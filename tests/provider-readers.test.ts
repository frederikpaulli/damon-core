import { describe, expect, test } from 'vitest'
import { codexAdapter, codexConfigArgs } from '../src/main/lib/providers/codex'
import { geminiAdapter } from '../src/main/lib/providers/gemini'
import { claudeAdapter } from '../src/main/lib/providers/claude'
import { adapterFor } from '../src/main/lib/providers'

const CODEX_RUN = [
  '{"type":"thread.started","thread_id":"019fb462-00ba-76c1-9323-f8b05f1546bc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will read the seed file first."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\" -Command \\"Get-Content -LiteralPath .\\\\\\\\seed.txt\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"x","aggregated_output":"hello","exit_code":0,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"C:\\\\Users\\\\owner\\\\out.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"C:\\\\Users\\\\owner\\\\out.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Finished."}}',
  '{"type":"turn.completed","usage":{"input_tokens":46345,"cached_input_tokens":41216,"cache_write_input_tokens":0,"output_tokens":160,"reasoning_output_tokens":0}}'
].join('\n')

describe('reading a GPT run', () => {
  test('completion-only tools report inspection before its successful result', () => {
    const events = codexAdapter.reader().stdout(JSON.stringify({ type: 'item.completed', item: { id: 'only', type: 'command_execution', command: 'node check.cjs', exit_code: 0, status: 'completed', aggregated_output: 'passed' } }) + '\n')
    expect(events.map(e => e.kind)).toEqual(['tool_activity', 'tool_done'])
    expect(events[1]).toMatchObject({ id: 'only', ok: true })
  })
  test('a real run gives a session, its tools and its usage', () => {
    const reader = codexAdapter.reader()
    const events = reader.stdout(CODEX_RUN + '\n')

    expect(events.find((e) => e.kind === 'session')).toEqual({
      kind: 'session',
      sessionId: '019fb462-00ba-76c1-9323-f8b05f1546bc'
    })

    const tools = events.filter((e) => e.kind === 'tool_activity')
    expect(tools).toHaveLength(2)
    expect(tools[0]!.summary).toContain('Get-Content')
    expect(tools[1]!.summary).toBe('Editing C:\\Users\\owner\\out.txt')

    const done = reader.close({ code: 0, stderrTail: '', report: 'Finished.' })
    const result = done.find((e) => e.kind === 'result')!
    expect(result.ok).toBe(true)
    expect(result.tokens).toBe(46505)
  })

  test('a run always ends with exactly one result, so it cannot go uncounted', () => {
    for (const [code, tail] of [
      [0, ''],
      [1, 'something broke']
    ] as const) {
      const reader = codexAdapter.reader()
      reader.stdout('{"type":"thread.started","thread_id":"t"}\n')
      const results = reader.close({ code, stderrTail: tail, report: '' }).filter((e) => e.kind === 'result')
      expect(results).toHaveLength(1)
    }
  })

  test('a turn that never completed is a failure even when the exit code is zero', () => {
    const reader = codexAdapter.reader()
    reader.stdout('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n')
    const result = reader.close({ code: 0, stderrTail: '', report: '' }).find((e) => e.kind === 'result')!
    expect(result.ok).toBe(false)
  })

  test('the error Codex reports is preferred over whatever was on stderr', () => {
    const reader = codexAdapter.reader()
    reader.stdout('{"type":"turn.failed","error":{"message":"usage limit reached, resets at 3am"}}\n')
    const result = reader.close({ code: 1, stderrTail: 'noise', report: '' }).find((e) => e.kind === 'result')!
    expect(result.error).toContain('usage limit')
    expect(result.limited).toBe(true)
    expect(result.resetsAt).toBeGreaterThan(1_700_000_000)
    expect(result.resetsAt).toBeLessThan(100_000_000_000)
  })

  test('the report file is handed back as the agent text', () => {
    const reader = codexAdapter.reader()
    const events = reader.close({ code: 0, stderrTail: '', report: 'The work is done.' })
    expect(events.find((e) => e.kind === 'assistant_text')?.text).toBe('The work is done.')
  })

  test('a split JSON line is still read once it arrives in full', () => {
    const reader = codexAdapter.reader()
    const line = '{"type":"thread.started","thread_id":"split-me"}\n'
    expect(reader.stdout(line.slice(0, 20))).toHaveLength(0)
    const events = reader.stdout(line.slice(20))
    expect(events[0]).toEqual({ kind: 'session', sessionId: 'split-me' })
  })
})

describe('settings Damon sends to a provider', () => {
  test('a known setting is passed through, quoted so the shell cannot touch it', () => {
    expect(codexConfigArgs({ model_reasoning_effort: 'high' })).toEqual(['-c', 'model_reasoning_effort="high"'])
  })

  test('a key Damon has never watched take effect is refused rather than sent', () => {
    expect(() => codexConfigArgs({ model_reasonning_effort: 'high' })).toThrow(/unknown Codex setting/i)
    expect(() => codexConfigArgs({ model_reasonning_effort: 'high' })).toThrow(/ignored it without saying so/i)
  })

  test('the values are the seven Codex actually accepts', () => {
    for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(() => codexConfigArgs({ model_reasoning_effort: level })).not.toThrow()
    }
    expect(() => codexConfigArgs({ model_reasoning_effort: 'banana' })).toThrow(/takes: none, minimal/i)
  })
})

describe('reading a Gemini run', () => {
  test('the documented shape gives back the answer and its tokens', () => {
    const reader = geminiAdapter.reader()
    reader.stdout('{"response":"All done.","stats":{"totalTokens":1234}}')
    const events = reader.close({ code: 0, stderrTail: '', report: '' })
    expect(events.find((e) => e.kind === 'assistant_text')?.text).toBe('All done.')
    const result = events.find((e) => e.kind === 'result')!
    expect(result.ok).toBe(true)
    expect(result.tokens).toBe(1234)
  })

  test('output that is not JSON is still handed back rather than lost', () => {
    const reader = geminiAdapter.reader()
    reader.stdout('just some plain text')
    const events = reader.close({ code: 0, stderrTail: '', report: '' })
    expect(events.find((e) => e.kind === 'assistant_text')?.text).toBe('just some plain text')
  })

  test('a run with no token count still produces a result', () => {
    const reader = geminiAdapter.reader()
    reader.stdout('{"response":"done","stats":{"somethingElse":9}}')
    const result = reader.close({ code: 0, stderrTail: '', report: '' }).find((e) => e.kind === 'result')!
    expect(result.ok).toBe(true)
    expect(result.tokens).toBe(0)
  })

  test('the error Gemini reports in its own output is used', () => {
    const reader = geminiAdapter.reader()
    reader.stdout('{"session_id":"s","error":{"type":"Error","message":"Please set an Auth method","code":41}}')
    const result = reader.close({ code: 41, stderrTail: '', report: '' }).find((e) => e.kind === 'result')!
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Auth')
  })
})

describe('picking a provider', () => {
  test('a brain reaches the CLI that can actually run it', () => {
    expect(adapterFor('claude-sonnet-5').id).toBe('claude')
    expect(adapterFor('openai-gpt').id).toBe('openai')
    expect(adapterFor('gemini').id).toBe('gemini')
  })

  test('Claude and GPT can lead, while only Claude reports money', () => {
    expect(claudeAdapter.canLead).toBe(true)
    expect(codexAdapter.canLead).toBe(true)
    expect(geminiAdapter.canLead).toBe(false)
    expect(claudeAdapter.reportsCost).toBe(true)
    expect(codexAdapter.reportsCost).toBe(false)
    expect(geminiAdapter.reportsCost).toBe(false)
  })

  test('Gemini is marked unverified, because it could not be signed in to test', () => {
    expect(geminiAdapter.verified).toBe(false)
    expect(claudeAdapter.verified).toBe(true)
    expect(codexAdapter.verified).toBe(true)
  })

  test('GPT is started in the mode that actually reports what it did', () => {
    const spec = codexAdapter.launch(
      { cliPath: 'codex', model: 'openai-gpt', cwd: '/w', skipPermissions: true },
      '/tmp/r.txt'
    )
    expect(spec.args).toContain('--json')
    expect(spec.args).toContain('/tmp/r.txt')
  })

  test('a GPT agent can only change files when the owner turned full access on', () => {
    const open = codexAdapter.launch(
      { cliPath: 'codex', model: 'openai-gpt', cwd: '/w', skipPermissions: true },
      '/tmp/r.txt'
    )
    expect(open.args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(open.args).not.toContain('workspace-write')

    const shut = codexAdapter.launch(
      { cliPath: 'codex', model: 'openai-gpt', cwd: '/w', skipPermissions: false },
      '/tmp/r.txt'
    )
    expect(shut.args.join(' ')).toContain('--sandbox read-only')
    expect(shut.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(shut.args).not.toContain('workspace-write')
  })

  test('Gemini is started in the mode that reports, not plain text', () => {
    const spec = geminiAdapter.launch(
      { cliPath: 'gemini', model: 'gemini', cwd: '/w', skipPermissions: true },
      '/tmp/r.txt'
    )
    expect(spec.args.join(' ')).toContain('--output-format json')
  })
})
