import { request } from 'node:http'

export interface PageTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

const PAGE_TEXT_SCRIPT = `(() => {
  const copy = document.body.cloneNode(true);
  for (const el of copy.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')) el.remove();
  const box = document.createElement('div');
  box.style.position = 'fixed'; box.style.left = '-99999px'; box.style.top = '0';
  box.appendChild(copy);
  document.documentElement.appendChild(box);
  const text = box.innerText || box.textContent || '';
  box.remove();
  return text;
})()`

const CALL_TIMEOUT_MS = 8000

function getJson<T>(url: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T)
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

export async function pageTargets(cdpUrl: string): Promise<PageTarget[]> {
  const raw = await getJson<unknown>(`${cdpUrl}/json`)
  return Array.isArray(raw) ? (raw as PageTarget[]) : []
}

export async function activatePage(cdpUrl: string, id: string): Promise<void> {
  try {
    await getJson<unknown>(`${cdpUrl}/json/activate/${id}`)
  } catch {
  }
}

interface CdpReply {
  id: number
  result?: Record<string, unknown>
  error?: { message?: string }
}

async function call(wsUrl: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket
  if (!WS) throw new Error('WebSocket is not available in this process')
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
      }
      reject(new Error(`${method} timed out`))
    }, CALL_TIMEOUT_MS)
    const finish = (fn: () => void): void => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
      }
      fn()
    }
    ws.onerror = () => finish(() => reject(new Error(`could not talk to the page for ${method}`)))
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onmessage = (ev: MessageEvent) => {
      let reply: CdpReply
      try {
        reply = JSON.parse(String(ev.data)) as CdpReply
      } catch {
        return
      }
      if (reply.id !== 1) return
      if (reply.error) finish(() => reject(new Error(reply.error?.message ?? `${method} failed`)))
      else finish(() => resolve(reply.result ?? {}))
    }
  })
}

export async function readPageText(wsUrl: string): Promise<string> {
  const result = await call(wsUrl, 'Runtime.evaluate', { expression: PAGE_TEXT_SCRIPT, returnByValue: true })
  const value = (result as { result?: { value?: unknown } }).result?.value
  return typeof value === 'string' ? value : ''
}


export async function openReadPage(cdpUrl: string, url: string): Promise<{ wsUrl: string; id: string; close(): Promise<void> }> {
  const target = new URL(url)
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http and https pages can be opened.')
  let id: string | undefined
  try {
    const version = await getJson<{ webSocketDebuggerUrl?: string }>(`${cdpUrl}/json/version`)
    if (version?.webSocketDebuggerUrl) id = String((await call(version.webSocketDebuggerUrl, 'Target.createTarget', { url, background: true, newWindow: false })).targetId ?? '') || undefined
  } catch {}
  if (!id) {
    const made = await putJson<PageTarget>(`${cdpUrl}/json/new?${encodeURIComponent(url)}`)
    id = made?.id
  }
  if (!id) throw new Error('The browser did not open a new page.')
  let wsUrl = ''
  for (let i = 0; i < 20 && !wsUrl; i++) {
    wsUrl = (await pageTargets(cdpUrl)).find(p => p.id === id)?.webSocketDebuggerUrl ?? ''
    if (!wsUrl) await new Promise(r => setTimeout(r, 150))
  }
  if (!wsUrl) throw new Error('The browser did not open a new page.')
  const tab = id
  return { wsUrl, id: tab, close: async () => { try { await getJson(`${cdpUrl}/json/close/${tab}`) } catch {} } }
}

export async function pageSettled(wsUrl: string, limitMs = 8000, leftFrom?: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < limitMs) {
    try {
      const r = await call(wsUrl, 'Runtime.evaluate', { expression: 'JSON.stringify({ state: document.readyState, href: location.href, origin: performance.timeOrigin })', returnByValue: true })
      const now = JSON.parse(String((r as { result?: { value?: unknown } }).result?.value ?? '{}')) as { state?: string; href?: string; origin?: number }
      if (now.state === 'complete' && now.href && now.href !== 'about:blank' && (leftFrom === undefined || now.origin !== leftFrom)) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

function putJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'PUT', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => { try { resolve(JSON.parse(body) as T) } catch (err) { reject(err) } })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}


const valueOf = (r: Record<string, unknown>): unknown => (r as { result?: { value?: unknown } }).result?.value

export async function readLinks(wsUrl: string): Promise<{ text: string; href: string; snippet: string }[]> {
  const script = `(() => JSON.stringify(Array.from(document.querySelectorAll('a[href]')).slice(0, 400).map(a => {
    const box = a.closest('.result, .web-result, article, li');
    const near = box && box.querySelector('.result__snippet, [data-result="snippet"]');
    return { text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300), href: a.href, snippet: near ? (near.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : '' };
  })))()`
  const raw = valueOf(await call(wsUrl, 'Runtime.evaluate', { expression: script, returnByValue: true }))
  try { const parsed = JSON.parse(typeof raw === 'string' ? raw : '[]') as unknown; return Array.isArray(parsed) ? parsed as { text: string; href: string; snippet: string }[] : [] } catch { return [] }
}

