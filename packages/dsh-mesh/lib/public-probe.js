// dsh-mesh-ui / public-probe.js
// 公网服务器检测：TCP、TLS、/health 协议识别，以及樱花/自建隧道匹配。
// 纯只读探测，不写 peer、不带 token；由 loopback-only 路由调用。

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'

const TIMEOUT_MS = 5000

export function normalizeHost(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
}

export function validateTarget(host, port) {
  const h = normalizeHost(host)
  if (!h) return { error: '请输入公网 IP 或域名' }
  if (!/^[a-z0-9.:-]+$/i.test(h)) return { error: 'IP/域名格式无效' }
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: '端口必须是 1-65535' }
  return { host: h, port: p }
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS })
    const done = (value) => {
      socket.destroy()
      resolve({ ...value, latencyMs: Date.now() - started })
    }
    socket.once('connect', () => done({ ok: true }))
    socket.once('timeout', () => done({ ok: false, error: 'TCP 超时' }))
    socket.once('error', (error) => done({ ok: false, error: String(error?.code || error?.message || error) }))
  })
}

function tlsProbe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const options = { host, port, rejectUnauthorized: false, timeout: TIMEOUT_MS }
    if (!net.isIP(host)) options.servername = host
    const socket = tls.connect(options)
    const done = (value) => {
      socket.destroy()
      resolve({ ...value, latencyMs: Date.now() - started })
    }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() || {}
      done({
        ok: true,
        fingerprint256: cert.fingerprint256 || null,
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.CN || null,
        validTo: cert.valid_to || null
      })
    })
    socket.once('timeout', () => done({ ok: false, error: 'TLS 超时' }))
    socket.once('error', (error) => done({ ok: false, error: String(error?.code || error?.message || error) }))
  })
}

function readHealth(protocol, host, port) {
  return new Promise((resolve) => {
    const started = Date.now()
    const lib = protocol === 'https' ? https : http
    const options = {
      host,
      port,
      path: '/health',
      method: 'GET',
      timeout: TIMEOUT_MS,
      rejectUnauthorized: false,
      headers: { accept: 'application/json', 'user-agent': 'dsh-mesh-ui/public-probe' }
    }
    if (protocol === 'https' && !net.isIP(host)) options.servername = host
    const req = lib.request(options, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > 256 * 1024) {
          req.destroy()
          resolve({ ok: false, status: res.statusCode, error: '响应过大' })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = null
        try { body = JSON.parse(text) } catch { /* not json */ }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          latencyMs: Date.now() - started,
          body,
          error: body ? null : '返回不是 JSON'
        })
      })
    })
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, error: '健康检查超时' }) })
    req.once('error', (error) => resolve({ ok: false, error: String(error?.code || error?.message || error) }))
    req.end()
  })
}

function endpointKey(host, port) {
  return normalizeHost(host) + ':' + String(port)
}

function collectEndpoints(tunnels) {
  const list = []
  const seen = new Set()
  function add(kind, name, host, port, up, extra) {
    host = normalizeHost(host)
    if (!host || !port) return
    const key = endpointKey(host, port)
    if (seen.has(key)) return
    seen.add(key)
    list.push({ kind, name: name || kind, host, port: String(port), up: up === true, ...(extra || {}) })
  }
  if (tunnels?.selfHosted?.host) {
    add('self-hosted', tunnels.selfHosted.name || '自建 frps', tunnels.selfHosted.host, tunnels.selfHosted.port, tunnels.selfHosted.probe?.up)
  }
  for (const t of tunnels?.sakura?.tunnels || []) add('sakura', t.name, t.host, t.port, t.probe?.up)
  for (const t of tunnels?.sakuraAccount?.tunnels || []) {
    const addr = String(t.addr || '')
    if (t.host && t.port) add('sakura', t.name, t.host, t.port, t.online === true)
    else if (addr) {
      const m = /^([^:]+):(\d+)$/.exec(addr)
      if (m) add('sakura', t.name, m[1], m[2], t.online === true)
    }
  }
  return list
}

function sakuraResult(tunnels, host, port) {
  const acc = tunnels?.sakuraAccount || null
  const endpoints = collectEndpoints({ sakuraAccount: acc })
  const matches = endpoints.filter((item) => item.host === host && String(item.port) === String(port))
  return {
    checked: true,
    available: Boolean(acc?.available),
    error: acc?.available === false ? String(acc?.error || '樱花账号 API 不可用') : null,
    total: Number(acc?.total || endpoints.length || 0),
    online: Number(acc?.online || endpoints.filter((x) => x.up).length || 0),
    endpoints,
    matches,
    matched: matches.length > 0
  }
}

/**
 * 探测任意公网目标。返回结构稳定，供 UI 直接渲染。
 * @param {string} rawHost
 * @param {number|string} rawPort
 * @param {{sakura?:boolean, tunnels?:object}} options
 */
export async function probePublicTarget(rawHost, rawPort, options = {}) {
  const checked = validateTarget(rawHost, rawPort)
  if (checked.error) return { ok: false, error: checked.error }
  const { host, port } = checked
  const sakura = options.sakura ? sakuraResult(options.tunnels || {}, host, port) : null

  const tcp = await tcpProbe(host, port)
  const tls = tcp.ok ? await tlsProbe(host, port) : { ok: false, error: 'TCP 不可达，未继续 TLS' }
  let health = null
  let protocolName = null
  if (tcp.ok) {
    if (tls.ok) health = await readHealth('https', host, port)
    if (!health?.body) {
      const httpHealth = await readHealth('http', host, port)
      if (httpHealth.body) health = httpHealth
      protocolName = 'http'
    } else {
      protocolName = 'https'
    }
  }

  const body = health?.body || null
  const serviceOk = body?.service === 'dsh-mesh'
  const protocol = {
    ok: Boolean(serviceOk && body?.ok === true),
    service: body?.service || null,
    version: body?.version || null,
    node: body?.node || null,
    tls: body?.tls === true,
    pairing: body?.pairing || null,
    httpStatus: health?.status ?? null,
    channel: protocolName,
    error: serviceOk ? (body?.ok === true ? null : 'dsh-mesh 返回 ok=false') : (health?.error || (tcp.ok ? '不是 dsh-mesh 协议' : 'TCP 不可达'))
  }

  return {
    ok: Boolean(tcp.ok && protocol.ok),
    host,
    port,
    compatible: Boolean(protocol.ok),
    checkedAt: new Date().toISOString(),
    tcp,
    tls,
    health: health ? { ok: health.ok, status: health.status ?? null, latencyMs: health.latencyMs ?? null, error: health.error || null } : null,
    protocol,
    sakura
  }
}
