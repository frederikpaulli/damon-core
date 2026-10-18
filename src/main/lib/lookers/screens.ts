// The screen camera: serves a built screen, photographs each place at phone and desktop
// width and in each colour scheme, and returns the pictures for review.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { choosePlaces, errorState, lookCommand, parseLookConfig, type Scheme } from '../../../shared/look-config'
import { LOOK_TOTAL_MS } from '../../../shared/broker-call-limits'

export interface ShotFlags { errorScreen?: string; sampleData?: 'ran' | 'failed' | 'none'; consoleErrors: string[] }
export interface ScreenDeps {
  readText(path: string): string | null
  freePort(): Promise<number>
  start(command: string, cwd: string): { output(): string; stop(): Promise<void>; exited(): boolean }
  answers(url: string, ms: number): Promise<boolean>
  shoot(url: string, width: number, height: number, before?: string, scheme?: Scheme): Promise<{ png: Buffer; notes: string[]; flags?: ShotFlags }>
  write(path: string, png: Buffer): void
  now(): number
}
export interface ScreenShot { file: string; place: string; state?: string; width: number; scheme: Scheme; usable: boolean; why?: string; measured?: string[] }
export interface ScreenLook { shots: ScreenShot[]; notes: string[]; places: string[]; schemes: Scheme[]; states: string[]; problem?: string }

const SIZES = [{ width: 390, height: 844 }, { width: 1280, height: 900 }] as const
const SERVER_WAIT_MS = 90_000
const plain = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim()
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9æøå]+/g, '-').replace(/^-+|-+$/g, '') || 'place'

const SHOT_TIMEOUT_MS = 60_000
const inTime = <T,>(work: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} seconds`)), ms)
  work.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
})

export async function lookAtScreens(req: { dir: string; places?: string[]; states?: string[]; schemes?: Scheme[]; errorStateOk?: boolean; shotTimeoutMs?: number; totalMs?: number }, deps: ScreenDeps): Promise<ScreenLook> {
  const totalMs = req.totalMs ?? LOOK_TOTAL_MS
  const deadline = deps.now() + totalMs
  const left = (): number => deadline - deps.now()
  const notes: string[] = []
  let raw: unknown = null
  const text = deps.readText(join(req.dir, 'damon-look.json'))
  if (text !== null) {
    try { raw = JSON.parse(text) } catch { notes.push('damon-look.json was not used: it is not valid JSON.') }
  }
  const config = parseLookConfig(raw)
  if (config.problem) notes.push(config.problem)
  const chosen = choosePlaces(config, req.places)
  if (chosen.unknown.length) notes.push(`Not a place this project names: ${chosen.unknown.join(', ')}. Its places: ${config.places.map(p => p.name).join(', ')}.`)
  const places = chosen.places.length ? chosen.places : config.places
  const states = req.states?.length ? config.states.filter(s => req.states!.some(w => w.trim().toLowerCase() === s.toLowerCase())) : config.states
  const unknownStates = (req.states ?? []).filter(w => !config.states.some(s => s.toLowerCase() === w.trim().toLowerCase()))
  if (unknownStates.length) notes.push(`Not a state this project names: ${unknownStates.join(', ')}.${config.states.length ? ` Its states: ${config.states.join(', ')}.` : ''}`)
  const schemes = (req.schemes?.length ? req.schemes : ['light' as const]).filter(s => config.schemes.includes(s))
  if (!schemes.length) schemes.push(config.schemes[0] ?? 'light')
  const base = { notes, places: config.places.map(p => p.name), schemes: config.schemes, states: [...config.states] }

  let pkg: { scripts?: Record<string, string> } | null = null
  try { pkg = JSON.parse(deps.readText(join(req.dir, 'package.json')) ?? 'null') as typeof pkg } catch { pkg = null }
  const port = await deps.freePort()
  const command = lookCommand(pkg, config, port)
  if (!command) return { ...base, shots: [], problem: 'This project has no dev, start, serve or preview script and damon-look.json names no command, so there is nothing to start.' }
  let before: string | undefined
  if (config.before) {
    const script = deps.readText(join(req.dir, config.before))
    if (script === null) notes.push(`${config.before}, named as "before" in damon-look.json, is not in the copy, so the pages load without it.`)
    else before = script
  }

  const server = deps.start(command, req.dir)
  const shots: ScreenShot[] = []
  try {
    const url = `http://127.0.0.1:${port}`
    const wait = Math.max(0, Math.min(SERVER_WAIT_MS, left()))
    if (!(await deps.answers(`${url}/`, wait))) {
      return { ...base, shots, problem: `The front end did not answer on port ${port} within ${Math.round(wait / 1000)} seconds${server.exited() ? ' (it stopped by itself)' : ''}. It was started with: ${command}. Its last output: ${plain(server.output()).slice(-600) || 'nothing'}` }
    }
    const folder = `damon-shots/look-${deps.now()}`
    const wrapped = before ? `try {\n${before}\n;window.__DAMON_BEFORE_RAN = true\n} catch (e) { window.__DAMON_BEFORE_ERROR = String((e && e.message) || e) }` : ''
    const schemeScript = (scheme: Scheme): string => { const p = config.schemeScripts?.[scheme]; return p ? deps.readText(join(req.dir, p)) ?? '' : '' }
    for (const place of places) {
      for (const state of states.length ? states : [undefined]) {
        const deliberate = req.errorStateOk === true || errorState(state)
        for (const scheme of schemes) {
          const script = [state ? `window.__DAMON_LOOK_STATE = ${JSON.stringify(state)};` : '', wrapped, schemeScript(scheme)].filter(Boolean).join('\n') || undefined
          for (const size of SIZES) {
            const room = left()
            if (room <= 0) return { ...base, shots, problem: `The look ran out of its ${Math.round(totalMs / 60_000)} minutes after ${shots.length} picture${shots.length === 1 ? '' : 's'}; ask for fewer places at a time.` }
            const shot = await inTime(deps.shoot(`${url}${place.path.startsWith('/') ? place.path : `/${place.path}`}`, size.width, size.height, script, scheme), Math.min(req.shotTimeoutMs ?? SHOT_TIMEOUT_MS, room), `the picture of ${place.name} at ${size.width} px`)
            const file = `${folder}/${slug(place.name)}${state ? `-${slug(state)}` : ''}${scheme === 'dark' ? '-dark' : ''}-${size.width}w.png`
            deps.write(join(req.dir, file), shot.png)
            const flags = shot.flags
            const why = flags?.errorScreen && !deliberate ? `the picture shows an error instead of the screen ("${flags.errorScreen.slice(0, 80)}")`
              : before && flags?.sampleData === 'failed' ? "the project's sample-data script did not run, so the screen has no data"
              : undefined
            const measured = deliberate ? shot.notes.filter(n => !/shows an error instead of the screen/.test(n)) : shot.notes
            const where = `${place.name}${state ? ` (${state})` : ''}${schemes.length > 1 || scheme === 'dark' ? `, ${scheme}` : ''}`
            shots.push({ file, place: place.name, ...(state ? { state } : {}), width: size.width, scheme, usable: !why, ...(why ? { why } : {}), ...(measured.length ? { measured } : {}) })
            for (const n of measured) notes.push(`${where}: ${n}`)
            if (why) notes.push(`${where}, ${size.width} px: ${why}. Do not judge the look from it.`)
            else if (flags?.errorScreen && deliberate) notes.push(`${where}, ${size.width} px: it shows the error state this job or this state asks for ("${flags.errorScreen.slice(0, 80)}"); judge it as that screen.`)
            const failed = `The project's sample-data script did not run${flags?.consoleErrors[0] ? `: ${flags.consoleErrors[0]}` : ''}.`
            if (flags?.sampleData === 'failed' && !notes.includes(failed)) notes.push(failed)
          }
        }
      }
    }
    return { ...base, shots }
  } catch (e) {
    return { ...base, shots, problem: `A picture could not be taken: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    await server.stop().catch(() => undefined)
  }
}

const running = new Set<number>()
export function stopScreenServers(): void {
  for (const pid of running) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 })
      else process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  running.clear()
}

export function machineScreenDeps(shoot: ScreenDeps['shoot']): ScreenDeps {
  return {
    readText: path => { try { return readFileSync(path, 'utf8') } catch { return null } },
    freePort: () => new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => { const a = probe.address(); const port = typeof a === 'object' && a ? a.port : 0; probe.close(() => resolve(port)) })
    }),
    start: (command, cwd) => {
      let output = ''
      let exited = false
      const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', BROWSER: 'none' } })
      if (child.pid) running.add(child.pid)
      const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-20_000) }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      child.on('exit', () => { exited = true; if (child.pid) running.delete(child.pid) })
      child.on('error', e => { exited = true; output += `\n${e.message}` })
      return {
        output: () => output,
        exited: () => exited,
        stop: () => new Promise<void>(resolve => {
          if (exited || !child.pid) { resolve(); return }
          if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on('close', () => resolve()).on('error', () => resolve())
          else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } resolve() }
        })
      }
    },
    answers: async (url, ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const ok = await new Promise<boolean>(resolve => {
          const r = request(url, { method: 'GET', timeout: 2000 }, res => { res.resume(); resolve((res.statusCode ?? 500) < 500) })
          r.on('error', () => resolve(false))
          r.on('timeout', () => { r.destroy(); resolve(false) })
          r.end()
        })
        if (ok) return true
        await new Promise(resolve => setTimeout(resolve, 700))
      }
      return false
    },
    shoot,
    write: (path, png) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, png) },
    now: () => Date.now()
  }
}
