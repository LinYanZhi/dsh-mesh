// dsh-mesh-ui — 服务端半（host 进程）
//
// 注册只读路由 GET /api/dsh-mesh/status（设置页「AI 网络」用）+ 后台刷新循环。
// 数据由 lib/collect.js 采集（mesh-health / host status / peer host_self / 台账 / 告警历史）。
//
// 2026-11-06 修正（三台实测死锁）：v1 在 request handler 里 spawnSync 跑 mesh-health，
// 同步阻塞 DSH host 事件循环，而 mesh-health 要探测同进程的 host bridge（9100/9101）→ 自死锁 20s。
// 现在：后台 execFile 异步刷新 + 内存缓存，handler 只读缓存（0ms，不阻塞）。
//
// 安全：仅 loopback；不含 token/凭据；纯只读（只读文件 + 只调只读 CLI）。
//
// 归宿：reusable（dsh-mesh/plugin/dsh-mesh-ui/lib/）

import { collect, resolveRepo, meshHome, run, nodeExec } from './collect.js'
import { listDelegations, refreshActiveDelegations, sessionHistory, taskStatus } from './delegations.js'
import { probePublicTarget } from './public-probe.js'
import { permissionZh } from './permissions-zh.js'
import { networkInterfaces } from 'node:os'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

/** Cordis inject 列表：只需要 webServer。 */
export const inject = ['webServer']

export const name = 'dsh-mesh-ui'

// 2026-11-12：默认 60s（原 5s 太激进：每个 DSH 实例都装本插件，多实例后台刷新叠加
// 成每 ~1.7s 一轮 mesh-health 探测，把共享 frps 隧道的 frpc 连接池打满）。可用 DSH_MESH_UI_REFRESH_MS 覆盖。
const REFRESH_MS = Math.max(5_000, Number(process.env.DSH_MESH_UI_REFRESH_MS || 60_000))
const LATENCY_HISTORY_MAX = 30
const REQUEST_REFRESH_COOLDOWN_MS = 8_000

function isLoopback(req) {
  const raw = req?.socket?.remoteAddress || ''
  const addr = String(raw).replace(/^::ffff:/, '')
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr.startsWith('127.')
}

function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body, null, 2))
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function lanIPv4() {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !/^169\.254\./.test(item.address)) return item.address
    }
  }
  return '127.0.0.1'
}

/**
 * Cordis apply：注册只读状态路由 + 后台刷新循环。
 * @param {import('@deepseek-ai/cordis').Context} ctx host 插件上下文（已注入 webServer）
 */
export function apply(ctx) {
  const repo = resolveRepo()
  const state = {
    repo,
    snapshot: {
      ok: false,
      warming: Boolean(repo),
      at: null,
      node: process.env.COMPUTERNAME || process.env.HOSTNAME || '',
      meshHome: meshHome(),
      nodeVersion: process.version,
      repo,
      error: repo ? 'warming up (first background refresh pending)' : 'dsh-mesh repo not found (set DSH_MESH_REPO or clone to ~/Code/dsh-mesh)'
    },
    refreshing: false,
    lastStartedAt: 0,
    latencyHistory: new Map()
  }

  /** 记录每个 peer 的延迟小趋势（在内存里滚动，不落盘）。 */
  function rememberLatency(peers) {
    for (const peer of peers || []) {
      const history = state.latencyHistory.get(peer.name) || []
      history.push(peer.up ? peer.latencyMs : null)
      while (history.length > LATENCY_HISTORY_MAX) history.shift()
      state.latencyHistory.set(peer.name, history)
    }
    return (peers || []).map((peer) => ({ ...peer, latencyHistory: state.latencyHistory.get(peer.name) || [] }))
  }

  async function refresh() {
    if (state.refreshing || !state.repo) return
    state.refreshing = true
    state.lastStartedAt = Date.now()
    try {
      const data = await collect(state.repo)
      state.snapshot = {
        ...data,
        warming: false,
        at: data.generatedAt || new Date().toISOString(),
        latencyMs: Date.now() - state.lastStartedAt,
        node: process.env.COMPUTERNAME || process.env.HOSTNAME || '',
        meshHome: meshHome(),
        nodeVersion: process.version,
        peers: data.ok ? rememberLatency(data.peers) : data.peers || []
      }
    } catch (error) {
      state.snapshot = { ...state.snapshot, ok: false, warming: false, at: new Date().toISOString(), error: String(error?.message || error) }
    } finally {
      state.refreshing = false
    }
  }

  const timer = setInterval(() => {
    refresh().catch(() => {})
  }, REFRESH_MS)
  if (typeof timer.unref === 'function') timer.unref()
  refresh().catch(() => {})

  // ---- 委托面板只读路由（2026-11-07 方案 A）----
  const delegationCache = { at: 0, data: null, refreshing: false }
  const taskCache = new Map()
  const sessionCache = new Map()
  function cached(taskIdKey, map, ttlMs, producer) {
    const hit = map.get(taskIdKey)
    if (hit && Date.now() - hit.at < ttlMs) return hit.data
    const data = producer()
    const settled = data instanceof Promise ? data.then((value) => { map.set(taskIdKey, { at: Date.now(), data: value }); return value }) : (map.set(taskIdKey, { at: Date.now(), data }), data)
    return settled
  }

  const route = {
    kind: 'exact',
    path: '/api/dsh-mesh/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        if (url.searchParams.get('force') === '1' && Date.now() - state.lastStartedAt > REQUEST_REFRESH_COOLDOWN_MS) {
          refresh().catch(() => {})
        }
        writeJson(res, 200, {
          ...state.snapshot,
          refreshing: state.refreshing,
          snapshotAgeSeconds: state.snapshot.at ? Math.round((Date.now() - Date.parse(state.snapshot.at)) / 1000) : null
        })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
    }
  }

  /** 统一 GET 只读处理器。 */
  function readonlyRoute(path, handler) {
    return {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if ((req.method || 'GET').toUpperCase() !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          writeJson(res, 200, await handler(url))
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
    }
  }

  function meshPort() {
    try { return Number(JSON.parse(readFileSync(join(meshHome(), 'config.json'), 'utf8')).node?.port) || 8124 } catch { return 8124 }
  }

  async function runCli(args, timeout = 30_000) {
    if (!state.repo) return { error: 'dsh-mesh-node is not installed', stdout: '', stderr: '' }
    return run(nodeExec(), [join(state.repo, 'src', 'cli.js'), ...args], { cwd: state.repo, timeout })
  }

  const lanScanRoute = readonlyRoute('/api/dsh-mesh/lan/scan', async () => {
    const r = await runCli(['discover', '--json', '--timeout-ms', '1500'], 20_000)
    if (r.error) return { ok: false, error: r.error, stderr: r.stderr }
    try {
      const data = JSON.parse(r.stdout)
      return { ok: true, localAddress: lanIPv4(), nodes: data.nodes || [] }
    } catch {
      return { ok: false, error: 'invalid discover output', stdout: r.stdout, stderr: r.stderr }
    }
  })

  const lanCodeRoute = readonlyRoute('/api/dsh-mesh/lan/code', async () => {
    const host = `${lanIPv4()}:${meshPort()}`
    const r = await runCli(['pair', '--code', '--ttl', '600', '--role', 'node', '--host', host])
    if (r.error) return { ok: false, error: r.error, stderr: r.stderr }
    try {
      return { ok: true, ...JSON.parse(r.stdout) }
    } catch {
      return { ok: false, error: 'invalid pair output', stdout: r.stdout, stderr: r.stderr }
    }
  })


  const lanCheckRoute = {
    kind: 'exact',
    path: '/api/dsh-mesh/lan/check',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      if (!body || typeof body.url !== 'string') return writeJson(res, 400, { ok: false, error: 'url required' })
      let target
      try { target = new URL(String(body.url)) } catch { return writeJson(res, 400, { ok: false, error: 'invalid url' }) }
      const host = target.hostname.replace(/^\[|\]$/g, '')
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
      const started = Date.now()
      function tcp() {
        return new Promise((resolve) => {
          const socket = net.connect({ host, port, timeout: 2500 })
          socket.once('connect', () => { socket.destroy(); resolve({ ok: true }) })
          socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'tcp timeout' }) })
          socket.once('error', (error) => { socket.destroy(); resolve({ ok: false, error: String(error.message || error) }) })
        })
      }
      const tcpResult = await tcp()
      let tlsResult = null
      if (tcpResult.ok && target.protocol === 'https:') {
        tlsResult = await new Promise((resolve) => {
          const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: host, timeout: 2500 })
          socket.once('secureConnect', () => { socket.destroy(); resolve({ ok: true, fingerprint: socket.getPeerCertificate()?.fingerprint256 || null }) })
          socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'tls timeout' }) })
          socket.once('error', (error) => { socket.destroy(); resolve({ ok: false, error: String(error.message || error) }) })
        })
      }
      writeJson(res, 200, { ok: tcpResult.ok, host, port, tcp: tcpResult.ok, tls: tlsResult, latencyMs: Date.now() - started })
    }
  }

  const publicProbeRoute = {
    kind: 'exact',
    path: '/api/dsh-mesh/public/probe',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      if (!body || typeof body.host !== 'string') return writeJson(res, 400, { ok: false, error: 'host required' })
      try {
        const result = await probePublicTarget(body.host, body.port || 8124, {
          sakura: body.sakura === true,
          tunnels: state.snapshot?.tunnels || {}
        })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
    }
  }

  const permissionsRoute = readonlyRoute('/api/dsh-mesh/permissions', async () => {
    const r = await runCli(['tools', '--all'], 30_000)
    if (r.error) return { ok: false, error: r.error, stderr: r.stderr }
    const tools = []
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const match = /^\s*(ALLOW|deny)\s+([a-z0-9_]+)\s+(.*)$/i.exec(line)
      if (!match) continue
      tools.push({ name: match[2], allowed: match[1].toUpperCase() === 'ALLOW', description: match[3].trim(), descriptionZh: permissionZh(match[2]) })
    }
    return { ok: true, tools }
  })

  const permissionsSetRoute = {
    kind: 'exact',
    path: '/api/dsh-mesh/permissions/set',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      const name = String(body?.name || '').trim()
      if (!/^[a-z0-9_]+$/i.test(name)) return writeJson(res, 400, { ok: false, error: 'invalid tool name' })
      const r = await runCli(['acl', body?.allowed ? 'allow' : 'deny', name], 30_000)
      writeJson(res, 200, { ok: !r.error, name, allowed: body?.allowed === true, error: r.error, stdout: r.stdout, stderr: r.stderr })
    }
  }

  const lanPairRoute = {
    kind: 'exact',
    path: '/api/dsh-mesh/lan/pair',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      if (!body || typeof body.url !== 'string' || typeof body.code !== 'string') {
        return writeJson(res, 400, { ok: false, error: 'url and code required' })
      }
      const pairingCode = String(body.code).trim()
      if (pairingCode.replace(/-/g, '').length < 6) {
        return writeJson(res, 400, { ok: false, error: 'pairing code is required (one-time code from the target node)' })
      }
      const args = ['peer', 'add', '--url', String(body.url), '--code', pairingCode, '--name', String(body.name || 'lan-peer')]
      if (body.fingerprint) args.push('--fingerprint', String(body.fingerprint))
      try {
        const r = await runCli(args)
        writeJson(res, 200, { ok: !r.error, error: r.error, stdout: r.stdout, stderr: r.stderr })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
    }
  }

  // 只读联邦拓扑：向每个直连 peer 查询它的 cluster_status，得到 1 跳间接节点。
  const federatedCache = { at: 0, data: null }
  const federatedRoute = readonlyRoute('/api/dsh-mesh/federated', async () => {
    if (federatedCache.data && Date.now() - federatedCache.at < 45_000) return federatedCache.data
    const listResult = await runCli(['peer', 'list'])
    let direct = []
    try { direct = JSON.parse(listResult.stdout).peers || [] } catch { /* ignore */ }
    const directNames = new Set(direct.map((p) => String(p.name || '')).filter(Boolean))
    const nodes = []
    const errors = []
    const results = await Promise.all(direct.slice(0, 6).map(async (peer) => {
      const name = String(peer.name || '')
      if (!name) return null
      // 快速路径：新节点暴露 mesh_peers（只读、不探测、毫秒级）。
      const fast = await runCli(['peer', 'call', 'mesh_peers', '--to', name, '--timeout-ms', '4000'], 10_000)
      if (!fast.error) {
        try {
          const fw = JSON.parse(fast.stdout)
          const fi = JSON.parse(fw?.result?.content?.[0]?.text || '{}')
          if (Array.isArray(fi.peers)) return { via: name, peers: fi.peers, instances: [], fast: true }
        } catch { /* fall through */ }
      }
      // 兼容旧节点：回退到 cluster_status。
      const r = await runCli(['peer', 'call', 'cluster_status', '--to', name, '--args', JSON.stringify({ noPeers: true, probeSelf: false }), '--timeout-ms', '10000'], 16_000)
      if (r.error) { errors.push({ via: name, error: r.error }); return null }
      try {
        const wrapper = JSON.parse(r.stdout)
        const inner = JSON.parse(wrapper?.result?.content?.[0]?.text || '{}')
        return { via: name, peers: inner.peers || [], instances: inner.remoteInstances || [], fast: false }
      } catch (error) { errors.push({ via: name, error: 'invalid cluster_status' }); return null }
    }))
    for (const result of results.filter(Boolean)) {
      for (const peer of result.peers) {
        const name = String(peer.name || '')
        if (!name || directNames.has(name)) continue
        nodes.push({ name, via: result.via, up: peer.up == null ? null : Boolean(peer.up), latencyMs: peer.latencyMs ?? null, version: peer.version || null, node: peer.node || name })
      }
    }
    const data = { ok: true, nodes: nodes.slice(0, 40), errors }
    federatedCache.at = Date.now(); federatedCache.data = data
    return data
  })

  // 2026-11-12：传输历史（按节点存储 + 可选全网汇总）。session 记录里 read=本机发出（被对端读走）、write=本机接收（对端写入本机）。
  function readLocalTransfers(limit = 100) {
    try {
      const list = JSON.parse(readFileSync(join(meshHome(), 'transfers.json'), 'utf8'))
      return (Array.isArray(list) ? list : []).slice(-limit).reverse().map((x) => ({ at: x.at || null, direction: x.direction || '', path: x.path || '', offset: Number(x.offset) || 0, bytes: Number(x.bytes) || 0, totalBytes: Number(x.totalBytes) || 0, peer: x.peer || '' }))
    } catch { return [] }
  }
  function peersForTransfers() {
    try {
      const raw = JSON.parse(readFileSync(join(meshHome(), 'peers.json'), 'utf8'))
      const list = Array.isArray(raw) ? raw : (raw.items || raw.peers || [])
      const isLanUrl = (url) => /\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(String(url || ''))
      // 同一台设备可能配了多条 peer（公网 + 局域网 + exec）：按证书指纹去重，优先保留局域网 URL，避免记录重复
      const byFp = new Map()
      const noFp = []
      const normFp = (fp) => String(fp || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
      for (const p of Array.isArray(list) ? list : []) {
        const name = String(p.name || p.id || '').trim()
        if (!name || p.disabled) continue
        const item = { name, url: String(p.url || ''), fingerprint: normFp(p.certFingerprint) }
        if (!item.fingerprint) { noFp.push(item); continue }
        const prev = byFp.get(item.fingerprint)
        if (!prev || (!isLanUrl(prev.url) && isLanUrl(item.url))) byFp.set(item.fingerprint, item)
      }
      return [...byFp.values(), ...noFp]
    } catch { return [] }
  }
  function parsePeerTransferItems(stdout) {
    try {
      const wrapper = JSON.parse(String(stdout || ''))
      const text = wrapper?.result?.content?.[0]?.text
      if (typeof text !== 'string') return []
      const inner = JSON.parse(text)
      return Array.isArray(inner?.items) ? inner.items : []
    } catch { return [] }
  }
  // 2026-11-12：全网记录不一定每次都重新拉——12s 内存缓存 + 最近一次结果落盘快照，
  // 对端全部离线时回退到快照（stale=true），避免面板每次切换都重新 RPC、且有备份可看。
  const TRANSFERS_CACHE_MS = 12_000
  const transfersAggCache = { at: 0, data: null }
  function transfersSnapshotPath() { return join(meshHome(), 'transfers-aggregate.json') }
  function readTransfersSnapshot() {
    try {
      const snap = JSON.parse(readFileSync(transfersSnapshotPath(), 'utf8'))
      return snap && Array.isArray(snap.items) ? snap : null
    } catch { return null }
  }
  function writeTransfersSnapshot(data) {
    try { writeFileSync(transfersSnapshotPath(), JSON.stringify({ at: new Date().toISOString(), scope: 'all', items: data.items, nodes: data.nodes }, null, 2) + '\n', 'utf8') } catch { /* best effort */ }
  }
  const transfersRoute = readonlyRoute('/api/dsh-mesh/transfers', async (url) => {
    const scope = String(url.searchParams.get('scope') || 'local')
    const limit = 60
    const generatedAt = new Date().toISOString()
    const localItems = readLocalTransfers(limit)
    if (scope !== 'all') return { ok: true, scope: 'local', generatedAt, cached: false, items: localItems, nodes: [{ node: '本机', ok: true, count: localItems.length }] }
    const now = Date.now()
    if (transfersAggCache.data && now - transfersAggCache.at < TRANSFERS_CACHE_MS) {
      return Object.assign({}, transfersAggCache.data, { cached: true, cacheAgeMs: now - transfersAggCache.at })
    }
    const peers = peersForTransfers()
    const settled = await Promise.all(peers.map(async (peer) => {
      try {
        const r = await runCli(['peer', 'call', 'file_transfers', '--to', peer.name, '--args', JSON.stringify({ limit }), '--json'], 6000)
        const items = parsePeerTransferItems(r.stdout).map((x) => Object.assign({}, x, { node: peer.name }))
        return { node: peer.name, ok: true, count: items.length, items }
      } catch (error) {
        return { node: peer.name, ok: false, count: 0, items: [], error: String(error?.message || error).slice(0, 160) }
      }
    }))
    const merged = localItems.map((x) => Object.assign({}, x, { node: '本机' })).concat(...settled.map((x) => x.items))
    merged.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    const data = {
      ok: true,
      scope: 'all',
      generatedAt,
      cached: false,
      items: merged.slice(0, limit * Math.max(2, peers.length + 1)),
      nodes: [{ node: '本机', ok: true, count: localItems.length }].concat(settled.map((x) => ({ node: x.node, ok: x.ok, count: x.count, error: x.error || '' })))
    }
    const allFailed = settled.length > 0 && settled.every((x) => !x.ok)
    if (allFailed) {
      const snap = readTransfersSnapshot()
      if (snap) return Object.assign({}, snap, { ok: true, scope: 'all', stale: true, cached: true, nodes: data.nodes, generatedAt: snap.at || generatedAt })
    }
    transfersAggCache.at = now
    transfersAggCache.data = data
    writeTransfersSnapshot(data)
    return data
  })

  const peersListRoute = readonlyRoute('/api/dsh-mesh/peers', async () => {
    const r = await runCli(['peer', 'list'])
    try {
      const data = JSON.parse(r.stdout)
      const list = (data.peers || []).map((p) => ({ id: p.id, name: p.name, url: p.url, addedAt: p.addedAt || null, disabled: Boolean(p.disabled) }))
      // 2026-11-12（用户多次强调）：节点管理表格必须显示「IP:端口」，不显示主机名/设备名。
      // 域名型 host（如 node-x）在这里解析成 IPv4；解析失败前端显示「IP 未解析」。
      await Promise.all(list.map(async (item) => {
        try {
          const u = new URL(String(item.url || ''))
          const host = u.hostname
          const port = u.port || ''
          const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host)
          let ip = isIp ? host.replace(/^\[|\]$/g, '') : ''
          if (!ip) {
            try {
              const rr = await lookup(host, { family: 4 })
              ip = rr.address || ''
            } catch {
              /* DNS 解析失败则留空，由前端显示「IP 未解析」 */
            }
          }
          item.ip = ip
          item.port = port
        } catch {
          /* 无效 URL 忽略 */
        }
      }))
      return { ok: true, peers: list }
    } catch { return { ok: false, error: 'invalid peer list', stderr: r.stderr } }
  })
  const peersRemoveRoute = {
    kind: 'exact', path: '/api/dsh-mesh/peers/remove',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      const id = String(body?.id || '').trim()
      if (!id) return writeJson(res, 400, { ok: false, error: 'id required' })
      const r = await runCli(['peer', 'remove', id])
      writeJson(res, 200, { ok: !r.error, error: r.error, stdout: r.stdout, stderr: r.stderr })
    }
  }
  const peersToggleRoute = {
    kind: 'exact', path: '/api/dsh-mesh/peers/toggle',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      const id = String(body?.id || '').trim()
      if (!id) return writeJson(res, 400, { ok: false, error: 'id required' })
      const r = await runCli(['peer', body?.disabled ? 'disable' : 'enable', id])
      writeJson(res, 200, { ok: !r.error, error: r.error, stdout: r.stdout, stderr: r.stderr })
    }
  }

  const tokensListRoute = readonlyRoute('/api/dsh-mesh/tokens', async () => {
    const r = await runCli(['token', 'list'])
    try { const data = JSON.parse(r.stdout); return { ok: true, tokens: (data || []).map((x) => ({ id: x.id, note: x.note || '', role: x.role || null, roleHint: x.roleHint || '' })) } } catch { return { ok: false, error: 'invalid token list', stderr: r.stderr } }
  })
  const tokensRevokeRoute = {
    kind: 'exact', path: '/api/dsh-mesh/tokens/revoke',
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      const id = String(body?.id || '').trim()
      if (!id) return writeJson(res, 400, { ok: false, error: 'id required' })
      const r = await runCli(['revoke', id])
      writeJson(res, 200, { ok: !r.error, error: r.error, stdout: r.stdout, stderr: r.stderr })
    }
  }

  const delegateRoutes = [
    readonlyRoute('/api/dsh-mesh/delegations', async (url) => {
      const refresh = url.searchParams.get('refresh') === '1'
      // Fast path: never block the UI on remote status probes. Return the local
      // ledger immediately and reconcile in the background; the next 5s poll
      // picks up fresh states. (Previously a slow/offline peer made this route
      // wait 10-40s, so the header looked stuck on "loading".)
      if (!delegationCache.data) {
        delegationCache.data = listDelegations(200)
        delegationCache.at = Date.now()
      }
      if (refresh && !delegationCache.refreshing) {
        delegationCache.refreshing = true
        refreshActiveDelegations().then((data) => {
          delegationCache.data = data
          delegationCache.at = Date.now()
        }).catch(() => {
          /* keep last good ledger */
        }).finally(() => {
          delegationCache.refreshing = false
        })
      } else if (!refresh && Date.now() - delegationCache.at > 15_000) {
        delegationCache.data = listDelegations(200)
        delegationCache.at = Date.now()
      }
      const data = delegationCache.data
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 200))
      return { ok: true, total: data.total, byState: data.byState, localNode: data.localNode, tasks: data.tasks.slice(0, limit) }
    }),
    readonlyRoute('/api/dsh-mesh/task', async (url) => {
      const taskId = String(url.searchParams.get('taskId') || '')
      if (!taskId) return { ok: false, error: 'taskId required' }
      return cached('task:' + taskId, taskCache, 60_000, () => taskStatus(taskId))
    }),
    readonlyRoute('/api/dsh-mesh/session', async (url) => {
      const node = String(url.searchParams.get('node') || '')
      // 2026-11-10：本机任务（node=local）没有对端会话，直接给出明确错误，避免 peer call --to local 报 unknown peer
      if (/^(local|self|localhost)$/i.test(node)) return { ok: false, code: "E_LOCAL_NODE", error: "本机任务（local）没有对端会话；请在 DSH 侧栏查看本机会话" }
      const sessionId = String(url.searchParams.get('sessionId') || '')
      const limit = Number(url.searchParams.get('limit')) || 40
      if (!node || !sessionId) return { ok: false, error: 'node and sessionId required' }
      return cached('sess:' + node + ':' + sessionId + ':' + limit, sessionCache, 120_000, () => sessionHistory(node, sessionId, limit))
    })
  ]

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register(route)
    const disposeLanRoutes = [lanScanRoute, lanCodeRoute, lanCheckRoute, lanPairRoute, publicProbeRoute, permissionsRoute, permissionsSetRoute, federatedRoute, peersListRoute, peersRemoveRoute, peersToggleRoute, tokensListRoute, tokensRevokeRoute, transfersRoute].map((item) => ctx.webServer.register(item))
    const disposeRoutes = delegateRoutes.map((item) => ctx.webServer.register(item))
    return () => {
      try {
        clearInterval(timer)
      } catch {
        /* ignore */
      }
      for (const dispose of disposeLanRoutes.concat(disposeRoutes)) { try { dispose() } catch { /* ignore */ } }
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  }, 'dsh-mesh-ui: GET /api/dsh-mesh/status + background refresh')
}
