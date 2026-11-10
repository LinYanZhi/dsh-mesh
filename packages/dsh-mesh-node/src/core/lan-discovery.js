import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { describeCert } from './tls.js'
import { MESH_VERSION } from './config.js'

export const LAN_DISCOVERY_PORT = Number(process.env.DSH_MESH_LAN_PORT || 8129)
const SERVICE = 'dsh-mesh'

function schemeOf(config) {
  return config?.node?.tls?.enabled ? 'https' : 'http'
}

function lanAddress() {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !/^169\.254\./.test(item.address)) return item.address
    }
  }
  return '127.0.0.1'
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255'])
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && item.netmask) {
        const ip = item.address.split('.').map(Number)
        const mask = item.netmask.split('.').map(Number)
        out.add(ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join('.'))
      }
    }
  }
  return [...out]
}

function advertisePayload({ home, config, port }) {
  const node = config?.node || {}
  const host = String(node.bind || '').trim()
  const hostForUrl = host && host !== '0.0.0.0' && host !== '::' ? host : lanAddress()
  const scheme = schemeOf(config)
  let certFingerprint = null
  try {
    certFingerprint = scheme === 'https' ? describeCert(home)?.fingerprint256 || null : null
  } catch {
    /* cert may not exist yet */
  }
  return {
    service: SERVICE,
    type: 'offer',
    v: 1,
    node: node.name || 'local',
    hostname: hostForUrl,
    port,
    url: `${scheme}://${hostForUrl}:${port}${node.path || '/mcp'}`,
    scheme,
    certFingerprint,
    version: MESH_VERSION
  }
}

export function startLanResponder({ home, config, port = LAN_DISCOVERY_PORT, log = console } = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('error', (err) => log?.warn?.(`[lan-discovery] ${String(err?.message || err)}`))
  socket.on('message', (buf, rinfo) => {
    try {
      const msg = JSON.parse(buf.toString('utf8'))
      if (msg?.service !== SERVICE || msg.type !== 'discover') return
      const payload = advertisePayload({ home, config, port: Number(config?.node?.port) || 8124 })
      socket.send(JSON.stringify(payload), rinfo.port, rinfo.address)
    } catch {
      /* ignore malformed datagrams */
    }
  })
  socket.bind(port, '0.0.0.0', () => log?.info?.(`[lan-discovery] listening on udp/${port}`))
  return { close: () => { try { socket.close() } catch { /* ignore */ } } }
}

export function discoverLan({ timeoutMs = 1800, port = LAN_DISCOVERY_PORT } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()
    const query = JSON.stringify({ service: SERVICE, type: 'discover', v: 1 })
    let done = false
    function finish() {
      if (done) return
      done = true
      try { socket.close() } catch { /* ignore */ }
      resolve([...found.values()])
    }
    socket.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString('utf8'))
        if (msg?.service !== SERVICE || msg.type !== 'offer' || !msg.url) return
        const key = `${msg.node}|${msg.url}`
        if (!found.has(key)) found.set(key, { ...msg, address: rinfo.address })
      } catch {
        /* ignore malformed replies */
      }
    })
    socket.on('error', finish)
    socket.bind(0, '0.0.0.0', () => {
      try { socket.setBroadcast(true) } catch { /* ignore */ }
      for (const addr of broadcastAddresses()) {
        try { socket.send(query, port, addr) } catch { /* ignore */ }
      }
      try { socket.send(query, port, '127.0.0.1') } catch { /* ignore */ }
    })
    setTimeout(finish, timeoutMs)
  })
}
