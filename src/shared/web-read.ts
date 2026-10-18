export function privateAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a.replace(/^::ffff:/, ''))
  if (v4) {
    const p = Number(v4[1]), q = Number(v4[2])
    return p === 0 || p === 10 || p === 127 || p >= 224 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
  }
  if (!a.includes(':')) return true
  return a.startsWith('::') || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const codePoint = (whole: string, n: number): string => { try { return String.fromCodePoint(n) } catch { return whole } }

export function pageWords(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => code[0] === '#'
      ? codePoint(whole, code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10))
      : ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function searchResults(links: { text: string; href: string; snippet: string }[]): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = []
  const engine = /(^|\.)duckduckgo\.com$/
  for (const link of links) {
    let url: URL
    try { url = new URL(link.href) } catch { continue }
    const wrapped = engine.test(url.hostname) ? url.searchParams.get('uddg') : null
    if (wrapped) { try { url = new URL(wrapped) } catch { continue } }
    if (!/^https?:$/.test(url.protocol) || engine.test(url.hostname) || !link.text.trim()) continue
    const known = out.find(r => r.url === url.href)
    if (known) { if (!known.snippet && link.snippet.trim()) known.snippet = link.snippet.trim().slice(0, 400); continue }
    out.push({ title: link.text.trim().slice(0, 300), url: url.href, snippet: link.snippet.trim().slice(0, 400) })
  }
  return out
}

export function linksFromHtml(html: string, base: string): { text: string; href: string; snippet: string }[] {
  const out: { text: string; href: string; snippet: string }[] = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] ?? '', words = pageWords(m[2] ?? '').replace(/\s+/g, ' ').trim()
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    if (!href || !words) continue
    const raw = (href[1] ?? href[2] ?? '').replace(/&amp;/g, '&')
    let abs: string
    try { abs = new URL(raw, base).href } catch { continue }
    if (/\bclass\s*=\s*["'][^"']*\bresult__snippet\b/i.test(attrs)) { const last = out[out.length - 1]; if (last && !last.snippet) last.snippet = words; continue }
    out.push({ text: words, href: abs, snippet: '' })
  }
  return out
}
