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
import { listDelegations, sessionHistory, taskStatus } from './delegations.js'
import { networkInterfaces } from 'node:os'
import net from 'node:net'
import tls from 'node:tls'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** Cordis inject 列表：只需要 webServer。 */
export const inject = ['webServer']

export const name = '@linyanzhi/dsh-mesh'

// 2026-11-09：默认 10s（可用 DSH_MESH_UI_REFRESH_MS 覆盖）；隧道/节点变化更快可见
const REFRESH_MS = Math.max(3_000, Number(process.env.DSH_MESH_UI_REFRESH_MS || 5_000))
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
  const delegationCache = { at: 0, data: null }
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

  const transfersRoute = readonlyRoute('/api/dsh-mesh/transfers', async () => {
    try {
      const list = JSON.parse(readFileSync(join(meshHome(), 'transfers.json'), 'utf8'))
      const items = (Array.isArray(list) ? list : []).slice(-60).reverse().map((x) => ({ at: x.at || null, direction: x.direction || '', path: x.path || '', bytes: Number(x.bytes) || 0, totalBytes: Number(x.totalBytes) || 0, peer: x.peer || '' }))
      return { ok: true, items }
    } catch { return { ok: true, items: [] } }
  })

  const peersListRoute = readonlyRoute('/api/dsh-mesh/peers', async () => {
    const r = await runCli(['peer', 'list'])
    try { const data = JSON.parse(r.stdout); return { ok: true, peers: (data.peers || []).map((p) => ({ id: p.id, name: p.name, url: p.url, addedAt: p.addedAt || null })) } } catch { return { ok: false, error: 'invalid peer list', stderr: r.stderr } }
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
      // 缓存整份列表（与请求的 limit 无关），避免不同 limit 的请求互相污染缓存
      if (Date.now() - delegationCache.at > 15_000) {
        delegationCache.at = Date.now()
        delegationCache.data = listDelegations(200)
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
    const disposeLanRoutes = [lanScanRoute, lanCodeRoute, lanCheckRoute, lanPairRoute, federatedRoute, peersListRoute, peersRemoveRoute, peersToggleRoute, tokensListRoute, tokensRevokeRoute, transfersRoute].map((item) => ctx.webServer.register(item))
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
