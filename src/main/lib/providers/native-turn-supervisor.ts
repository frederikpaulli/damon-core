import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { resolveInside } from '../file-browser'
import { writeJson } from '../json-file'
import type { NativeBrokerResult, NativeBrokerTurn } from './native-broker-run'

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/)
const owner = z.object({ projectId: identity, callerId: identity,
  provider: z.enum(['claude', 'openai']), model: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) }).strict()
const record = owner.extend({ id: z.string().uuid(), startedAt: z.string().datetime(),
  state: z.enum(['prepared', 'finished', 'cleanup-uncertain', 'recovered']),
  finishedAt: z.string().datetime().optional(), outcome: z.enum(['completed', 'failed', 'cancelled', 'unknown']).optional()
}).strict().superRefine((value, context) => {
  if (value.state === 'prepared' ? value.finishedAt !== undefined || value.outcome !== undefined : !value.finishedAt || !value.outcome)
    context.addIssue({ code: 'custom', message: 'Invalid execution lifecycle.' })
})
const journal = z.object({ version: z.literal(1), runs: z.array(record).max(10000) }).strict()
type Journal = z.infer<typeof journal>
export type NativeTurnOwner = z.infer<typeof owner>

export const NATIVE_CLEANUP_UNCONFIRMED = 'This turn ended before Damon could confirm its program had closed, so nothing it produced was used. Damon checks that by itself before the next turn starts; nobody needs to restart anything. Run the same work again.'
export function unconfirmedCloseNote(s: { helperClosed: boolean; brokerIdle: boolean; timedOut?: boolean; cancelled?: boolean; protocolReason?: string }): string {
  const cause = s.timedOut ? 'the time limit stopped it' : s.cancelled ? 'it was stopped' : s.protocolReason ? 'it ended with an error' : 'it ended'
  if (!s.helperClosed && !s.brokerIdle) return `its program was still open 30 seconds after ${cause}, and one of its tool calls was still running`
  if (!s.helperClosed) return `its program was still open 30 seconds after ${cause}`
  if (!s.brokerIdle) return 'one of its tool calls was still running when it ended'
  return ''
}
const withNote = (note?: string): string => note ? NATIVE_CLEANUP_UNCONFIRMED.replace('had closed,', `had closed (${note}),`) : NATIVE_CLEANUP_UNCONFIRMED
export class NativeTurnSupervisor {
  private readonly root: string
  private ready = false
  private recovering = false
  private held = false
  private active = new Map<string, { owner: NativeTurnOwner; turn?: NativeBrokerTurn; stopped: boolean }>()
  constructor(dataDir: string, private readonly capacity = 2) {
    if (!isAbsolute(dataDir) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw Error('Invalid native admission configuration.')
    mkdirSync(dataDir, { recursive: true })
    this.root = realpathSync(dataDir)
  }
  private path(name: string): string {
    const target = resolveInside(this.root, name)
    if (!target || (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))) throw Error('Native admission records need recovery.')
    return target
  }
  private read(): Journal {
    const file = this.path('native-turns.json'), marker = this.path('native-turns.initialized')
    if (!existsSync(file)) {
      if (existsSync(marker)) throw Error('Native admission records disappeared.')
      return { version: 1, runs: [] }
    }
    if (lstatSync(file).size > 8 * 1024 * 1024) throw Error('Native admission records exceed their limit.')
    const data = journal.parse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
    if (new Set(data.runs.map(run => run.id)).size !== data.runs.length) throw Error('Native admission identities conflict.')
    return data
  }
  private save(data: Journal): void {
    const cutoff = Date.now() - 24 * 60 * 60_000
    data.runs = data.runs.filter(run => !((run.state === 'finished' || run.state === 'recovered') && run.finishedAt && Date.parse(run.finishedAt) < cutoff))
    journal.parse(data)
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > 8 * 1024 * 1024) throw Error('Native admission storage is full. Preserve and review the records before resuming.')
    writeJson(this.path('native-turns.json'), data)
  }
  async recover(proveCleanup: (live: { projectId: string; callerId: string }[]) => Promise<void>): Promise<void> {
    if (this.recovering) throw Error('Native admission recovery is already running.')
    this.ready = false; this.recovering = true
    try {
      const before = this.read()
      const covered = before.runs.filter(run => !this.active.has(run.id) && (run.state === 'prepared' || run.state === 'cleanup-uncertain'))
      await proveCleanup([...this.active.values()].map(run => ({ projectId: run.owner.projectId, callerId: run.owner.callerId })))
      const data = this.read()
      for (const run of covered) {
        const now = data.runs.find(r => r.id === run.id)
        if (!now || JSON.stringify(now) !== JSON.stringify(run)) throw Error('Native admission records changed during recovery.')
      }
      const ids = new Set(covered.map(run => run.id))
      for (const run of data.runs) if (ids.has(run.id)) {
        run.state = 'recovered'; run.finishedAt = new Date().toISOString(); run.outcome = 'unknown'
      }
      this.save(data)
      const marker = this.path('native-turns.initialized')
      if (!existsSync(marker)) writeFileSync(marker, '1\n', { flag: 'wx' })
      const unsure = data.runs.some(run => run.state === 'cleanup-uncertain' || (run.state === 'prepared' && !this.active.has(run.id)))
      this.held = unsure; this.ready = !unsure
    } catch (e) {
      this.held = true
      const why = e instanceof Error ? e.message.trim() : ''
      throw Error(`Native execution recovery is unverified. No new turn was admitted.${why ? ` What stopped it: ${why}` : ''}`)
    }
    finally { this.recovering = false }
  }
  status(): { ready: boolean; held: boolean; active: number } {
    return { ready: this.ready && !this.held && !this.recovering, held: this.held, active: this.active.size }
  }
  start(value: NativeTurnOwner, launch: (runId: string) => NativeBrokerTurn): NativeBrokerTurn {
    const scope = owner.parse(value)
    if (!this.ready || this.held || this.recovering) throw Error('Native execution is held pending verified recovery.')
    if (this.active.size >= this.capacity) throw Error('Native execution capacity is in use. Keep this work queued.')
    if ([...this.active.values()].some(run => run.owner.projectId === scope.projectId && run.owner.callerId === scope.callerId)) throw Error('This project caller already has an active native turn.')
    const id = randomUUID()
    try {
      if (!existsSync(this.path('native-turns.initialized'))) throw Error('Native admission marker disappeared.')
      const data = this.read()
      if (data.runs.some(run => run.state === 'cleanup-uncertain' || (run.state === 'prepared' && !this.active.has(run.id)))) throw Error('Previous native admission needs recovery.')
      data.runs.push({ ...scope, id, startedAt: new Date().toISOString(), state: 'prepared' })
      this.save(data)
    } catch { this.held = true; throw Error('Native admission could not be recorded. No new turn was admitted.') }
    const admission = { owner: scope, turn: undefined as NativeBrokerTurn | undefined, stopped: false }
    this.active.set(id, admission)
    let turn: NativeBrokerTurn
    try {
      turn = launch(id)
      if (!turn || !(turn.done instanceof Promise) || typeof turn.cancel !== 'function') throw Error('Invalid native launch handle.')
      admission.turn = turn
      if (admission.stopped) turn.cancel()
    }
    catch { this.finish(id, undefined); throw Error('Native launch failed. Cleanup must be verified before resuming.') }
    const done = turn.done.then(result => {
      if (!this.finish(id, result)) return { ...result, ok: false, cleanupVerified: false, error: withNote(result.cleanupNote) }
      return result
    }, () => {
      this.finish(id, undefined)
      return { kind: 'result' as const, ok: false, cleanupVerified: false, error: 'Native turn completion is unknown. Recovery is required.' }
    })
    return { done, cancel: () => { if (this.active.has(id)) turn.cancel() } }
  }
  private finish(id: string, result: NativeBrokerResult | undefined): boolean {
    const verified = result?.cleanupVerified === true
    if (!verified) this.held = true
    try {
      const data = this.read(), run = data.runs.find(run => run.id === id)
      if (!run || run.state !== 'prepared') throw Error('Native admission record changed.')
      run.state = verified ? 'finished' : 'cleanup-uncertain'
      run.finishedAt = new Date().toISOString()
      run.outcome = verified ? result!.cancelled ? 'cancelled' : result!.ok ? 'completed' : 'failed' : 'unknown'
      this.save(data)
      return verified
    } catch { this.held = true; return false }
    finally { this.active.delete(id) }
  }
  stop(projectId?: string, callerId?: string): void {
    if (callerId && !projectId) throw Error('A caller stop needs a project scope.')
    for (const run of this.active.values()) if ((!projectId || run.owner.projectId === projectId) && (!callerId || run.owner.callerId === callerId)) {
      run.stopped = true
      try { run.turn?.cancel() } catch { this.held = true }
    }
  }
}
