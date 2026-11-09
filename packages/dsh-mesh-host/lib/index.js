/**
 * dsh-mesh-host — DSH host-side bridge for dsh-mesh.
 *
 * Runs *inside* the DSH host process (as a cordis/DSH plugin) and exposes the
 * in-process `agents` + `tools` services over a loopback-only HTTP endpoint.
 * The standalone dsh-mesh MCP server proxies to this bridge, which is how a
 * remote peer can:
 *   - create a fresh Session (`/host/sessions/create` → sessionController.create)
 *   - prompt a Session without a web cookie (`/host/prompt`)
 *   - wake a live session (`/host/wake` → agent inbox + followup)
 *   - list host sessions and their status (`/host/agents`, `/host/sessions`)
 *   - list / call tools registered in *this* DSH instance (`/host/tools`,
 *     `/host/tools/call`)
 *
 * Session creation goes through the profile's `sessionController` service, the
 * same path the web UI uses (agent preset composition, cwd validation, default
 * model). Profiles that do not mount it answer 501 E_HOST_NO_CONTROLLER.
 *
 * Design constraints (deliberate):
 *   - plain ESM, **no imports from @deepseek-ai/*** so it loads from any
 *     profile without a workspace link; message objects are built locally
 *     (same shape as `createUserMessage`: `{ id, role:'user', content, source }`).
 *   - binds 127.0.0.1 only; every request needs a Bearer token from
 *     `<mesh home>/host-token` (auto-created 0600 on first load).
 *   - the HTTP server is `unref()`ed so a short-lived headless run can exit.
 */

import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform, release, arch } from 'node:os'
import { join, basename } from 'node:path'

/** Plugin identity used by the loader. */
export const name = 'dsh-mesh-host'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools', 'agents']

export const PLUGIN_VERSION = '0.4.0'
const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

function meshHome() {
  return process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
}

/**
 * Which DSH instance is this? `.dsh0` → 0, `.dsh1` → 1, anything else → 0.
 * Lets one plugin package serve several instances (9100/host-token, 9101/host-token-dsh1)
 * without every launcher having to set DSH_MESH_HOST_PORT / DSH_MESH_HOST_TOKEN_FILE.
 * Explicit env vars still win.
 */
function instanceIndex() {
  const match = /^\.dsh(\d+)$/u.exec(basename(process.env.DSH_HOME || ''))
  return match ? Number(match[1]) : 0
}

function hostTokenPath() {
  if (process.env.DSH_MESH_HOST_TOKEN_FILE) return process.env.DSH_MESH_HOST_TOKEN_FILE
  const index = instanceIndex()
  return join(meshHome(), index === 0 ? 'host-token' : `host-token-dsh${index}`)
}

/** Read the shared loopback token, creating it (0600) when missing. */
function ensureToken() {
  const path = hostTokenPath()
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* missing → create below */
  }
  mkdirSync(meshHome(), { recursive: true })
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  return token
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Recursively freeze a message the same way `createUserMessage` does. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Local stand-in for `createUserMessage` (avoids importing @deepseek-ai/*). */
function createUserMessage({ content, source }) {
  return deepFreeze(structuredClone({ role: 'user', content, source, id: randomUUID() }))
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', chunk => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const LOG_MAX_BYTES = 512 * 1024
const LOG_NAME_RE = /^[A-Za-z0-9._-]{1,80}\.log$/

/** Strip secrets DSH writes into its own logs (web token URLs / API keys / Bearer). */
function redactSecrets(text) {
  return String(text)
    .replace(/([?&]token=)[A-Za-z0-9._~-]{8,}/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]{8,}/gi, '$1***')
    .replace(/((?:api[_-]?key|deepseek_api_key|token)\s*[=:]\s*)[A-Za-z0-9._~-]{8,}/gi, '$1***')
    .replace(/(sk-)[A-Za-z0-9]{8,}/g, '$1***')
}

/**
 * Resolve one allow-listed log file: `<mesh home>/<name>.log` or
 * `<mesh home>/logs/<name>.log`. Plain file names only — no path separators —
 * so a remote peer can never read an arbitrary file through this route.
 */
function resolveLogPath(name) {
  const safe = String(name || '').trim()
  if (!LOG_NAME_RE.test(safe)) {
    throw Object.assign(new Error('name must be a plain *.log file name (no path separators)'), { code: 'E_INVALID_ARG' })
  }
  for (const candidate of [join(meshHome(), safe), join(meshHome(), 'logs', safe)]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  throw Object.assign(new Error(`log not found: ${safe}`), { code: 'E_NOT_FOUND' })
}

/** Tail a file without loading all of it (logs can be many MBs). */
function tailFile(path, lines) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - LOG_MAX_BYTES)
    const length = size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) readSync(fd, buffer, 0, length, start)
    const all = buffer.toString('utf8').split(/\r?\n/)
    const body = all.slice(Math.max(0, all.length - lines))
    return { sizeBytes: size, truncated: start > 0, lines: body.map((line) => redactSecrets(line)) }
  } finally {
    closeSync(fd)
  }
}

function normalizeToolList(schemas) {
  return (schemas || []).map(schema => ({
    name: schema?.name ?? '',
    description: schema?.description ?? '',
    parameters: schema?.parameters ?? null,
  }))
}

function serializeResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: true, value: result ?? null, content: [] }
  }
  if (result.isError === true) {
    const error = result.error ?? {}
    return {
      ok: false,
      code: error.code || 'E_HOST_TOOL',
      message: error.message || String(error) || 'host tool failed',
      content: result.content ?? [],
    }
  }
  return { ok: true, value: result.value ?? null, content: result.content ?? [] }
}

/**
 * Install the loopback bridge.
 * @param ctx - DSH host context with `tools` and `agents` injected.
 */
export function apply(ctx) {
  const token = ensureToken()
  const port = Number(process.env.DSH_MESH_HOST_PORT || 9100 + instanceIndex())
  const bind = process.env.DSH_MESH_HOST_BIND || '127.0.0.1'

  const authorized = req => {
    const header = req.headers.authorization || ''
    const match = /^Bearer\s+(.+)$/iu.exec(header)
    return Boolean(match) && safeEqual(match[1].trim(), token)
  }

  const listAgents = () => {
    let agents = []
    try {
      agents = ctx.agents?.list?.() ?? []
    } catch {
      agents = []
    }
    return agents.map(agent => ({
      id: String(agent?.id ?? ''),
      status: String(agent?.status ?? 'unknown'),
      title: typeof agent?.session?.title === 'string' ? agent.session.title : undefined,
      seq: typeof agent?.session?.seq === 'number' ? agent.session.seq : undefined,
      // Workspace/cwd is what makes delegation routing possible: a task that
      // belongs to a repo should land in a session already opened there.
      // DSH keeps the session cwd in the durable header (`session.header.cwd`).
      cwd: typeof agent?.session?.header?.cwd === 'string'
        ? agent.session.header.cwd
        : (typeof agent?.session?.cwd === 'string' ? agent.session.cwd : undefined),
    }))
  }

  const rawAgents = () => {
    try {
      return ctx.agents?.list?.() ?? []
    } catch {
      return []
    }
  }

  // Optional services: newer DSH composes sessionQuery (live + persisted
  // history); older forks only expose sessionPersistence or neither. Read them
  // through ctx.get so the bridge still loads on every profile.
  const optionalService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  // Session creation/prompting is the web UI's own service. Profiles older than
  // the session-controller split do not mount it; callers get an explicit 501
  // instead of a silent no-op.
  const sessionController = () => optionalService('sessionController')

  const requireSessionController = () => {
    const controller = sessionController()
    if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      throw Object.assign(new Error('this DSH profile mounts no sessionController service (session create/prompt unavailable)'), { code: 'E_HOST_NO_CONTROLLER' })
    }
    return controller
  }

  // Older forks can expose a session service whose list() never settles (or
  // blocks on a backend that is not mounted). Never let /host/sessions hang:
  // fall back to the live agents after a short budget.
  const withTimeout = (promise, ms, fallback) => {
    let timer
    return Promise.race([
      Promise.resolve(promise).then((value) => value, () => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      })
    ]).finally(() => clearTimeout(timer))
  }

  // Once an old fork's session service times out, remember it for this plugin
  // lifetime so later /host/sessions calls answer from live agents immediately.
  let sessionListingBroken = false

  const listSessions = async ({ limit = 50, includeEnded = true, workspace = '' } = {}) => {
    const agents = listAgents()
    const liveById = new Map(agents.map((agent) => [agent.id, agent]))
    const titles = new Map()
    let source = 'agents'
    let records = []
    const query = optionalService('sessionQuery')
    const agentRecords = () => agents.map((agent) => ({
      header: { id: agent.id, createdAt: 0, cwd: agent.cwd },
      live: true,
      persisted: false
    }))
    if (sessionListingBroken) {
      source = 'agentsFallback'
      records = agentRecords()
    } else if (query && typeof query.listSessions === 'function') {
      source = 'sessionQuery'
      const listed = await withTimeout(query.listSessions(), 2000, null)
      if (!listed) {
        sessionListingBroken = true
        source = 'agentsFallback'
        records = agentRecords()
      } else {
        records = (listed || []).map((record) => ({
          header: record.header,
          live: record.live === true,
          persisted: record.persisted === true
        }))
        const ids = records.map((record) => record.header?.id).filter(Boolean)
        if (typeof query.readTitleSnapshots === 'function' && ids.length > 0) {
          try {
            const observed = await withTimeout(query.readTitleSnapshots(ids), 8000, null)
            for (const item of observed || []) {
              if (item.status !== 'fulfilled') continue
              const title = item.value?.title?.title || item.value?.title?.text || ''
              if (title) titles.set(item.sessionId, { title, updatedAt: item.value?.title?.updatedAt || 0 })
            }
          } catch {
            /* title is best effort; listing still works without it */
          }
        }
      }
    } else {
      const persistence = optionalService('sessionPersistence')
      if (persistence && typeof persistence.list === 'function') {
        source = 'sessionPersistence'
        const snapshots = await withTimeout(persistence.list(), 2000, null)
        if (!snapshots) {
          sessionListingBroken = true
          source = 'agentsFallback'
          records = agentRecords()
        } else {
          records = (snapshots || []).map((snapshot) => ({
            header: snapshot.header,
            live: liveById.has(snapshot.header?.id),
            persisted: true
          }))
        }
      } else {
        records = agentRecords()
      }
    }

    const norm = (value) => String(value || '').toLowerCase().replace(/\\/g, '/')
    const sessions = records
      .map((record) => {
        const id = String(record.header?.id || '')
        const agent = liveById.get(id)
        const running = agent?.status === 'running'
        const agentAvailable = agent !== undefined
        const titleInfo = titles.get(id)
        return {
          sessionId: id,
          title: agent?.title || titleInfo?.title || '',
          cwd: record.header?.cwd || agent?.cwd || '',
          state: running ? 'working' : agentAvailable ? 'idle' : 'ended',
          running,
          agentAvailable,
          live: record.live === true || agentAvailable,
          persisted: record.persisted === true,
          createdAt: record.header?.createdAt || 0,
          updatedAt: titleInfo?.updatedAt || record.header?.createdAt || 0
        }
      })
      .filter((session) => includeEnded || session.state !== 'ended')
      .filter((session) => !workspace || norm(session.cwd).includes(norm(workspace)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
    return { source, includeEnded, count: sessions.length, sessions }
  }

  /**
   * Older DSH keeps tools in the root scope (`schemas()` sees them); newer DSH
   * registers tools per agent scope, so the root view is empty while
   * `schemas(agent)` returns that agent's tool set (probed on DSH next: 36 tools
   * vs 0 at root). Merge the per-agent views in that case.
   */
  const listSchemas = () => {
    const root = normalizeToolList(ctx.tools.schemas())
    if (root.length > 0) return root
    const merged = new Map()
    for (const agent of rawAgents()) {
      try {
        for (const tool of normalizeToolList(ctx.tools.schemas(agent))) merged.set(tool.name, tool)
      } catch {
        /* scope not usable */
      }
    }
    return [...merged.values()]
  }

  const findTool = (name, agent) => {
    try {
      const scoped = agent ? ctx.tools.get(name, agent) : undefined
      if (typeof scoped !== 'undefined') return scoped
    } catch {
      /* fall through to the unscoped registry */
    }
    return ctx.tools.get(name)
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/host/ping') {
        return json(res, 200, { ok: true, plugin: PLUGIN_VERSION })
      }
      if (!authorized(req)) {
        return json(res, 401, { ok: false, code: 'E_AUTH', message: 'missing or invalid host token' })
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname === '/host/self') {
        return json(res, 200, {
          ok: true,
          plugin: PLUGIN_VERSION,
          node: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), pid: process.pid },
          tools: listSchemas().map(tool => tool.name),
          agents: listAgents(),
          now: new Date().toISOString(),
        })
      }

      if (req.method === 'GET' && url.pathname === '/host/logs') {
        const name = url.searchParams.get('name') || ''
        const lines = Math.min(Math.max(Number(url.searchParams.get('lines') || 100), 1), 500)
        let path
        try {
          path = resolveLogPath(name)
        } catch (error) {
          return json(res, 200, { ok: false, code: error.code || 'E_LOG', message: error.message })
        }
        try {
          const tail = tailFile(path, lines)
          return json(res, 200, { ok: true, name: basename(path), path, lines, ...tail, plugin: PLUGIN_VERSION })
        } catch (error) {
          return json(res, 200, { ok: false, code: 'E_LOG_READ', message: error?.message || String(error) })
        }
      }

      if (req.method === 'GET' && url.pathname === '/host/tools') {
        return json(res, 200, { ok: true, tools: listSchemas() })
      }

      if (req.method === 'GET' && url.pathname === '/host/agents') {
        return json(res, 200, { ok: true, agents: listAgents() })
      }

      if (req.method === 'GET' && url.pathname === '/host/sessions') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200)
        const includeEnded = url.searchParams.get('includeEnded') !== 'false'
        const workspace = url.searchParams.get('workspace') || ''
        const listed = await listSessions({ limit, includeEnded, workspace })
        return json(res, 200, { ok: true, ...listed })
      }

      if (req.method === 'POST' && url.pathname === '/host/sessions/create') {
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
        }
        const optionalText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
        const request = {
          ...(optionalText(payload.cwd) === undefined ? {} : { cwd: optionalText(payload.cwd) }),
          ...(optionalText(payload.sessionId) === undefined ? {} : { sessionId: optionalText(payload.sessionId) }),
          ...(optionalText(payload.agentPreset) === undefined ? {} : { agentPreset: optionalText(payload.agentPreset) }),
          ...(optionalText(payload.workspaceId) === undefined ? {} : { workspaceId: optionalText(payload.workspaceId) })
        }
        let controller
        try {
          controller = requireSessionController()
        } catch (error) {
          return json(res, 501, { ok: false, code: error.code || 'E_HOST_NO_CONTROLLER', message: error.message })
        }
        try {
          const created = await controller.create(request)
          return json(res, 200, {
            ok: true,
            sessionId: String(created?.sessionId || ''),
            ...(created?.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
            plugin: PLUGIN_VERSION
          })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            code: error?.code || 'E_HOST_SESSION_CREATE',
            message: error?.message || String(error)
          })
        }
      }

      if (req.method === 'POST' && url.pathname === '/host/prompt') {
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
        }
        const sessionId = String(payload.sessionId || '').trim()
        const text = typeof payload.text === 'string' ? payload.text : ''
        const mode = payload.mode === 'steer' ? 'steer' : 'queue'
        if (!sessionId || text.trim() === '') {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'sessionId and non-empty text are required' })
        }
        const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
          ? payload.requestId.trim()
          : randomUUID()
        let controller
        try {
          controller = requireSessionController()
        } catch (error) {
          return json(res, 501, { ok: false, code: error.code || 'E_HOST_NO_CONTROLLER', message: error.message })
        }
        try {
          // sessionController.prompt(request, signal): DSH dereferences the signal
          // (throwIfAborted) before dispatch, so it must be a real AbortSignal.
          const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 600_000)
          const accepted = await controller.prompt({
            requestId,
            sessionId,
            mode,
            content: [{ type: 'text', text }],
            ...(typeof payload.clientTimeZone === 'string' && payload.clientTimeZone.trim()
              ? { clientTimeZone: payload.clientTimeZone.trim() }
              : {})
          }, AbortSignal.timeout(timeoutMs))
          return json(res, 200, { ok: true, sessionId, requestId, mode, accepted: accepted?.accepted === true, plugin: PLUGIN_VERSION })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            code: error?.code || 'E_HOST_PROMPT',
            message: error?.message || String(error)
          })
        }
      }

      if (req.method === 'POST' && url.pathname === '/host/sessions/archive') {
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
        }
        const sessionId = String(payload.sessionId || '').trim()
        if (!sessionId) {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'sessionId is required' })
        }
        // Archiving is DSH's own "remove from the list" action: the conversation
        // stays on disk and stays restorable. Deletion has no public service, so
        // this is the cleanup path for sessions created by delegations.
        const registry = optionalService('workspaceRegistry')
        if (!registry || typeof registry.archiveSession !== 'function') {
          return json(res, 501, { ok: false, code: 'E_HOST_NO_WORKSPACE', message: 'this DSH profile mounts no workspaceRegistry service (session archive unavailable)' })
        }
        try {
          await registry.archiveSession(sessionId, payload.stopActivity === true ? { stopActivity: true } : {})
          return json(res, 200, { ok: true, sessionId, archived: true, plugin: PLUGIN_VERSION })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            code: error?.code || 'E_HOST_ARCHIVE',
            message: error?.message || String(error)
          })
        }
      }

      if (req.method === 'POST' && url.pathname === '/host/tools/call') {
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
        }
        const toolName = String(payload.tool || payload.name || '').trim()
        if (!toolName) {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'tool is required' })
        }
        if (typeof findTool(toolName) === 'undefined' && rawAgents().every(agent => typeof findTool(toolName, agent) === 'undefined')) {
          return json(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `no such tool in this host: ${toolName}` })
        }
        const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 600_000)
        // Newer DSH registers tools per agent scope: when the caller did not pick a
        // session, execute in the first available agent's scope (usually the same
        // preset as every other session of this instance).
        const agent = payload.sessionId ? ctx.agents.get(String(payload.sessionId)) : rawAgents()[0]
        if (payload.sessionId && !agent) {
          return json(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `no such session: ${payload.sessionId}` })
        }
        let result
        try {
          result = await ctx.tools.execute({
            callId: randomUUID(),
            name: toolName,
            arguments: payload.arguments ?? {},
            agent,
            signal: AbortSignal.timeout(timeoutMs),
          })
        } catch (error) {
          return json(res, 200, {
            ok: false,
            code: error?.code || 'E_HOST_TOOL',
            message: error?.message || String(error),
          })
        }
        return json(res, 200, serializeResult(result))
      }

      if (req.method === 'POST' && url.pathname === '/host/wake') {
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'body must be JSON' })
        }
        const sessionId = String(payload.sessionId || '').trim()
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        const target = payload.target === 'next-step' ? 'next-step' : 'next-turn'
        if (!sessionId || !text) {
          return json(res, 400, { ok: false, code: 'E_INVALID_ARG', message: 'sessionId and text are required' })
        }
        const agent = ctx.agents.get(sessionId)
        if (!agent) {
          return json(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `no such session: ${sessionId}` })
        }
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        const wokeUp = agent.status === 'idle'
        try {
          if (typeof agent.send === 'function') agent.send(message, target, true)
          else agent.followup(message)
        } catch (error) {
          return json(res, 200, {
            ok: false,
            code: error?.code || 'E_HOST_WAKE',
            message: error?.message || String(error),
          })
        }
        return json(res, 200, {
          ok: true,
          sessionId,
          target,
          messageId: message.id,
          statusBefore: agent.status,
          wokeUp,
          delivered: true,
        })
      }

      return json(res, 404, { ok: false, code: 'E_NOT_FOUND', message: 'unknown endpoint' })
    } catch (error) {
      return json(res, 500, { ok: false, code: 'E_INTERNAL', message: error?.message || String(error) })
    }
  })

  server.on('error', error => {
    console.error(`[dsh-mesh-host] listen ${bind}:${port} failed: ${error?.code || error?.message || error}`)
  })
  server.unref()
  server.listen(port, bind, () => {
    console.error(`[dsh-mesh-host] listening on http://${bind}:${port} (token: ${hostTokenPath()})`)
  })

  // Close the loopback listener when the plugin is disposed.
  try {
    ctx.effect?.(() => () => server.close())
  } catch {
    /* older hosts: leaving the server unref()ed is enough */
  }
}
