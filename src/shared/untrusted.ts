function isInvisible(code: number): boolean {
  if (code < 0x20) return true
  if (code >= 0x7f && code <= 0x9f) return true
  if (code >= 0x200b && code <= 0x200f) return true
  if (code === 0x2028 || code === 0x2029) return true
  if (code === 0xa0 || code === 0xfeff) return true
  return false
}

const FRAMING = /[[\]{}<>|`]/g

export function plainName(text: unknown, max = 60): string {
  const raw = typeof text === 'string' ? text : ''
  let cleaned = ''
  for (const ch of raw) {
    cleaned += isInvisible(ch.codePointAt(0) ?? 0) ? ' ' : ch
  }
  const flat = cleaned.replace(FRAMING, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max).trim() + '...'
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PYPI_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const VERSION = /^[0-9][0-9a-zA-Z.+-]*$/

export function isSafePackageName(identifier: string, type: 'npm' | 'pypi'): boolean {
  const id = String(identifier ?? '')
  if (id.length === 0 || id.length > 214) return false
  return type === 'npm' ? NPM_NAME.test(id) : PYPI_NAME.test(id)
}

export function isSafeVersion(version: string): boolean {
  const v = String(version ?? '')
  return v.length > 0 && v.length <= 64 && VERSION.test(v)
}

export function isSafeHttpsUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return parsed.hostname.length > 0
  } catch {
    return false
  }
}
