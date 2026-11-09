/**
 * Cluster view (M7 step 4).
 *
 * A single read-only snapshot of everything this node can currently reach:
 * - local: every DSH instance behind a host bridge (id / pid / tool count / live agents)
 * - remote: every paired peer's `/health` (version / tools / uptime / TLS pin)
 *
 * The point is to answer "is the cluster healthy, and if not, which hop is broken"
 * from one call, instead of hand-running `host status` plus curl on each peer.
 * Nothing here mutates state; all probes are bounded by `timeoutMs`.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHostClient, hostInstances } from './host-agent.js'
import { MESH_VERSION } from './config.js'
import { callPeerTool } from './peer-client.js'
import { fingerprintOfSocket, normalizeFingerprint } from './tls.js'

const DEFAULT_TIMEOUT_MS = 4000

function normalizeUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

function normalizePeerHealth(body) {
  if (!body || body.service !== 'dsh-mesh') {
    return { error: { code: 'E_PEER_BAD_RESPONSE', message: 'peer /health did not identify as dsh-mesh' } }
  }
  return {
    version: body.version,
    node: body.node,
    tools: body.tools,
    pid: body.pid ?? null,
    uptimeSec: body.uptimeSec,
    tls: body.tls === true,
    pairing: body.pairing ? { enabled: body.pairing.enabled === true, codeActive: body.pairing.codeActive === true } : null
  }
}

/**
 * Probe one paired peer over HTTPS. Uses TOFU pinning (peers store the cert
 * fingerprint captured at pairing time): the trust chain is not judged, the
 * certificate is read off the socket and compared against the stored pin.
 */
export function probePeer(peer, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = normalizeUrl(peer?.url)
  const expected = peer?.certFingerprint ? normalizeFingerprint(peer.certFingerprint) : null
  return new Promise((resolve) => {
    let settled = false
    const startedAt = Date.now()
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ id: peer?.id || null, name: peer?.name || null, url: base, ...value })
    }
    if (!base) {
      return finish({ up: false, latencyMs: 0, error: { code: 'E_PEER_BAD_RESPONSE', message: 'peer has no url' } })
    }

    const isHttps = base.startsWith('https:')
    const request = isHttps ? httpsRequest : httpRequest
    const options = { method: 'GET', agent: false, headers: { accept: 'application/json' } }
    if (isHttps) options.rejectUnauthorized = false

    const req = request(`${base}/health`, options, (res) => {
      // Grab the certificate *inside* the response callback: by the time `end`
      // fires the socket may already be gone (same trap as company-check.mjs).
      let got = null
      if (isHttps) {
        try {
          got = fingerprintOfSocket(res.socket)
        } catch {
          got = null
        }
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const latencyMs = Date.now() - startedAt
        const text = Buffer.concat(chunks).toString('utf8')
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return finish({
            up: false,
            latencyMs,
            fingerprint: got,
            fingerprintMatch: got && expected ? normalizeFingerprint(got) === expected : null,
            error: { code: 'E_PEER_BAD_RESPONSE', message: `peer /health returned non-JSON (${res.statusCode})` }
          })
        }
        const match = got && expected ? normalizeFingerprint(got) === expected : null
        if (res.statusCode !== 200) {
          return finish({
            up: false,
            latencyMs,
            status: res.statusCode,
            fingerprint: got,
            fingerprintMatch: match,
            error: { code: 'E_PEER_BAD_RESPONSE', message: `peer /health returned ${res.statusCode}` }
          })
        }
        if (match === false) {
          const health = normalizePeerHealth(body)
          return finish({
            up: true,
            latencyMs,
            fingerprint: got,
            fingerprintMatch: false,
            ...health,
            error: {
              code: 'E_PEER_PIN_MISMATCH',
              message: 'peer certificate does not match the fingerprint stored at pairing time — refuse to trust it'
            }
          })
        }
        const health = normalizePeerHealth(body)
        return finish({ up: !health.error, latencyMs, fingerprint: got, fingerprintMatch: match, ...health })
      })
    })
    const timer = setTimeout(() => {
      try {
        req.destroy(new Error('timeout'))
      } catch {
        /* ignore */
      }
      finish({
        up: false,
        latencyMs: Date.now() - startedAt,
        error: { code: 'E_PEER_TIMEOUT', message: `peer did not answer within ${timeoutMs} ms` }
      })
    }, timeoutMs)
    req.on('error', (error) => {
      finish({
        up: false,
        latencyMs: Date.now() - startedAt,
        error: {
          code: error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED' ? 'E_PEER_OFFLINE' : 'E_PEER_TLS',
          message: `${base} unreachable (${error?.code || error?.message || error})`,
          detail: error?.code || null
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

/** Probe one local DSH instance through its host bridge. */
export async function probeInstance({ config, home, log, entry, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const startedAt = Date.now()
  const base = { id: entry.id, label: entry.label || entry.id, url: entry.url, profileDir: entry.profileDir || '' }
  try {
    const client = createHostClient({ config, home, log, instance: entry.id })
    await client.ping()
    const [self, tools, agents] = await Promise.all([client.self(), client.tools(), client.agents()])
    const toolList = tools?.tools || []
    const agentList = agents?.agents || []
    return {
      ...base,
      up: true,
      latencyMs: Date.now() - startedAt,
      plugin: self?.plugin || null,
      hostname: self?.node?.hostname || null,
      platform: self?.node?.platform || null,
      pid: self?.node?.pid || null,
      toolCount: toolList.length,
      agents: agentList.map((agent) => ({ id: agent.id, status: agent.status, title: agent.title || '' })),
      runningAgents: agentList.filter((agent) => agent.status === 'running').length
    }
  } catch (error) {
    return {
      ...base,
      up: false,
      latencyMs: Date.now() - startedAt,
      error: { code: error?.code || 'E_HOST_OFFLINE', message: error?.message || String(error) }
    }
  }
}

/**
 * Probe this node's OWN serve endpoint (`/health`) — the hop every peer needs.
 * The host-bridge probes below only prove the DSH instances are up; when the
 * local mesh server dies they all still look fine and only the peers look
 * offline. Reported 2026-10-23: the company endpoint had been down ~3 days
 * while `self-update status --deep` read clean.
 */
export async function probeSelfEndpoint(config, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const node = config?.node || {}
  const scheme = node.tls?.enabled ? 'https' : 'http'
  const url = `${scheme}://${node.bind || '127.0.0.1'}:${node.port || 8124}`
  const probe = await probePeer({ id: 'self', name: 'self', url }, { timeoutMs })
  return {
    url,
    up: probe.up === true,
    version: probe.version || null,
    pid: probe.pid ?? null,
    tools: probe.tools ?? null,
    uptimeSec: probe.uptimeSec ?? null,
    error: probe.error || null
  }
}

/** Parse the JSON payload of an MCP tool result (remote tools return text content). */
function parsePeerToolPayload(result) {
  const block = result?.content?.[0]
  if (!block || block.type !== 'text') return null
  try {
    return JSON.parse(block.text)
  } catch {
    return null
  }
}

/**
 * Ask a paired peer for its OWN host instances through the MCP `host_instances`
 * tool, so the cluster view can show all machines' DSH instances in one place.
 * This is best-effort: a peer that denies the tool (or has no token) still gets
 * its /health row — we just record `instancesError` instead of failing the view.
 */
async function probePeerInstances(peer, timeoutMs) {
  if (!peer?.token) {
    return { error: { code: 'E_PEER_NO_TOKEN', message: 'peer has no outbound token in peers.json — cannot list its host instances' } }
  }
  try {
    const result = await callPeerTool(peer, { tool: 'host_instances', args: {}, timeoutMs })
    const body = parsePeerToolPayload(result.result)
    const rows = Array.isArray(body?.instances) ? body.instances : []
    return {
      instances: rows.map((row) => ({
        id: row.id,
        label: row.label || row.id,
        url: row.url,
        alive: row.alive === true
      }))
    }
  } catch (error) {
    return { error: { code: error?.code || 'E_PEER_CALL_FAILED', message: error?.message || String(error) } }
  }
}

/**
 * @param {{ probeSelf?: boolean }} options `probeSelf: true` additionally probes
 * this node's own serve endpoint, so a CLI running *outside* the server can tell
 * "my host bridges are fine" apart from "my node is actually serving peers".
 * Off by default: callers inside the server would only measure themselves, and
 * tests use `node.port = 0`.
 */
export async function clusterReport({ config, home, log, peers = [], timeoutMs = DEFAULT_TIMEOUT_MS, probeSelf = false } = {}) {
  const endpoint = probeSelf ? await probeSelfEndpoint(config, { timeoutMs }) : null
  const instances = []
  for (const entry of hostInstances(config)) {
    if (entry.enabled === false) continue
    instances.push(await probeInstance({ config, home, log, entry, timeoutMs }))
  }
  const peerReports = await Promise.all(
    peers.map(async (peer) => {
      const report = await probePeer(peer, { timeoutMs })
      if (report.up === true && !report.error) {
        const remote = await probePeerInstances(peer, timeoutMs)
        report.instances = remote.instances || []
        if (remote.error) report.instancesError = remote.error
      }
      return report
    })
  )

  const issues = []
  if (endpoint && !endpoint.up) {
    issues.push(`local endpoint ${endpoint.url} down: ${endpoint.error?.code || 'E_ENDPOINT_OFFLINE'}`)
  }
  for (const instance of instances) {
    if (!instance.up) issues.push(`instance ${instance.id} down: ${instance.error?.code || 'E_HOST_OFFLINE'}`)
    else if (instance.runningAgents > 0) issues.push(`instance ${instance.id} has ${instance.runningAgents} running agent(s)`)
  }
  for (const peer of peerReports) {
    if (!peer.up) issues.push(`peer ${peer.name || peer.id || peer.url} down: ${peer.error?.code || 'E_PEER_OFFLINE'}`)
    else if (peer.fingerprintMatch === false) issues.push(`peer ${peer.name || peer.id} fingerprint mismatch`)
    else if (peer.instancesError) {
      issues.push(`peer ${peer.name || peer.id} host instances unavailable: ${peer.instancesError.code}`)
    }
  }

  // Flatten remote instances next to local ones so one call shows the whole
  // cluster (four DSH instances on two machines). `scope` says where a row lives.
  const localRows = instances.map((instance) => ({
    scope: 'local',
    id: instance.id,
    label: instance.label,
    up: instance.up === true,
    toolCount: instance.toolCount ?? null,
    pid: instance.pid ?? null
  }))
  const remoteRows = []
  for (const peer of peerReports) {
    for (const row of peer.instances || []) {
      remoteRows.push({
        scope: peer.name || peer.id,
        id: row.id,
        label: row.label,
        url: row.url,
        up: row.alive === true,
        remote: true
      })
      if (row.alive !== true) issues.push(`peer ${peer.name || peer.id} instance ${row.id} down`)
    }
  }

  const anyInstanceUp = instances.some((instance) => instance.up)
  const remoteAllAlive = remoteRows.every((row) => row.up === true)
  const allUp =
    (!endpoint || endpoint.up) &&
    instances.every((instance) => instance.up) &&
    peerReports.every((peer) => peer.up && peer.fingerprintMatch !== false) &&
    remoteAllAlive

  return {
    node: { version: MESH_VERSION, home, instances: instances.length, peers: peerReports.length },
    summary: { local: localRows.length, remote: remoteRows.length, total: localRows.length + remoteRows.length },
    endpoint,
    instances,
    remoteInstances: remoteRows,
    cluster: [...localRows, ...remoteRows],
    peers: peerReports,
    verdict:
      endpoint && !endpoint.up
        ? 'down'
        : instances.length === 0
          ? 'unknown'
          : allUp
            ? 'ok'
            : anyInstanceUp
              ? 'degraded'
              : 'down',
    issues
  }
}

