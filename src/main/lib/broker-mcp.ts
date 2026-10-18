// Exposes the broker's tools to an agent as an MCP endpoint on 127.0.0.1, guarded by a
// random bearer token and a host check.
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ScopedToolBroker, type BrokerResult } from './scoped-tool-broker'

export class BrokerMcpEndpoint {
  private readonly token = randomBytes(32).toString('hex')
  private server: HttpServer | null = null
  private port = 0
  private closed = false
  private requests = 0
  private active = 0
  private transports = new Set<Server>()
  constructor(private readonly broker: ScopedToolBroker, private readonly sessionId: string, private readonly turnId: string, private readonly onAbandoned?: (tool: string, ms: number) => void) {}
  async start(): Promise<{ type: 'http'; url: string; headers: { Authorization: string } }> {
    if (this.server || this.closed) throw Error('The broker endpoint cannot start again.')
    this.broker.beginTurn(this.turnId)
    const server = this.server = createServer((req, res) => { void this.handle(req, res) })
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 8
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      this.port = (server.address() as { port: number }).port
      return { type: 'http', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.token}` } }
    } catch { this.stop(); throw Error('The private broker endpoint could not start.') }
  }
  stop(): void {
    if (this.closed) return
    this.closed = true; this.broker.stop()
    for (const transport of this.transports) void transport.close().catch(() => {})
    this.transports.clear()
    this.server?.closeAllConnections(); this.server?.close()
  }
  finishTurn(): void {
    if (this.closed) throw Error('The broker endpoint has stopped.')
    this.broker.endTurn(this.turnId)
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refuse = (status: number): void => { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('Broker request refused.'); req.resume() }
    if (this.closed) { refuse(503); return }
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${this.port}` || req.url !== '/mcp') { refuse(403); return }
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { refuse(401); return }
    if (req.method !== 'POST') { refuse(405); return }
    if (this.active >= 4 || ++this.requests > 1000) { refuse(429); return }
    if (!req.headers['content-type']?.startsWith('application/json')) { refuse(415); return }
    this.active++
    let mcp: Server | undefined
    try {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 256 * 1024) { refuse(413); return }
        chunks.push(Buffer.from(chunk))
      }
      let body: any
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { refuse(400); return }
      if (!body || Array.isArray(body) || !['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(body.method)) { refuse(400); return }
      if (body.method === 'tools/call' && typeof body.params?.name === 'string' && this.onAbandoned) {
        const tool = String(body.params.name).slice(0, 80), started = Date.now()
        res.once('close', () => { if (!res.writableFinished && !this.closed) { try { this.onAbandoned!(tool, Date.now() - started) } catch {} } })
      }
      mcp = new Server({ name: 'damon-broker', version: '1.0.0' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.broker.definitions().map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as { type: 'object' } })) }))
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const name = request.params.name, args = request.params.arguments ?? {}
        const call = this.broker.dispatch({ sessionId: this.sessionId, turnId: this.turnId, callId: `mcp:${typeof extra.requestId}:${extra.requestId}`, tool: name, arguments: args })
        const ms = this.broker.answerWithinMs(name, args)
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<BrokerResult>(resolve => { timer = setTimeout(() => resolve(this.broker.late(name, ms)), ms) })
        const result = await Promise.race([call, late]).finally(() => clearTimeout(timer))
        return mcpContent(result)
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      this.transports.add(mcp)
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch { if (!res.headersSent) refuse(500); else res.end() }
    finally { this.active--; if (mcp) { this.transports.delete(mcp); await mcp.close().catch(() => {}) } }
  }
}

function mcpImage(imageUrl: string): { type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string } {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(imageUrl)
  return m ? { type: 'image', data: m[2]!, mimeType: m[1]! } : { type: 'text', text: 'A picture could not be handed over.' }
}
export function mcpContent(result: BrokerResult): { isError: boolean; content: ({ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string })[] } {
  return { isError: !result.success, content: result.contentItems.map(item => item.type === 'inputImage' ? mcpImage(item.imageUrl) : { type: 'text' as const, text: item.text }) }
}
