/**
 * Stdio MCP bridge to a paired peer.
 *
 * Why this exists: the overlay from `peer patch` uses the streamable-http
 * transport, so a self-signed peer only works when the DSH process itself has
 * the peer certificate in NODE_EXTRA_CA_CERTS. When that env is missing (or the
 * overlay was written after the process started), the mcp-client reports only
 * "server is disconnected" and the model never sees a single tool — a silent
 * failure that cost a full debugging session on 2026-10-20.
 *
 * This bridge is launched by DSH as a stdio child. It performs the pinned TLS
 * handshake itself (see core/peer-client.js), so the DSH process needs no CA
 * trust store, and a dead peer becomes a visible child exit that the client's
 * reconnect policy handles instead of an unexplained disconnected server.
 *
 * Wire it with `node src/cli.js peer patch --transport stdio`, then restart the
 * DSH instance so the overlay entry is loaded (overlays are read at boot).
 */
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { MESH_VERSION } from './core/config.js'
import { connectPeer } from './core/peer-client.js'

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} }

/**
 * Peer tool JSON Schema -> the Standard Schema that McpServer.registerTool
 * accepts. Tools with no arguments (or a non-object schema) get an empty
 * object schema: passing a schema the SDK cannot convert would otherwise drop
 * the tool entirely.
 */
export function toToolInputSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || inputSchema.type !== 'object') {
    return fromJsonSchema(EMPTY_OBJECT_SCHEMA)
  }
  const properties = inputSchema.properties
  if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
    return fromJsonSchema(EMPTY_OBJECT_SCHEMA)
  }
  return fromJsonSchema(inputSchema)
}

/**
 * Start the stdio bridge and resolve once it is serving.
 *
 * @param peer - paired peer record {name, url, token, certFingerprint}.
 * @param options.serverName - local MCP namespace (DSH shows `mcp__<serverName>__*`).
 * @param options.timeoutMs - per MCP request timeout for calls to the peer.
 * @param options.log - logger; MUST write to stderr, stdout carries the protocol.
 * @returns handles for tests plus the proxied/skipped tool names.
 */
export async function runPeerBridge(peer, { serverName, timeoutMs = 120000, log = console } = {}) {
  const name = String(peer?.name || peer?.id || 'peer')
  const namespace = String(serverName || `dsh-mesh-${name}`)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 32)
  const connection = await connectPeer(peer, { timeoutMs, clientName: 'dsh-mesh-peer-bridge' })
  let listed
  try {
    listed = await connection.client.listTools()
  } catch (error) {
    await connection.close()
    throw error
  }
  const peerTools = listed?.tools ?? []
  const server = new McpServer(
    { name: namespace, version: MESH_VERSION },
    {
      instructions: `Tools proxied from dsh-mesh peer "${name}" (${peer.url}). This process pins the peer certificate itself, so it does not depend on NODE_EXTRA_CA_CERTS in the DSH process.`
    }
  )
  const skipped = []
  for (const tool of peerTools) {
    let inputSchema
    try {
      inputSchema = toToolInputSchema(tool.inputSchema)
    } catch (error) {
      skipped.push({ tool: tool.name, reason: error?.message || String(error) })
      continue
    }
    server.registerTool(
      tool.name,
      { description: tool.description || `proxied dsh-mesh tool ${tool.name}`, inputSchema },
      async (args) => {
        try {
          return await connection.client.callTool({ name: tool.name, arguments: args ?? {} })
        } catch (error) {
          const code = typeof error?.code === 'string' ? `[${error.code}] ` : ''
          return {
            content: [{ type: 'text', text: `peer bridge call failed: ${code}${error?.message || error}` }],
            isError: true
          }
        }
      }
    )
  }

  const transport = new StdioServerTransport()
  let closing = false
  const close = async (reason) => {
    if (closing) return
    closing = true
    log.error?.(`[peer-bridge] ${reason} — exiting`)
    try {
      await server.close()
    } catch {
      /* already closed */
    }
    await connection.close()
    // The bridge is a child of DSH: never linger after the pipe is gone.
    process.exit(0)
  }
  transport.onclose = () => {
    void close('stdio closed by the DSH client')
  }
  connection.client.onclose = () => {
    void close('peer connection dropped')
  }
  await server.connect(transport)
  log.error?.(
    `[peer-bridge] peer="${name}" serverName="${namespace}" tools=${peerTools.length}${skipped.length ? ` skipped=${skipped.length}` : ''}`
  )
  return { server, connection, namespace, toolCount: peerTools.length, skipped }
}
