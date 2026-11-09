/**
 * Outbound peer client (M7 step 4: cluster_exec).
 *
 * `cluster_status` only probes peers over /health; this module is what lets a
 * node ACT on a paired peer — call one MCP tool on the other machine. The trust
 * model stays TOFU: the peer's stored certificate pin is checked on EVERY https
 * connection (we cannot rely on NODE_EXTRA_CA_CERTS at runtime), so a changed
 * certificate fails loudly instead of silently accepting a new one.
 *
 * The MCP SDK's transport takes a `fetch` option; we supply a small node:https
 * based implementation because Node's global fetch cannot talk to a self-signed
 * peer without adding its CA to the process trust store.
 */
import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { MESH_VERSION } from './config.js'
import { assertFingerprint, fingerprintOfSocket, normalizeFingerprint } from './tls.js'

const DEFAULT_TIMEOUT_MS = 30000

export function peerError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** `https://host:port/mcp` -> `https://host:port` (peer records store the base URL). */
export function baseUrlOf(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/mcp$/, '')
}

/**
 * Read the piece of a `mesh-peer pair` output file that mesh needs to call the
 * peer: the bearer token and base URL live in the generated DSH overlay (the
 * `<name>.json` metadata intentionally has no token). Also accepts the metadata
 * file for URL/fingerprint hints.
 */
export function parsePeerOverlay(text, { meta = null } = {}) {
  const source = String(text || '')
  const tokenMatch = source.match(/Authorization:\s*['"]?Bearer\s+([A-Za-z0-9._~+/=-]+)['"]?/)
  const token = tokenMatch ? tokenMatch[1] : ''
  if (!token) {
    throw peerError('E_INVALID_ARG', 'no Bearer token found — pass the <name>.yml overlay written by `mesh-peer pair`')
  }
  const urlMatch = source.match(/^\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/m)
  const nameMatch = source.match(/^\s*serverName:\s*['"]?([^'"\s]+)['"]?\s*$/m)
  const rawUrl = meta?.url || (urlMatch ? urlMatch[1] : '')
  if (!rawUrl) throw peerError('E_INVALID_ARG', 'no peer url found — pass --url or the <name>.json metadata')
  const fallbackName = meta?.node || ''
  const serverName = nameMatch ? nameMatch[1] : ''
  const suggestedName = String(fallbackName || serverName || 'peer')
    .replace(/-mesh$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 40)
  const certFingerprint = meta?.certFingerprint || null
  return {
    token,
    url: baseUrlOf(rawUrl),
    tokenId: meta?.tokenId || suggestedName,
    certFingerprint,
    suggestedName
  }
}

/**
 * node:https implementation of the WHATWG fetch subset the MCP transport needs.
 * TLS verification is replaced by the stored pin: `rejectUnauthorized:false` is
 * only acceptable because the socket certificate is compared to the pin before
 * a single byte of the response is handed to the SDK.
 */
export function makePinnedFetch({ certFingerprint, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const expected = certFingerprint ? normalizeFingerprint(certFingerprint) : null
  // No TLS session caching: a resumed session would skip the certificate check.
  const pinnedAgent = new HttpsAgent({ keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: false })

  return function pinnedFetch(input, init = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      let url
      try {
        url = new URL(String(input))
      } catch {
        rejectPromise(peerError('E_INVALID_ARG', `invalid peer url: ${input}`))
        return
      }
      const secure = url.protocol === 'https:'
      if (secure && !expected) {
        rejectPromise(peerError('E_PEER_NO_PIN', 'refusing to talk to an https peer without a stored certificate fingerprint'))
        return
      }
      const body = init.body
      // The SDK passes a Headers instance; spreading it would silently drop every
      // header (including Authorization) because Headers is not enumerable.
      const rawHeaders = init.headers
      const headers =
        typeof Headers !== 'undefined' && rawHeaders instanceof Headers
          ? Object.fromEntries(rawHeaders.entries())
          : Array.isArray(rawHeaders)
            ? Object.fromEntries(rawHeaders)
            : { ...(rawHeaders || {}) }
      const request = (secure ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: init.method || 'GET',
          headers,
          ...(secure ? { rejectUnauthorized: false, agent: pinnedAgent } : {}),
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode || 0
          const stream = new ReadableStream({
            start(controller) {
              res.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)))
              res.on('end', () => controller.close())
              res.on('error', (error) => controller.error(error))
            }
          })
          if (status === 204 || status === 304) {
            res.resume()
            resolvePromise(new Response(null, { status, statusText: res.statusMessage || '' }))
            return
          }
          resolvePromise(new Response(stream, { status, statusText: res.statusMessage || '', headers: res.headers }))
        }
      )
      if (secure) {
        // Verify the pin at handshake time. Checking it on the response is too late
        // and unreliable: by then the socket may already be destroyed/kept alive.
        request.on('socket', (socket) => {
          const verify = () => {
            try {
              assertFingerprint(expected, fingerprintOfSocket(socket))
            } catch (error) {
              request.destroy(
                peerError('E_PEER_PIN_MISMATCH', `peer certificate does not match the stored fingerprint (${error?.code || 'unknown'})`, {
                  cause: error
                })
              )
            }
          }
          if (socket.connecting || socket.secureConnecting) socket.once('secureConnect', verify)
          else verify()
        })
      }
      request.on('timeout', () => request.destroy(peerError('E_PEER_TIMEOUT', `peer did not answer within ${timeoutMs} ms`)))
      request.on('error', (error) => rejectPromise(error))
      if (init.signal) {
        if (init.signal.aborted) {
          request.destroy(peerError('E_PEER_ABORTED', 'request aborted'))
          return
        }
        init.signal.addEventListener('abort', () => request.destroy(peerError('E_PEER_ABORTED', 'request aborted')), { once: true })
      }
      if (body !== undefined && body !== null) {
        if (typeof body === 'string' || body instanceof Uint8Array || body instanceof URLSearchParams) request.write(body)
        else if (body instanceof ArrayBuffer) request.write(new Uint8Array(body))
        else request.write(String(body))
      }
      request.end()
    })
  }
}

/** Close a client + transport pair; the connection is already unusable if this fails. */
async function closeConnection(client, transport) {
  try {
    await client.close()
  } catch {
    /* already closed */
  }
  try {
    await transport.close?.()
  } catch {
    /* already closed */
  }
}

/**
 * Keep the peer's own error code (E_PEER_PIN_MISMATCH and friends) so callers can
 * react per failure mode; only map the transport's HTTP 401 to E_PEER_AUTH.
 */
function peerFailureCode(error, fallback) {
  const message = error?.message || String(error)
  const ownCode = typeof error?.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : null
  return ownCode || (/401|unauthori[sz]ed/i.test(message) ? 'E_PEER_AUTH' : fallback)
}

/**
 * Open a pinned MCP connection to a paired peer and keep it for several calls
 * (tools/list followed by tools/call). TLS trust comes from the stored pin, not
 * from NODE_EXTRA_CA_CERTS, so this works in any process — including a stdio
 * bridge child that DSH spawned with a scrubbed environment. The caller owns
 * `close()`.
 */
export async function connectPeer(peer, { timeoutMs = DEFAULT_TIMEOUT_MS, clientName = 'dsh-mesh-peer' } = {}) {
  const name = String(peer?.name || peer?.id || 'peer')
  if (!peer?.url) throw peerError('E_INVALID_ARG', `peer "${name}" has no url`)
  if (!peer?.token) throw peerError('E_PEER_NO_TOKEN', `peer "${name}" has no outbound token — run \`node src/cli.js peer import --file <name>.yml\``)
  const endpoint = `${baseUrlOf(peer.url)}/mcp`
  const client = new Client({ name: clientName, version: MESH_VERSION })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: makePinnedFetch({ certFingerprint: peer.certFingerprint, timeoutMs }),
    requestInit: { headers: { Authorization: `Bearer ${peer.token}` } }
  })
  try {
    await client.connect(transport)
  } catch (error) {
    await closeConnection(client, transport)
    throw error
  }
  return { peer: name, client, transport, close: () => closeConnection(client, transport) }
}

/**
 * Call one tool on a paired peer. `peer` = {name, url, token, certFingerprint}
 * (as stored by `peer import`). Returns a compact result — never the token.
 */
export async function callPeerTool(peer, { tool, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const name = String(peer?.name || peer?.id || 'peer')
  const started = Date.now()
  let connection
  try {
    connection = await connectPeer(peer, { timeoutMs, clientName: 'dsh-mesh-cluster-exec' })
    const result = await connection.client.callTool({ name: tool, arguments: args })
    return {
      peer: name,
      tool,
      ok: result?.isError !== true,
      ms: Date.now() - started,
      result
    }
  } catch (error) {
    const message = error?.message || String(error)
    throw peerError(peerFailureCode(error, 'E_PEER_CALL_FAILED'), `peer "${name}" tool "${tool}" failed: ${message}`)
  } finally {
    if (connection) await connection.close()
  }
}

/**
 * List the tools a paired peer exposes (same pinned transport as callPeerTool).
 * Used by `peer tools`/`peer call` and by the stdio bridge, which republishes
 * this list locally so the tool surface stays in sync with the peer.
 */
export async function listPeerTools(peer, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const name = String(peer?.name || peer?.id || 'peer')
  const started = Date.now()
  let connection
  try {
    connection = await connectPeer(peer, { timeoutMs, clientName: 'dsh-mesh-peer-tools' })
    const listed = await connection.client.listTools()
    const tools = listed?.tools ?? []
    return {
      peer: name,
      ok: true,
      ms: Date.now() - started,
      count: tools.length,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description || '' }))
    }
  } catch (error) {
    throw peerError(peerFailureCode(error, 'E_PEER_CALL_FAILED'), `peer "${name}" tools/list failed: ${error?.message || error}`)
  } finally {
    if (connection) await connection.close()
  }
}
