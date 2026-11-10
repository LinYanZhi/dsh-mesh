/**
 * Client for the `dsh-mesh-host` bridge plugin (route B).
 *
 * The plugin runs *inside* a DSH instance and listens on loopback only; this
 * module is the mesh server's side of that link. Authentication is a shared
 * random token file (`<home>/host-token`, 0600) written by the plugin on first
 * load and readable by the mesh CLI.
 *
 * Every call is short-lived and has its own timeout: the bridge is a local
 * daemon, so "slow" means "that DSH instance is busy", not "the network is bad".
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class HostError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'HostError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Configured host bridges (one per local DSH instance). */
export function hostInstances(config) {
  const list = Array.isArray(config?.hosts) ? config.hosts : []
  return list.filter((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0)
}

/**
 * Resolve one host instance by id; with no id, the first enabled instance wins.
 * Unknown ids fail loud so a caller cannot silently hit the wrong DSH.
 */
export function resolveHostInstance(config, id) {
  const list = hostInstances(config)
  if (list.length === 0) {
    throw new HostError('E_HOST_NO_INSTANCE', 'no host bridge configured (config.hosts is empty)')
  }
  if (id === undefined || id === null || id === '') {
    return list.find((entry) => entry.enabled !== false) || list[0]
  }
  const found = list.find((entry) => entry.id === id)
  if (!found) {
    throw new HostError(
      'E_HOST_UNKNOWN',
      `unknown host instance "${id}" — configured: ${list.map((entry) => entry.id).join(', ')}`,
      { instances: list.map((entry) => entry.id) }
    )
  }
  return found
}

/** Resolve the shared loopback token path for one host instance. */
export function hostTokenPath(config, home, id) {
  const entry = resolveHostInstance(config, id)
  if (entry.tokenFile) return entry.tokenFile
  // dsh0 keeps the historical name so existing installs keep working.
  return entry.id === 'dsh0' ? join(home, 'host-token') : join(home, `host-token-${entry.id}`)
}

/** Read the shared token; throws E_HOST_NO_TOKEN with a fix hint when absent. */
export function readHostToken(config, home, id) {
  const path = hostTokenPath(config, home, id)
  try {
    const token = readFileSync(path, 'utf8').trim()
    if (token) return token
  } catch {
    /* fall through to the descriptive error */
  }
  throw new HostError(
    'E_HOST_NO_TOKEN',
    `host bridge token not found at ${path} — start a DSH instance with the dsh-mesh-host plugin installed (it creates the token on first load)`
  )
}

function requestJson({ url, token, method = 'GET', path, body, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }

    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    const req = (target.protocol === 'https:' ? import('node:https') : import('node:http'))
    const timer = setTimeout(() => {
      req?.then?.(() => {})
      try {
        request?.destroy?.(new Error('timeout'))
      } catch {
        /* ignore */
      }
      finish(reject, new HostError('E_HOST_TIMEOUT', `host bridge did not answer within ${timeoutMs} ms`))
    }, timeoutMs)

    let request
    Promise.resolve(req).then(({ default: mod }) => {
      request = mod.request(
        target,
        { method, headers },
        res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed
            try {
              parsed = text ? JSON.parse(text) : {}
            } catch {
              return finish(
                reject,
                new HostError('E_HOST_BAD_RESPONSE', `host bridge returned non-JSON (${res.statusCode})`)
              )
            }
            finish(resolve, { status: res.statusCode, body: parsed })
          })
        }
      )
      request.on('error', error => {
        finish(
          reject,
          new HostError(
            'E_HOST_OFFLINE',
            `host bridge unreachable at ${url} (${error?.code || error?.message || error}) — is a DSH instance running with the dsh-mesh-host plugin?`
          )
        )
      })
      if (payload) request.write(payload)
      request.end()
    })
  })
}

/**
 * Build a host-bridge client bound to one config/home pair and one instance.
 * @param {{config: object, home: string, log?: object, instance?: string}} options
 */
export function createHostClient({ config, home, log = console, instance, peerId } = {}) {
  const entry = resolveHostInstance(config, instance)
  const allowedPeers = Array.isArray(entry.allowedPeers) ? entry.allowedPeers : null
  if (allowedPeers && allowedPeers.length && peerId && !allowedPeers.includes('*') && !allowedPeers.includes(peerId)) {
    throw new HostError('E_HOST_FORBIDDEN', `peer ${peerId} is not allowed to use host instance ${entry.id}`, { instance: entry.id })
  }
  const base = {
    id: entry.id,
    label: entry.label || entry.id,
    url: String(entry.url || 'http://127.0.0.1:9100'),
    timeoutMs: Number(entry.timeoutMs) || 120000
  }
  const tokenOf = () => readHostToken(config, home, entry.id)

  async function call(path, { method = 'GET', body, timeoutMs } = {}) {
    const { status, body: payload } = await requestJson({
      url: base.url,
      token: tokenOf(),
      method,
      path,
      body,
      timeoutMs: timeoutMs ?? base.timeoutMs
    })
    if (status === 401) throw new HostError('E_HOST_AUTH', 'host bridge rejected the shared token')
    if (payload && payload.ok === false) {
      throw new HostError(payload.code || 'E_HOST_ERROR', payload.message || 'host bridge call failed')
    }
    if (status >= 400) {
      throw new HostError('E_HOST_ERROR', `host bridge returned HTTP ${status}`)
    }
    return payload
  }

  return {
    id: base.id,
    label: base.label,
    url: base.url,
    /** True when the bridge answers /host/ping. */
    async ping() {
      try {
        const { body } = await requestJson({
          url: base.url,
          token: tokenOf(),
          method: 'GET',
          path: '/host/ping',
          timeoutMs: 4000
        })
        return body?.ok === true
      } catch (error) {
        log?.debug?.(`[dsh-mesh] host ping failed: ${error?.code || error?.message}`)
        return false
      }
    },
    async self() {
      return call('/host/self')
    },
    async tools() {
      return call('/host/tools')
    },
    async agents() {
      return call('/host/agents')
    },
    async sessions({ limit = 50, includeEnded = true, workspace = '' } = {}) {
      const params = new URLSearchParams({ limit: String(limit), includeEnded: String(includeEnded) })
      if (workspace) params.set('workspace', workspace)
      return call(`/host/sessions?${params.toString()}`)
    },
    async callTool({ tool, args, sessionId, timeoutMs }) {
      return call('/host/tools/call', {
        method: 'POST',
        body: { tool, arguments: args ?? {}, sessionId, timeoutMs },
        timeoutMs: timeoutMs ?? base.timeoutMs
      })
    },
    async wake({ sessionId, text, target }) {
      return call('/host/wake', {
        method: 'POST',
        body: { sessionId, text, target },
        timeoutMs: 30000
      })
    },
    /**
     * Create a fresh Session in that DSH instance (the web UI's own
     * sessionController path). Requires dsh-mesh-host >= 0.2.0; an older
     * plugin answers 404 unknown endpoint.
     */
    async createSession({ cwd, sessionId, agentPreset, workspaceId, title } = {}) {
      return call('/host/sessions/create', {
        method: 'POST',
        body: { cwd, sessionId, agentPreset, workspaceId, title },
        timeoutMs: 60000
      })
    },
    /**
     * Pin a user-owned session title (stops DSH's automatic title revisions).
     * Requires dsh-mesh-host >= 0.6.0; older bridges answer 404.
     */
    async renameSession({ sessionId, title } = {}) {
      return call('/host/sessions/rename', {
        method: 'POST',
        body: { sessionId, title },
        timeoutMs: 30000
      })
    },
    /** Deliver one user prompt into a Session without a web cookie. */
    async prompt({ sessionId, text, mode, requestId, clientTimeZone } = {}) {
      return call('/host/prompt', {
        method: 'POST',
        body: { sessionId, text, mode, requestId, clientTimeZone },
        timeoutMs: 60000
      })
    },
    /**
     * Abort the Session's active turn immediately (DSH's own stop button: the
     * inbox is kept). Requires dsh-mesh-host >= 0.5.0; an older plugin answers
     * 404 "unknown endpoint", which callers must surface instead of falling back
     * to an inbox message (a queued message only lands after the turn ends).
     */
    async cancelSession({ sessionId } = {}) {
      return call('/host/sessions/cancel', {
        method: 'POST',
        body: { sessionId },
        timeoutMs: 30000
      })
    },
    /**
     * Tail one allow-listed log file on the peer machine (mesh home root or
     * `<mesh home>/logs`, `*.log` only; secrets are redacted by the bridge).
     * Requires dsh-mesh-host >= 0.4.0; older plugins answer 404 unknown endpoint.
     */
    async logs({ name, lines = 100 } = {}) {
      const params = new URLSearchParams({ name: String(name || ''), lines: String(lines) })
      return call(`/host/logs?${params.toString()}`, { timeoutMs: 15000 })
    },
    /** Archive a Session (DSH's restorable "remove from list"; no hard delete exists). */
    async archiveSession({ sessionId, stopActivity } = {}) {
      return call('/host/sessions/archive', {
        method: 'POST',
        body: { sessionId, stopActivity },
        timeoutMs: 60000
      })
    }
  }
}
