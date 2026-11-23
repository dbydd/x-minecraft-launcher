import type { AgentControlHost } from './session'

const PROTOCOL_VERSION = '2025-03-26'

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

export function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export async function handleMcpMessage(
  host: AgentControlHost,
  message: JsonRpcRequest,
  token?: string,
) {
  if (
    !message ||
    typeof message !== 'object' ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string'
  ) {
    return { status: 400, body: rpcError(message?.id ?? null, -32600, 'Invalid Request') }
  }
  if (message.id === undefined) return { status: 202, body: undefined }
  if (message.method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'xmcl-agent-control', version: '1' },
        instructions:
          'Poll task_status. This server does not push events or open UI confirmations. Point the client at the Streamable HTTP URL. A remote client must tunnel to that URL; it is not assumed to reach localhost.',
      }),
    }
  }
  if (message.method === 'ping') return { status: 200, body: rpcResult(message.id, {}) }
  if (message.method === 'tools/list') {
    return { status: 200, body: rpcResult(message.id, { tools: host.toolList() }) }
  }
  if (message.method === 'tools/call') {
    const params = message.params as { name?: string; arguments?: unknown } | undefined
    const name = typeof params?.name === 'string' ? params.name : ''
    const result = await host.call(name, params?.arguments ?? {}, token)
    return {
      status: 200,
      body: rpcResult(message.id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: !result.ok,
      }),
    }
  }
  return { status: 200, body: rpcError(message.id, -32601, 'Method not found') }
}

export function bearerToken(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header
  if (!value?.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length).trim()
}
