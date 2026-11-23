import { bearerToken, handleMcpMessage, type JsonRpcRequest } from './mcpProtocol'
import type { AgentControlHost } from './session'

/**
 * Optional MCP stdio transport for a client that can spawn a process on this
 * machine. Frames are LSP-style Content-Length messages. Remote clients that
 * cannot spawn a process should use Streamable HTTP instead.
 */
export function serveAgentControlStdio(
  host: AgentControlHost,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  token?: string,
) {
  let buffer = Buffer.alloc(0)
  const onData = (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const body = buffer.subarray(start, start + length).toString('utf8')
      buffer = buffer.subarray(start + length)
      void dispatch(body)
    }
  }
  async function dispatch(body: string) {
    let message: JsonRpcRequest
    try {
      message = JSON.parse(body) as JsonRpcRequest
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const handled = await handleMcpMessage(host, message, token ?? bearerToken(undefined))
    if (handled.body !== undefined) write(handled.body)
  }
  function write(payload: unknown) {
    const json = JSON.stringify(payload)
    output.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
  }
  input.on('data', onData)
  return () => input.off('data', onData)
}
