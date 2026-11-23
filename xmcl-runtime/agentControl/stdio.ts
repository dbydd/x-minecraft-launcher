import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createAgentMcpServer } from './mcpHttp'
import type { AgentControlHost } from './session'

/**
 * Optional stdio transport for a client that can spawn a process here.
 * Remote clients that cannot spawn a process use Streamable HTTP.
 */
export async function serveAgentControlStdio(
  host: AgentControlHost,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  token?: string,
) {
  const server = createAgentMcpServer(host, token)
  const transport = new StdioServerTransport(input as never, output as never)
  await server.connect(transport)
  return () => transport.close()
}
