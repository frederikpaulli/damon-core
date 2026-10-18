import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { processes, type ProcessRegistry } from '../process-registry'

export async function spawnNativeJob(options: {
  helperPath: string; helperSha256: string; executable: string; executableSha256: string
  args: string[]; cwd: string; env: NodeJS.ProcessEnv
  owner: { projectId: string; agentId: string }
  signal?: AbortSignal
}, registry: ProcessRegistry = processes): Promise<ChildProcessWithoutNullStreams> {
  const signal = options.signal
  signal?.throwIfAborted()
  const owner = { ...options.owner }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(owner.projectId ?? '') || !/^[A-Za-z0-9_:.-]{1,200}$/.test(owner.agentId ?? '')) throw Error('A native job needs an explicit project and caller.')
  registry.assertReadyForNativeExecution()
  if (process.platform !== 'win32' || !isAbsolute(options.helperPath) || !/^[a-f0-9]{64}$/.test(options.helperSha256) || createHash('sha256').update(readFileSync(options.helperPath)).digest('hex') !== options.helperSha256) throw Error('The native lifetime wrapper is missing or changed.')
  const nonce = randomUUID(), specPath = join(options.cwd, `native-launch-${nonce}.json`)
  writeFileSync(specPath, JSON.stringify({ executable: options.executable, sha256: options.executableSha256, arguments: options.args, cwd: options.cwd, ownerPid: process.pid, nonce }), { flag: 'wx' })
  const child = spawn(options.helperPath, [specPath], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true })
  const abort = (): void => { child.kill() }
  signal?.addEventListener('abort', abort, { once: true })
  child.once('close', () => signal?.removeEventListener('abort', abort))
  child.stdin.on('error', () => {})
  child.on('error', () => {})
  child.once('close', () => {
    if (child.pid) registry.forget(child.pid)
    try { writeFileSync(specPath, JSON.stringify({ closedAt: new Date().toISOString(), pid: child.pid, state: 'native-job-closed' })) } catch {}
  })
  child.once('exit', () => { if (child.pid) registry.forget(child.pid) })
  try {
    if (!child.pid) throw Error('The native wrapper did not start.')
    registry.add({ pid: child.pid, match: specPath, projectId: owner.projectId, agentId: owner.agentId, startedAt: new Date().toISOString() })
    await new Promise<void>((resolve, reject) => {
      let pending = '', done = false
      const finish = (error?: Error): void => {
        if (done) return; done = true; clearTimeout(timer)
        child.stderr.off('data', listen); child.off('close', closed)
        if (error) reject(error); else resolve()
      }
      const closed = (): void => finish(Error('The native lifetime wrapper stopped before admission.'))
      const listen = (chunk: Buffer): void => {
        pending += chunk.toString('utf8')
        if (pending.length > 4096) { finish(Error('Invalid native lifetime handshake.')); return }
        if (pending === `DAMON_JOB_READY ${nonce}\r\n` || pending === `DAMON_JOB_READY ${nonce}\n`) {
          if (signal?.aborted) { finish(Error('Native launch was cancelled before admission.')); return }
          child.stdin.write(nonce + '\n'); finish()
        }
      }
      const timer = setTimeout(() => finish(Error('The native lifetime handshake timed out.')), 30000)
      child.stderr.on('data', listen); child.once('close', closed)
      child.on('error', () => finish(Error('The native lifetime wrapper could not execute.')))
    })
    signal?.throwIfAborted()
    return child
  } catch (error) { child.kill(); throw error }
}
