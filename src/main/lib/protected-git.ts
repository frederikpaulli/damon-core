import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitRun, RepoGuard } from './git-save'

export const SAVE_SUBCOMMANDS = ['rev-parse', 'remote', 'status', 'add', 'diff', 'reset', 'commit', 'push', 'rev-list', 'config'] as const
const HOOKLESS = new Set<string>(['rev-parse', 'remote', 'config'])

export function hardenedArgs(hooksDir: string, protocols: string[] = ['https', 'ssh']): string[] {
  const pairs = [
    `core.hooksPath=${hooksDir}`,
    'core.fsmonitor=false',
    'credential.interactive=false',
    'protocol.allow=never',
    ...protocols.map((p) => `protocol.${p}.allow=always`),
    'submodule.recurse=false',
    'push.recurseSubmodules=no'
  ]
  return pairs.flatMap((p) => ['-c', p])
}

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !/^git_/i.test(key)) env[key] = value
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'never'
  return env
}

export function emptyHooksDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return `Damon's empty hooks folder (${dir}) is not a plain folder, so nothing was saved.`
    if (readdirSync(dir).length > 0) return `Damon's hooks folder (${dir}) should be empty and is not, so nothing was saved. Something put a file there; tell the supervisor.`
    return null
  } catch (e) {
    return `Damon's empty hooks folder could not be prepared, so nothing was saved: ${e instanceof Error ? e.message : String(e)}`
  }
}

type ExecDone = (err: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void
export type GitExec = (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean; env: NodeJS.ProcessEnv }, done: ExecDone) => void
const realExec: GitExec = (file, args, options, done) => {
  execFile(file, args, { ...options, encoding: 'utf8' }, (err, stdout, stderr) => done(err, String(stdout ?? ''), String(stderr ?? '')))
}
const MAX_OUTPUT = 64 * 1024 * 1024

export function protectedGitRunner(hooksDir: string, options: { exec?: GitExec; protocols?: string[] } = {}): GitRun {
  const exec = options.exec ?? realExec
  return (args, cwd) => new Promise((resolve) => {
    const sub = args[0] ?? ''
    if (!(SAVE_SUBCOMMANDS as readonly string[]).includes(sub) || (sub === 'config' && !args.includes('--list'))) {
      resolve({ ok: false, out: `Damon's save does not run "git ${args.slice(0, 3).join(' ')}".` })
      return
    }
    if (!HOOKLESS.has(sub)) {
      const why = emptyHooksDir(hooksDir)
      if (why) { resolve({ ok: false, out: why }); return }
    }
    exec('git', [...hardenedArgs(hooksDir, options.protocols), ...args], { cwd, timeout: 120_000, maxBuffer: MAX_OUTPUT, windowsHide: true, env: scrubbedEnv() }, (err, stdout, stderr) => {
      const tooMuch = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      resolve({ ok: !err, out: tooMuch ? `git ${sub} printed more than 64 MB, which is more than can be read` : `${stdout}${stderr}` })
    })
  })
}

const LOCAL_KEYS: RegExp[] = [
  /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|autocrlf|longpaths|quotepath)$/,
  /^remote\..+\.(?:url|fetch|gh-resolved)$/,
  /^branch\..+\.(?:remote|merge|rebase|vscode-merge-base)$/,
  /^user\.(?:name|email)$/,
  /^(?:pull\.(?:rebase|ff)|push\.(?:default|autosetupremote)|fetch\.prune|init\.defaultbranch)$/,
  /^gui\.[a-z]+$/,
  /^lfs\.repositoryformatversion$/
]
export const PUSH_ADDRESS = /^(?:https:\/\/\S+|ssh:\/\/\S+|git@[A-Za-z0-9.-]+:\S+)$/
const BEHAVIOUR_FILE = /(?:^|\/)\.(?:gitattributes|gitmodules|lfsconfig)$/i
const NAMES_A_DRIVER = /\b(?:filter|diff|merge)\s*=/i

export function repositoryGuard(hooksDir: string, options: { address?: RegExp } = {}): RepoGuard {
  const address = options.address ?? PUSH_ADDRESS
  return async (cwd, run) => {
    const hooks = emptyHooksDir(hooksDir)
    if (hooks) return hooks
    try {
      const st = lstatSync(join(cwd, '.git'))
      if (!st.isDirectory() || st.isSymbolicLink()) return "This project's .git is a link to a repository somewhere else, which Damon's save does not follow. Nothing was saved; save it yourself for now."
    } catch {
      return "This project has no .git folder of its own, so Damon's save did not run."
    }
    const listed = await run(['config', '--local', '--no-includes', '--null', '--list'], cwd)
    if (!listed.ok) return `Damon could not read this project's own git settings, so nothing was saved: ${listed.out.trim().split('\n')[0] ?? ''}`
    for (const entry of listed.out.split('\0').filter(Boolean)) {
      const cut = entry.indexOf('\n')
      const key = (cut === -1 ? entry : entry.slice(0, cut)).toLowerCase()
      const value = cut === -1 ? '' : entry.slice(cut + 1)
      if (!LOCAL_KEYS.some((rule) => rule.test(key))) return `This project's own git settings contain "${key}", which could run a program or send the work somewhere else. Damon's save does not run with it, so nothing was saved. Remove that setting, or save this project yourself.`
      if (/^remote\..+\.url$/.test(key) && !address.test(value)) return `This project's GitHub address (${key}) is not an https or ssh address, so Damon will not push to it. Nothing was saved.`
    }
    const status = await run(['status', '--porcelain', '-z', '--untracked-files=all'], cwd)
    if (status.ok) {
      for (const chunk of status.out.split('\0').filter(Boolean)) {
        const path = chunk.replace(/^.. /, '')
        if (!BEHAVIOUR_FILE.test(path)) continue
        if (/\.gitattributes$/i.test(path)) {
          let text = ''
          try { text = readFileSync(join(cwd, path), 'utf8') } catch {}
          if (!NAMES_A_DRIVER.test(text)) continue
        }
        return `${path} changed and names a program for git to run. Damon does not save a change to git's own settings files; look at it, then save this project yourself.`
      }
    }
    try {
      if (/\bfilter\s*=\s*lfs\b/i.test(readFileSync(join(cwd, '.gitattributes'), 'utf8'))) return "This project keeps large files with Git LFS, which Damon's save cannot upload safely, so nothing was saved. Save it yourself for now."
    } catch {}
    return null
  }
}
