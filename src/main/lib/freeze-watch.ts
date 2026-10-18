import { appendFileSync } from 'node:fs'

const recent: { what: string; at: number }[] = []
export function noteRunning(what: string): void {
  recent.push({ what, at: performance.now() })
  if (recent.length > 200) recent.splice(0, recent.length - 200)
}

export function startFreezeWatch(o: { file?: string; thresholdMs?: number; tickMs?: number; append?: (line: string) => void }): () => void {
  const threshold = o.thresholdMs ?? 1000
  const tick = o.tickMs ?? 250
  const append = o.append ?? ((line: string) => { try { appendFileSync(o.file!, line + '\n') } catch {} })
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const stall = now - last - tick
    if (stall > threshold) {
      const during = [...new Set(recent.filter((r) => r.at >= last && r.at <= now).map((r) => r.what))].slice(0, 20)
      append(JSON.stringify({ at: new Date().toISOString(), ms: Math.round(stall), during }))
    }
    last = now
  }, tick)
  timer.unref?.()
  return () => clearInterval(timer)
}
