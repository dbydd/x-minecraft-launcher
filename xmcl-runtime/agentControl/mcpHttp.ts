import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { agentError, failure } from '@xmcl/runtime-api'
import { agentCommands } from './registry'
import type { AgentControlHost } from './session'

export interface AgentControlEndpoint {
  url: string
  port: number
  close(): Promise<void>
}

const requestAuth = new AsyncLocalStorage<{ token?: string }>()

function bearer(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header
  if (!value?.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length).trim()
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function createAgentMcpServer(host: AgentControlHost, token?: string) {
  const server = new McpServer({ name: 'xmcl-agent-control', version: '1' })
  for (const command of agentCommands) {
    server.registerTool(
      command.name,
      {
        description: command.description,
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        const result = await host.call(command.name, args, requestAuth.getStore()?.token ?? token)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
          isError: !result.ok,
        }
      },
    )
  }
  return server
}

/**
 * Official MCP Streamable HTTP transport. JSON responses are enabled because
 * this server does not push. Host and Origin checks are the SDK's DNS-rebinding
 * guard. Pairing stays on POST /pair and is not an MCP tool.
 */
export function startAgentControlHttp(
  host: AgentControlHost,
  options: {
    host?: string
    port?: number
    onSession?: (snapshot: ReturnType<AgentControlHost['exportSnapshot']>) => void | Promise<void>
  } = {},
): Promise<AgentControlEndpoint> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const hostname = options.host ?? '127.0.0.1'
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${hostname}`)
      if (request.method === 'POST' && url.pathname === '/pair') {
        const body = JSON.parse((await readBody(request)) || '{}') as { code?: string }
        const paired = await host.pair(typeof body.code === 'string' ? body.code : '')
        if (paired.ok) await options.onSession?.(host.exportSnapshot())
        const payload = JSON.stringify(paired)
        response.writeHead(paired.ok ? 200 : 401, { 'content-type': 'application/json' })
        response.end(payload)
        return
      }
      if (url.pathname !== '/mcp') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(failure(agentError('not_found', 'Not found', { retryable: false }))),
        )
        return
      }
      const raw = request.method === 'POST' ? await readBody(request) : undefined
      const parsed = raw ? JSON.parse(raw || 'null') : undefined
      const header = request.headers['mcp-session-id']
      const sessionId = typeof header === 'string' ? header : undefined
      let transport = sessionId ? sessions.get(sessionId) : undefined
      if (!transport && request.method === 'POST' && isInitializeRequest(parsed)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts: [`${hostname}:${boundPort()}`, `localhost:${boundPort()}`],
          allowedOrigins: [`http://${hostname}:${boundPort()}`, `http://localhost:${boundPort()}`],
          onsessioninitialized: (id) => {
            if (transport) sessions.set(id, transport)
          },
          onsessionclosed: (id) => {
            sessions.delete(id)
          },
        })
        await createAgentMcpServer(host).connect(transport)
      }
      if (!transport) {
        response.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'MCP session was not initialized' },
          }),
        )
        return
      }
      await requestAuth.run({ token: bearer(request.headers.authorization) }, () =>
        transport.handleRequest(request, response, parsed),
      )
      if (request.method === 'POST' && !isInitializeRequest(parsed))
        await options.onSession?.(host.exportSnapshot())
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: error instanceof Error ? error.message : 'Parse error',
            },
          }),
        )
      }
    }
  })

  function boundPort() {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : (options.port ?? 0)
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, hostname, () => {
      const port = boundPort()
      resolve({
        url: `http://${hostname}:${port}/mcp`,
        port,
        close: () =>
          new Promise((done, fail) => {
            for (const transport of sessions.values()) void transport.close()
            server.close((error) => (error ? fail(error) : done()))
          }),
      })
    })
  })
}
