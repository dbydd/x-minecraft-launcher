import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { agentError, failure } from '@xmcl/runtime-api'
import { bearerToken, handleMcpMessage, type JsonRpcRequest } from './mcpProtocol'
import type { AgentControlHost } from './session'

export interface AgentControlEndpoint {
  url: string
  port: number
  close(): Promise<void>
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
    ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
  })
  response.end(payload)
}

/**
 * MCP Streamable HTTP. Single JSON responses are used because this server
 * does not push; clients poll task_status. GET /mcp is 405 for that reason.
 * The listener defaults to loopback. A remote closed client needs a tunnel
 * or other reachable forwarder to this URL.
 */
export function startAgentControlHttp(
  host: AgentControlHost,
  options: {
    host?: string
    port?: number
    onSession?: (snapshot: ReturnType<AgentControlHost['exportSnapshot']>) => void | Promise<void>
  } = {},
): Promise<AgentControlEndpoint> {
  const sessions = new Set<string>()
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/pair') {
        const body = JSON.parse((await readBody(request)) || '{}') as { code?: string }
        const paired = await host.pair(typeof body.code === 'string' ? body.code : '')
        if (paired.ok) await options.onSession?.(host.exportSnapshot())
        send(response, paired.ok ? 200 : 401, paired)
        return
      }
      if (url.pathname !== '/mcp') {
        send(response, 404, failure(agentError('not_found', 'Not found', { retryable: false })))
        return
      }
      if (request.method === 'GET') {
        send(response, 405, rpcMethod('Server does not push events; poll task_status'))
        return
      }
      if (request.method === 'DELETE') {
        const id = request.headers['mcp-session-id']
        if (typeof id === 'string') sessions.delete(id)
        response.writeHead(204)
        response.end()
        return
      }
      if (request.method !== 'POST') {
        send(response, 405, rpcMethod('Method not allowed'))
        return
      }
      const accept = request.headers.accept ?? ''
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        send(response, 406, rpcMethod('Accept must include application/json and text/event-stream'))
        return
      }
      const message = JSON.parse((await readBody(request)) || 'null') as JsonRpcRequest
      const existing = request.headers['mcp-session-id']
      let sessionId = typeof existing === 'string' ? existing : undefined
      if (message.method !== 'initialize') {
        if (!sessionId || !sessions.has(sessionId)) {
          send(response, 404, rpcMethod('MCP session was not initialized'))
          return
        }
      }
      const handled = await handleMcpMessage(
        host,
        message,
        bearerToken(request.headers.authorization),
      )
      if (message.method === 'tools/call') await options.onSession?.(host.exportSnapshot())
      if (message.method === 'initialize' && handled.status === 200) {
        sessionId = randomUUID()
        sessions.add(sessionId)
      }
      send(response, handled.status, handled.body, sessionId ? { 'mcp-session-id': sessionId } : {})
    } catch (error) {
      send(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' },
      })
    }
  })

  const hostname = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : port
      resolve({
        url: `http://${hostname}:${bound}/mcp`,
        port: bound,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      })
    })
  })
}

function rpcMethod(message: string) {
  return { jsonrpc: '2.0', id: null, error: { code: -32600, message } }
}
