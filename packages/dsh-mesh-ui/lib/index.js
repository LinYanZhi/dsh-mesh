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

import { collect, resolveRepo, meshHome } from './collect.js'
import { listDelegations, sessionHistory, taskStatus } from './delegations.js'

/** Cordis inject 列表：只需要 webServer。 */
export const inject = ['webServer']

export const name = 'dsh-mesh-ui'

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
      const sessionId = String(url.searchParams.get('sessionId') || '')
      const limit = Number(url.searchParams.get('limit')) || 40
      if (!node || !sessionId) return { ok: false, error: 'node and sessionId required' }
      return cached('sess:' + node + ':' + sessionId + ':' + limit, sessionCache, 120_000, () => sessionHistory(node, sessionId, limit))
    })
  ]

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register(route)
    const disposeRoutes = delegateRoutes.map((item) => ctx.webServer.register(item))
    return () => {
      try {
        clearInterval(timer)
      } catch {
        /* ignore */
      }
      for (const dispose of disposeRoutes) { try { dispose() } catch { /* ignore */ } }
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  }, 'dsh-mesh-ui: GET /api/dsh-mesh/status + background refresh')
}
