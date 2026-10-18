const CODE = /\.(rs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|java|kt|kts|cs|swift|vue|svelte|sql|rb|php|c|h|cpp|hpp)$/i

export function isCodeFile(path: string): boolean {
  return CODE.test(path.trim())
}

export function writesCode(writes: string[] | undefined): boolean {
  return (writes ?? []).some(isCodeFile)
}

const SOURCE_ROOT = /^(?:src|lib|apps?|packages|crates|server|client|backend|frontend|src-tauri|tests?)(?:\/|$)/i
const PATHS = /[\w./-]+\.[A-Za-z0-9]+/g
export function codeIntent(task: { writes?: string[]; plan?: string }, changed: readonly string[] = []): boolean {
  if (writesCode(task.writes)) return true
  if ((task.writes ?? []).some((w) => SOURCE_ROOT.test(w.trim().replace(/\\/g, '/').replace(/^\.\//, '')))) return true
  if ((task.plan?.match(PATHS) ?? []).some(isCodeFile)) return true
  return changed.some(isCodeFile)
}

export const REUSE_FIRST = [
  'BEFORE YOU WRITE NEW CODE, go down this list and stop at the first that works:',
  '1. Is it needed for one of the criteria above? If not, leave it out.',
  '2. Does this project already have it? Look in the files you were given and the ones next to them, not the whole repository.',
  '3. Does the language’s standard library or the platform do it?',
  '4. Does a dependency the project already has do it? Never add a new one for this.',
  '5. Only then write the smallest thing that meets the criteria.',
  'This never makes the job smaller. Never drop a behaviour the instructions or criteria ask for, and never cut validation, security, accessibility or a test the criteria want. If you simplified anything, name it in your report on a line starting "Simplified:".'
].join('\n')
