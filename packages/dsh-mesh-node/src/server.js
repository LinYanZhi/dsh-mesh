import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { MESH_VERSION, verifyBearer, createConfigLoader, createSecretsLoader, meshHome, addInboundToken, peerAclForToken } from './core/config.js'
import { makeAudit, auditPath } from './core/audit.js'
import { JobRunner } from './core/jobs.js'
import { loadTlsMaterial, describeCert } from './core/tls.js'
import { claimPairingCode, readPairingState } from './core/pairing.js'
import { dispatch, isAllowed, applyPeerAcl, registerTools, toolNames } from './tools/index.js'

const NODE_STARTED_AT = new Date().toISOString()

const INSTRUCTIONS = `This endpoint is a dsh-mesh node: another developer machine exposed over the Model Context Protocol.
Call mesh_self first to learn what the peer can do and which tools your token may use.
All paths are paths on the PEER machine, not on yours.
Long operations: use task_submit (with an idem key) then poll task_status, instead of risking a call timeout.
shell_run is opt-in and normally refused.`

/** Carries the authenticated token id down into the per-request MCP server factory. */
const requestScope = new AsyncLocalStorage()

export function buildMcpServer({ ctx, log = console }) {
  const config = ctx.getConfig()
  const server = new McpServer(
    { name: `dsh-mesh/${config.node?.name || 'local'}`, version: MESH_VERSION },
    { instructions: INSTRUCTIONS }
  )
  registerTools(server, ctx)
  return server
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(text)
}

/** Read a small JSON body (pairing requests are tiny; anything huge is a mistake). */
function readJsonBody(req, limitBytes = 8192) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        rejectPromise(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim()
      if (text === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(new Error('body is not valid JSON'))
      }
    })
    req.on('error', rejectPromise)
  })
}

/** Peer ids double as token ids; keep them filename/log friendly. */
function sanitizePeerId(raw) {
  const id = String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
  return id === '' ? null : id
}

/**
 * Start the mesh HTTP endpoint.
 * @param {object} opts
 * @param {object} [opts.config] Fixed config (tests). Omit to load and hot-reload from disk.
 * @param {object} opts.secrets Inbound tokens.
 * @param {string} [opts.home] Mesh home directory (defaults to ~/.dsh-mesh).
 */
export async function startMeshServer({ config, secrets, log = console, port, bind, tls, home } = {}) {
  const meshHomeDir = home || meshHome()
  const getConfig = config ? () => config : createConfigLoader({ home: meshHomeDir, log })
  // Secrets hot-reload too: rotating a token takes effect without a restart.
  const getSecrets = secrets ? () => secrets : createSecretsLoader({ home: meshHomeDir, log })
  const audit = makeAudit({ home: meshHomeDir, log })

  const initial = getConfig()
  const jobs = new JobRunner({
    home: meshHomeDir,
    audit,
    log,
    limits: initial.limits || {},
    exec: (tool, args, opts) => dispatch(ctx, tool, args, opts)
  })

  // Shared context. `peerId` is filled per request from the verified bearer token.
  const ctx = {
    home: meshHomeDir,
    secrets,
    getSecrets,
    log,
    audit,
    jobs,
    getConfig,
    isAllowed,
    toolNames: () => toolNames(ctx),
    dispatch: (name, args, opts) => dispatch(ctx, name, args, opts)
  }

  const nodeCfg = initial.node || {}
  const listenPort = port ?? nodeCfg.port ?? 8124
  const listenBind = bind ?? nodeCfg.bind ?? '127.0.0.1'
  const mcpPath = nodeCfg.path || '/mcp'
  const tlsCfg = tls ?? nodeCfg.tls ?? { enabled: false }

  let calls = 0
  const mcpHandler = createMcpHandler(
    () => {
      const scope = requestScope.getStore()
      const peerAcl = scope?.peerAcl || null
      return buildMcpServer({
        ctx: {
          ...ctx,
          peerId: scope?.tokenId,
          peerAcl,
          getConfig: () => applyPeerAcl(getConfig(), peerAcl)
        },
        log
      })
    },
    { onerror: (error) => log?.error?.(`[dsh-mesh] handler error: ${error?.message || error}`) }
  )
  const nodeHandler = toNodeHandler(mcpHandler)

  const requestListener = async (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url, 'http://mesh.local').pathname
    } catch {
      /* malformed URL falls through to 404 */
    }

    if (pathname === '/health') {
      const liveConfig = getConfig()
      const pairingState = readPairingState(meshHomeDir)
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-mesh',
        version: MESH_VERSION,
        node: liveConfig.node?.name || 'local',
        /** Local DSH instances this node can bridge to (cluster addressing: <node>:<instance>). */
        hosts: (liveConfig.hosts || []).map((entry) => ({
          id: entry.id,
          url: entry.url,
          enabled: entry.enabled !== false
        })),
        uptimeSec: Math.round((Date.now() - Date.parse(NODE_STARTED_AT)) / 1000),
        pid: process.pid,
        startedAt: NODE_STARTED_AT,
        tools: toolNames(ctx).length,
        jobs: jobs.stats(),
        tls: tlsCfg?.enabled === true,
        pairing: {
          enabled: liveConfig.pairing?.enabled === true,
          codeActive: Boolean(pairingState && !pairingState.used && !pairingState.expired),
          expiresAt: pairingState?.expiresAt ?? null
        },
        now: new Date().toISOString()
      })
      return
    }

    // Unauthenticated by design: a peer has no token yet, it redeems a one-time code instead.
    if (pathname === '/pair') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'E_INVALID_ARG', message: 'use POST /pair' }, { allow: 'POST' })
        return
      }
      const liveConfig = getConfig()
      if (liveConfig.pairing?.enabled !== true) {
        sendJson(res, 403, { code: 'E_DENIED', message: 'pairing is disabled on this node' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { code: 'E_INVALID_ARG', message: error?.message || 'bad body' })
        return
      }
      const claim = claimPairingCode({
        home: meshHomeDir,
        code: body?.code,
        maxAttempts: Number(liveConfig.pairing?.maxAttempts) || 5
      })
      if (!claim.ok) {
        // Small constant delay so the answer time does not reveal much; never say why.
        await new Promise((r) => setTimeout(r, 200))
        await audit({ peer: 'pair', tool: 'pair', ok: false, code: claim.reason, args: ['code'] })
        sendJson(
          res,
          401,
          {
            code: claim.reason === 'E_MAX_ATTEMPTS' ? 'E_MAX_ATTEMPTS' : 'E_AUTH',
            message: 'pairing code rejected',
            retryable: claim.reason !== 'E_MAX_ATTEMPTS' && claim.reason !== 'E_CODE_USED'
          },
          { 'www-authenticate': 'Bearer realm="dsh-mesh"' }
        )
        return
      }
      const baseId = sanitizePeerId(body?.peerName) || `peer-${Date.now().toString(36)}`
      let created
      try {
        created = addInboundToken({
          home: meshHomeDir,
          id: baseId,
          note: `paired ${new Date().toISOString()}`,
          acl: body?.acl
        })
      } catch {
        created = addInboundToken({
          home: meshHomeDir,
          id: `${baseId}-${Math.random().toString(36).slice(2, 6)}`,
          note: `paired ${new Date().toISOString()}`,
          acl: body?.acl
        })
      }
      await audit({ peer: created.id, tool: 'pair', ok: true, args: ['code', 'peerName'] })
      const scheme = tlsCfg?.enabled === true ? 'https' : 'http'
      const address = httpServer.address()
      const actualPort = typeof address === 'object' && address ? address.port : listenPort
      sendJson(res, 200, {
        ok: true,
        token: created.token,
        tokenId: created.id,
        node: liveConfig.node?.name || 'local',
        version: MESH_VERSION,
        url: `${scheme}://${listenBind}:${actualPort}${mcpPath}`,
        certFingerprint: tlsCfg?.enabled === true ? describeCert(meshHomeDir)?.fingerprint256 ?? null : null,
        tools: toolNames(ctx).length
      })
      return
    }

    if (pathname !== mcpPath) {
      sendJson(res, 404, { code: 'E_NOT_FOUND', message: `no route for ${pathname}`, mcpEndpoint: mcpPath })
      return
    }

    const secretsNow = getSecrets()
    const tokenId = verifyBearer(req, secretsNow)
    if (!tokenId) {
      sendJson(
        res,
        401,
        { code: 'E_AUTH', message: 'missing or invalid bearer token' },
        { 'www-authenticate': 'Bearer realm="dsh-mesh"' }
      )
      return
    }
    const peerAcl = peerAclForToken(secretsNow, tokenId)

    calls += 1
    const started = Date.now()
    res.on('close', () => {
      log?.debug?.(`[dsh-mesh] ${req.method} ${pathname} token=${tokenId} ${res.statusCode} ${Date.now() - started}ms`)
    })

    try {
      await requestScope.run({ tokenId, peerAcl }, () => nodeHandler(req, res))
    } catch (error) {
      log?.error?.(`[dsh-mesh] transport failure: ${error?.message || error}`)
      if (!res.headersSent) sendJson(res, 500, { code: 'E_INTERNAL', message: 'transport failure' })
    }
  }

  const httpServer =
    tlsCfg?.enabled === true
      ? createHttpsServer(loadTlsMaterial({ home: meshHomeDir, cert: tlsCfg.cert, key: tlsCfg.key }), requestListener)
      : createHttpServer(requestListener)

  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise)
    httpServer.listen(listenPort, listenBind, () => {
      httpServer.off('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = httpServer.address()
  const actualPort = typeof address === 'object' && address ? address.port : listenPort
  const scheme = tlsCfg?.enabled === true ? 'https' : 'http'
  const url = `${scheme}://${listenBind}:${actualPort}${mcpPath}`

  return {
    port: actualPort,
    url,
    httpServer,
    ctx,
    auditPath: auditPath(meshHomeDir),
    get requestCount() {
      return calls
    },
    close() {
      return new Promise((resolvePromise) => httpServer.close(() => resolvePromise()))
    }
  }
}
