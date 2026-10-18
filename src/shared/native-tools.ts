export const NATIVE_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const

export function nativeToolsFor(capabilities: readonly string[]): string[] {
  return capabilities.includes('web.read') ? [...NATIVE_WEB_TOOLS] : []
}

export const COPY_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'TodoWrite'] as const
export function copyToolsFor(capabilities: readonly string[]): string[] {
  return capabilities.includes('worker.copy') ? [...COPY_TOOLS, ...nativeToolsFor(capabilities)] : nativeToolsFor(capabilities)
}

export const PROGRAM_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Glob', 'Grep', 'LS', 'Read', 'Edit', 'MultiEdit', 'Write',
  'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'ExitPlanMode', 'EnterPlanMode',
  'SlashCommand', 'Skill', 'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Monitor', 'ToolSearch'
])
