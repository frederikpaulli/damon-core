// Which folder and files a project's agents may read, with hashes, so a job reads the
// version the owner approved.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { defaultCapabilities, executionPolicyInput, executionPolicyRecord, MAX_INPUT_FILE_BYTES, MAX_INPUT_TOTAL_BYTES, type ExecutionPolicyInput, type ExecutionPolicyRecord } from '../../shared/execution-policy'
import { resolveInside } from './file-browser'
import { readJson, writeJson } from './json-file'
import { workerPath } from './isolated-worker'
import { requireReviewedText } from './protected-context'
import { isRenderedView, viewNotAnInput } from '../../shared/rendered-views'

const overlaps = (a: string, b: string): boolean => {
  const below = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')) }
  return below(a, b) || below(b, a)
}
export const PROVIDER_NOT_ALLOWED = 'This project’s execution permissions do not include'
const ROOT_CHECK_MS = 10_000
const rootChecks = new Map<string, { at: number; root: string }>()
export function assertExecutionRoot(projectRoot: string, protectedRoots: string[]): string {
  const key = `${projectRoot}\n${protectedRoots.join('\n')}`
  const known = rootChecks.get(key)
  if (known && Date.now() - known.at < ROOT_CHECK_MS) return known.root
  const root = checkExecutionRoot(projectRoot, protectedRoots)
  rootChecks.set(key, { at: Date.now(), root })
  return root
}
function checkExecutionRoot(projectRoot: string, protectedRoots: string[]): string {
  if (!isAbsolute(projectRoot)) throw Error('Protected work needs an absolute project folder.')
  const root = realpathSync(projectRoot)
  if (!lstatSync(root).isDirectory()) throw Error('Protected work needs a project directory.')
  for (const location of protectedRoots.filter(Boolean)) {
    if (!isAbsolute(location)) throw Error('A protected folder identity needs review.')
    if (overlaps(resolve(projectRoot), resolve(location)) || overlaps(root, existsSync(location) ? realpathSync(location) : resolve(location))) throw Error('This project overlaps another project or Damon private storage. Use a separate project folder.')
  }
  return root
}
function validateInputs(inputs: ExecutionPolicyRecord['inputs']): void {
  if (new Set(inputs.map(file => file.path.toLowerCase())).size !== inputs.length) throw Error('Input paths must be unique.')
  for (const file of inputs) {
    workerPath(file.path)
    if (file.path.split('/').some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error('Input paths cannot use Windows device names or ambiguous trailing characters.')
    if (file.path.split('/').some(part => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.codex|\.claude|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))) throw Error('Credential and private configuration paths cannot be model inputs.')
  }
}
export const NOT_THE_PROJECT = /^(?:node_modules|target|\.git|dist|build|out|release|\.next|\.venv|venv|__pycache__|\.turbo|\.cache)$/i
export function plainPolicyError(e: unknown): string {
  const issues = (e as { issues?: { code?: string; path?: unknown[]; maximum?: number | bigint }[] } | null)?.issues
  if (Array.isArray(issues)) {
    const full = issues.find(i => i.code === 'too_big' && i.path?.[0] === 'inputs')
    return full ? `the project's list of approved files is full (${String(full.maximum)} files); old ones can be removed on the Execution permissions screen` : 'the permissions would not have been valid, so nothing was changed'
  }
  return e instanceof Error ? e.message : String(e)
}
export function keepPolicyHistory<T extends { inputs: { path: string }[] }>(entries: T[], budget = 8 * 1024 * 1024): T[] {
  let kept = entries.slice(-200)
  const sizeOf = (h: T[]): number => h.reduce((n, e) => n + 400 + e.inputs.reduce((m, i) => m + i.path.length + 90, 0), 0)
  while (kept.length > 20 && sizeOf(kept) > budget) kept = kept.slice(Math.max(1, Math.floor(kept.length / 10)))
  return kept
}
const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>()
const currentSha256 = (target: string): string => {
  const st = lstatSync(target), known = hashes.get(target)
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.sha256
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  hashes.set(target, { size: st.size, mtimeMs: st.mtimeMs, sha256 })
  return sha256
}
const normal = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '')
export function inFolderGrant(policy: Pick<ExecutionPolicyRecord, 'folder' | 'excluded' | 'projectRoot'>, path: string): boolean {
  if (!policy.folder) return false
  const p = normal(path)
  if (!p || p.split('/').some(part => NOT_THE_PROJECT.test(part))) return false
  const lower = p.toLowerCase()
  if ((policy.excluded ?? []).some(x => { const e = normal(x).replace(/\/+$/, '').toLowerCase(); return lower === e || lower.startsWith(e + '/') })) return false
  try { validateInputs([{ path: p, sha256: '0'.repeat(64) }]) } catch { return false }
  const target = resolveInside(policy.projectRoot, p)
  try { return !!target && lstatSync(target).isFile() && lstatSync(target).size <= MAX_INPUT_FILE_BYTES } catch { return false }
}
export function approvedGrant(policy: Pick<ExecutionPolicyRecord, 'folder' | 'excluded' | 'projectRoot' | 'inputs'>, path: string): { path: string; sha256: string } | undefined {
  const p = normal(path)
  if (inFolderGrant(policy, p)) {
    try { return { path: p, sha256: currentSha256(resolveInside(policy.projectRoot, p)!) } } catch { return undefined }
  }
  if (policy.folder && (policy.excluded ?? []).some(x => { const e = normal(x).replace(/\/+$/, '').toLowerCase(); return p.toLowerCase() === e || p.toLowerCase().startsWith(e + '/') })) return undefined
  return policy.inputs.find(input => input.path === p || input.path === path)
}
export function approvedAt(policy: Pick<ExecutionPolicyRecord, 'folder' | 'excluded' | 'projectRoot' | 'inputs'>, path: string, sha256: string): boolean {
  return approvedGrant(policy, path)?.sha256 === sha256
}
export function readApprovedInput(root: string, file: { path: string; sha256: string }): Buffer {
  validateInputs([file])
  const target = resolveInside(root, file.path)
  if (!target || !lstatSync(target).isFile() || lstatSync(target).size > MAX_INPUT_FILE_BYTES) throw Error('The approved input is unavailable or exceeds 64 MB.')
  const bytes = readFileSync(target)
  if (bytes.length > MAX_INPUT_FILE_BYTES || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('An approved input changed. Review its current contents before execution.')
  requireReviewedText(bytes.toString('utf8'))
  return bytes
}
const SETTLED_MS = 2000
const fileKey = (s: Stats): string => `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
const checkedInputs = new Map<string, { key: string; sha256: string }>()
export function checkApprovedInput(root: string, file: { path: string; sha256: string }): number {
  validateInputs([file])
  const lexical = resolve(root, file.path), known = checkedInputs.get(lexical)
  if (known && known.sha256 === file.sha256) {
    try { const st = lstatSync(lexical); if (st.isFile() && !st.isSymbolicLink() && fileKey(st) === known.key) return st.size } catch {}
  }
  const target = resolveInside(root, file.path)
  if (!target || !lstatSync(target).isFile() || lstatSync(target).size > MAX_INPUT_FILE_BYTES) throw Error('The approved input is unavailable or exceeds 64 MB.')
  const before = lstatSync(target)
  const length = readApprovedInput(root, file).length
  if (Date.now() - before.ctimeMs >= SETTLED_MS) {
    if (checkedInputs.size > 5000) checkedInputs.clear()
    checkedInputs.set(target, { key: fileKey(before), sha256: file.sha256 })
  }
  return length
}
const settledHashes = new Map<string, { key: string; sha256: string }>()
export function settledSha256(abs: string): string {
  const st = statSync(abs), known = settledHashes.get(abs)
  if (known && known.key === fileKey(st)) return known.sha256
  const sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex')
  if (Date.now() - st.ctimeMs >= SETTLED_MS) {
    if (settledHashes.size > 5000) settledHashes.clear()
    settledHashes.set(abs, { key: fileKey(st), sha256 })
  }
  return sha256
}
export function inputMissing(root: string, path: string): boolean {
  try { lstatSync(resolve(root, path)); return false }
  catch (e) { const code = (e as NodeJS.ErrnoException)?.code; return code === 'ENOENT' || code === 'ENOTDIR' }
}
export function droppedInputsWords(paths: string[]): string {
  const one = paths.length === 1
  return `${paths.join(', ')} ${one ? 'was' : 'were'} on the list of approved inputs but ${one ? 'is' : 'are'} not in the project folder, so Damon took ${one ? 'it' : 'them'} off the list. Nothing else changed. A job that needs ${one ? 'that file' : 'those files'} gets ${one ? 'it' : 'them'} approved again once ${one ? 'it exists' : 'they exist'}.`
}
const HASH_SLICE_BYTES = 1024 * 1024
export async function sha256InSlices(bytes: Buffer): Promise<string> {
  const hash = createHash('sha256')
  for (let i = 0; i < bytes.length; i += HASH_SLICE_BYTES) {
    hash.update(bytes.subarray(i, i + HASH_SLICE_BYTES))
    if (i + HASH_SLICE_BYTES < bytes.length) await new Promise<void>(done => setImmediate(done))
  }
  return hash.digest('hex')
}
export async function readApprovedInputAsync(root: string, file: { path: string; sha256: string }, limit?: { bytes: number; refusal: string }): Promise<Buffer> {
  validateInputs([file])
  const target = resolveInside(root, file.path)
  const found = target ? await lstat(target).catch(() => undefined) : undefined
  if (!target || !found?.isFile() || found.size > MAX_INPUT_FILE_BYTES) throw Error('The approved input is unavailable or exceeds 64 MB.')
  if (limit && found.size > limit.bytes) throw Error(limit.refusal)
  const bytes = await readFile(target)
  if (bytes.length > MAX_INPUT_FILE_BYTES || (limit && bytes.length > limit.bytes) || await sha256InSlices(bytes) !== file.sha256) throw Error('An approved input changed. Review its current contents before execution.')
  return bytes
}
export function inspectExecutionInput(root: string, path: string): { path: string; sha256: string; content: string } {
  validateInputs([{ path, sha256: '0'.repeat(64) }])
  const target = resolveInside(root, path)
  if (!target || !lstatSync(target).isFile() || lstatSync(target).size > 512 * 1024) throw Error('Choose a text file of at most 512 KB within this project.')
  const bytes = readFileSync(target), sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length > 512 * 1024) throw Error('This file exceeds the preview budget.')
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  requireReviewedText(content)
  return { path, sha256, content }
}

export const DEFAULT_POLICY = {
  enabled: true, contextApproved: true, providers: ['claude', 'openai'] as ('claude' | 'openai')[],
  capabilities: [...defaultCapabilities], inputs: [] as { path: string; sha256: string }[], folder: true, excluded: [] as string[]
}

type PolicyShape = { revision: number; enabled: boolean; contextApproved: boolean; projectRoot: string; providers: string[]; capabilities: string[]; inputs: { path: string; sha256: string }[]; folder?: boolean; excluded?: string[]; dropped?: string[] }
const shapeHistories = new Map<string, { key: string; history: PolicyShape[] }>()
function shapeHistory(file: string): PolicyShape[] {
  let key = 'none'
  try { key = fileKey(lstatSync(file)) } catch {}
  const known = shapeHistories.get(file)
  if (known && known.key === key) return known.history
  const history = readJson<PolicyShape[]>(file, [])
  shapeHistories.set(file, { key, history })
  return history
}

const policyCache = new Map<string, { key: string; data: ExecutionPolicyRecord }>()
export class ExecutionPolicyStore {
  constructor(private readonly stateDir: string, private readonly projectId: string) {}
  private file(): string {
    const file = resolveInside(this.stateDir, 'execution-policy.json')
    if (!file || (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).size > 256 * 1024))) throw Error('Execution policy needs recovery. No access was granted.')
    return file
  }
  private quickKey(): { file: string; key: string } | null {
    const file = resolve(this.stateDir, 'execution-policy.json'), history = resolve(this.stateDir, 'execution-policy-history.json')
    try {
      const st = lstatSync(file)
      if (st.isSymbolicLink() || !st.isFile() || st.size > 256 * 1024) return null
      let hst: Stats | null = null
      try { hst = lstatSync(history) } catch { hst = null }
      if (hst?.isSymbolicLink()) return null
      return { file, key: `${this.projectId}:${st.size}:${st.mtimeMs}:${hst ? `${hst.size}:${hst.mtimeMs}` : 'none'}` }
    } catch { return null }
  }
  read(): ExecutionPolicyRecord | null {
    const quick = this.quickKey(), kept = quick ? policyCache.get(quick.file) : undefined
    if (quick && kept && kept.key === quick.key) return structuredClone(kept.data)
    const file = this.file()
    if (!existsSync(file)) return null
    const st = lstatSync(file), history = this.historyFile()
    const hst = history && existsSync(history) ? lstatSync(history) : null
    const key = `${this.projectId}:${st.size}:${st.mtimeMs}:${hst ? `${hst.size}:${hst.mtimeMs}` : 'none'}`
    const known = policyCache.get(file)
    if (known && known.key === key) return structuredClone(known.data)
    try {
      const data = executionPolicyRecord.parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Invalid key')
        return value
      }))
      if (data.projectId !== this.projectId || !isAbsolute(data.projectRoot) || new Set(data.providers).size !== data.providers.length || new Set(data.capabilities).size !== data.capabilities.length) throw Error('Invalid identity')
      validateInputs(data.inputs)
      this.rememberIfMissing(data)
      const after = history && existsSync(history) ? lstatSync(history) : null
      policyCache.set(file, { key: `${this.projectId}:${st.size}:${st.mtimeMs}:${after ? `${after.size}:${after.mtimeMs}` : 'none'}`, data })
      return structuredClone(data)
    } catch { throw Error('Execution policy needs recovery. Its original contents were preserved.') }
  }
  ensureDefault(projectRoot: string, protectedRoots: string[]): ExecutionPolicyRecord {
    const existing = this.read()
    if (existing) return existing
    return this.save({ expectedRevision: 0, ...DEFAULT_POLICY, providers: [...DEFAULT_POLICY.providers], capabilities: [...DEFAULT_POLICY.capabilities], inputs: [], excluded: [] }, projectRoot, protectedRoots)
  }
  private rememberIfMissing(record: ExecutionPolicyRecord): void {
    const file = this.historyFile()
    if (!file) return
    try {
      const history = shapeHistory(file)
      if (!history.some(h => h.revision === record.revision)) this.remember(record)
    } catch {}
  }
  save(value: ExecutionPolicyInput, projectRoot: string, protectedRoots: string[], onDropped?: (paths: string[]) => void): ExecutionPolicyRecord {
    const parsed = executionPolicyInput.parse(value), previous = this.read()
    validateInputs(parsed.inputs)
    const dropped = parsed.inputs.filter(file => !isRenderedView(file.path) && inputMissing(projectRoot, file.path)).map(file => file.path)
    const input = dropped.length ? { ...parsed, inputs: parsed.inputs.filter(file => !dropped.includes(file.path)) } : parsed
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw Error('Execution permissions changed. Reload before saving.')
    const root = input.enabled ? assertExecutionRoot(projectRoot, protectedRoots) : previous?.projectRoot ?? projectRoot
    if (!isAbsolute(root)) throw Error('A project folder identity is required.')
    validateInputs(input.inputs)
    if (new Set(input.providers).size !== input.providers.length || new Set(input.capabilities).size !== input.capabilities.length) throw Error('Execution permissions must be unique.')
    if (input.enabled && (!input.contextApproved || !input.providers.length)) throw Error('Review the project context and select a subscription provider before enabling execution.')
    const listedBefore = new Set((previous?.inputs ?? []).map((i) => i.path))
    const newView = input.inputs.find((i) => isRenderedView(i.path) && !listedBefore.has(i.path))
    if (newView) throw Error(viewNotAnInput(newView.path))
    let bytes = 0
    if (input.enabled) for (const file of input.inputs) if (!isRenderedView(file.path)) bytes += checkApprovedInput(root, file)
    if (bytes > MAX_INPUT_TOTAL_BYTES) throw Error('Approved inputs exceed the 256 MB budget.')
    const { expectedRevision, ...grants } = input
    const record = executionPolicyRecord.parse({ ...grants, version: 1, projectId: this.projectId, projectRoot: root, revision: expectedRevision + 1, updatedAt: new Date().toISOString() })
    writeJson(this.file(), record)
    this.remember(record, dropped)
    if (dropped.length) onDropped?.(dropped)
    return record
  }
  private historyFile(): string | null {
    return resolveInside(this.stateDir, 'execution-policy-history.json')
  }
  private remember(record: ExecutionPolicyRecord, dropped: string[] = []): void {
    const file = this.historyFile()
    if (!file) return
    const history = shapeHistory(file)
    const entry = { revision: record.revision, enabled: record.enabled, contextApproved: record.contextApproved, projectRoot: record.projectRoot, providers: [...record.providers], capabilities: [...record.capabilities], inputs: record.inputs.map(i => ({ path: i.path, sha256: i.sha256 })), folder: record.folder === true, excluded: [...(record.excluded ?? [])], ...(dropped.length ? { dropped: [...dropped] } : {}) }
    writeJson(file, keepPolicyHistory([...history.filter(h => h.revision !== record.revision), entry]))
    shapeHistories.delete(file)
  }
  onlyWidenedSince(revision: number): boolean {
    const current = this.read()
    if (!current || !current.enabled) return false
    if (current.revision === revision) return true
    const file = this.historyFile()
    const history = file ? shapeHistory(file) : []
    const earliest = [...history].sort((a, b) => a.revision - b.revision)[0]
    const then = history.find(h => h.revision === revision) ?? (earliest && revision < earliest.revision ? earliest : undefined)
    if (!then) return false
    const droppedSince = new Set(history.filter(h => h.revision > then.revision && h.revision <= current.revision).flatMap(h => h.dropped ?? []))
    return then.enabled === current.enabled && then.contextApproved === current.contextApproved && then.projectRoot === current.projectRoot
      && then.providers.every(p => (current.providers as string[]).includes(p))
      && then.capabilities.every(c => (current.capabilities as string[]).includes(c))
      && then.inputs.every(mine => isRenderedView(mine.path) || current.inputs.some(theirs => theirs.path === mine.path) || inFolderGrant(current, mine.path) || droppedSince.has(mine.path))
      && (!then.folder || current.folder === true)
      && (current.excluded ?? []).every(x => (then.excluded ?? []).includes(x))
  }
  require(provider: 'claude' | 'openai', projectRoot: string, protectedRoots: string[], expectedRevision?: number): ExecutionPolicyRecord {
    const record = this.read(), root = assertExecutionRoot(projectRoot, protectedRoots)
    if (!record || !record.enabled || !record.contextApproved) throw Error('This project needs owner-reviewed execution permissions and subscription access.')
    if (!record.providers.includes(provider)) throw Error(`${PROVIDER_NOT_ALLOWED} ${provider === 'openai' ? 'OpenAI (GPT)' : 'Claude'} models. Give this job to a teammate on an allowed model, or the owner can allow it on Execution permissions.`)
    if (record.projectRoot !== root || (expectedRevision !== undefined && record.revision !== expectedRevision)) throw Error('The project folder or execution permissions changed. This turn must stop.')
    return record
  }
}

export function withoutViews(current: ExecutionPolicyRecord): ExecutionPolicyInput {
  return {
    expectedRevision: current.revision,
    enabled: current.enabled,
    contextApproved: current.contextApproved,
    providers: [...current.providers],
    capabilities: [...current.capabilities],
    inputs: current.inputs.filter((i) => !isRenderedView(i.path)).map((i) => ({ path: i.path, sha256: i.sha256 })),
    ...(current.folder !== undefined ? { folder: current.folder } : {}),
    ...(current.excluded ? { excluded: [...current.excluded] } : {})
  } as ExecutionPolicyInput
}
