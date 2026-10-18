import type { ManagerEvent } from '../../../shared/types'
import type { SpawnedProcess } from '../manager-session'
import type { ProviderReader } from './types'
import type { NativeBrokerResult, NativeBrokerTurn } from './native-broker-run'

export function nativeTurnTransport(start: (prompt: string, onEvent: (event: ManagerEvent) => void) => NativeBrokerTurn): {
  process: SpawnedProcess; reader: ProviderReader; closed: Promise<NativeBrokerResult>
} {
  let prompt = '', ended = false, stopped = false, finished = false, active: NativeBrokerTurn | undefined
  const data = new Set<(chunk: Buffer) => void>(), close = new Set<(code: number | null) => void>()
  let resolveClosed!: (result: NativeBrokerResult) => void
  const closed = new Promise<NativeBrokerResult>(resolve => { resolveClosed = resolve })
  const emit = (event: ManagerEvent): void => { for (const listener of data) listener(Buffer.from(JSON.stringify(event) + '\n')) }
  const finish = (result: NativeBrokerResult): void => {
    if (finished) return
    finished = true
    try { emit(result) } finally {
      try { for (const listener of close) listener(result.ok ? 0 : 1) } finally { resolveClosed(result) }
    }
  }
  const process: SpawnedProcess = {
    stdin: {
      write(text) {
        if (ended || stopped || Buffer.byteLength(prompt) + Buffer.byteLength(text) > 1024 * 1024) throw Error('The protected prompt cannot be accepted.')
        prompt += text
      },
      end() {
        if (ended) return
        ended = true
        queueMicrotask(() => {
          if (stopped) { finish({ kind: 'result', ok: false, cancelled: true, cleanupVerified: true, error: 'Stopped before native admission.' }); return }
          try {
            active = start(prompt, event => { if (!finished && event.kind !== 'result') emit(event) })
            prompt = ''
            if (stopped) active.cancel()
            void active.done.then(finish).catch(() => finish({ kind: 'result', ok: false, cleanupVerified: false, error: 'The native turn could not be recorded safely.' }))
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e)
            finish({ kind: 'result', ok: false, cleanupVerified: false, error: `The protected turn could not start: ${why} No host fallback was used.` })
          }
        })
      }
    },
    stdout: { on: (_event, listener) => { data.add(listener) } },
    stderr: { on: () => {} },
    on: (_event, listener) => { close.add(listener) },
    kill: () => { if (finished) return; stopped = true; active?.cancel() }
  }
  let sawResult = false
  const reader: ProviderReader = {
    stdout(chunk) {
      const event = JSON.parse(chunk) as ManagerEvent
      if (event.kind === 'result') sawResult = true
      return [event]
    },
    close: () => sawResult ? [] : [{ kind: 'result', ok: false, error: 'No protected turn result was recorded.' }]
  }
  return { process, reader, closed }
}
