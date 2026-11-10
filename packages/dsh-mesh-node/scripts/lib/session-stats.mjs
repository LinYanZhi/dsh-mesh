// @generated 会话运行态统计：「每节点每实例有几条会话正在跑」
// [why] T-202611100111 B2/B3。原来 mesh-health --sessions 全节点 22.7s（串行 + 无缓存），
//   mesh-delegate overview 的 liveAgents 又只有本机数。这里抽成共用实现：按节点/实例过滤、每目标独立超时、
//   并发探测、短 TTL 磁盘缓存（CLI 每次是新进程，内存缓存没用），让两条入口口径一致、耗时可复现。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHostClient, hostInstances } from '../../src/core/host-agent.js'
import { callPeerTool } from '../../src/core/peer-client.js'

const CACHE_SUBDIR = 'cache'
const CACHE_NAME = 'session-stats.json'
export const DEFAULT_TTL_MS = 30_000
export const UPDATED_AT_FIELD = 'host_sessions.updatedAt = 会话索引时间（实测会滞后于日志真实写入，不等于最后活动时间）'

const quiet = { info() {}, warn() {}, error() {} }

function tail(value, n = 140) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function unwrap(wrapper) {
  const result = wrapper?.result ?? wrapper
  const text = result?.content?.find?.((c) => c && c.type === 'text')?.text
  if (typeof text === 'string') {
    try { return JSON.parse(text) } catch { return { _text: tail(text) } }
  }
  return result
}

/** 本机实例 id 列表（来自 config.host.instances）。 */
export function localInstanceIds(config) {
  try {
    return hostInstances(config).map((entry) => entry.id)
  } catch {
    return []
  }
}

/** 远端节点的实例 id 列表（host_instances；失败返回 []，不抛）。 */
export async function remoteInstanceIds(peer, { timeoutMs = 8000 } = {}) {
  try {
    const data = unwrap(await callPeerTool(peer, { tool: 'host_instances', args: {}, timeoutMs }))
    const list = Array.isArray(data) ? data : data?.instances || []
    return [...new Set(list.map((item) => item?.id).filter((id) => typeof id === 'string' && /^dsh\d+$/.test(id)))].sort()
  } catch {
    return []
  }
}

/** 便宜的活会话探测：/host/agents（本机）或 channel_agents（远端）——只列内存里的活会话，不扫持久化存储。 */
async function probeLiveAgents({ config, home, peer, instance, timeoutMs }) {
  if (peer) {
    const data = unwrap(await callPeerTool(peer, { tool: 'channel_agents', args: { instance }, timeoutMs }))
    if (data?.code) throw new Error(`${data.code}: ${data.message || ''}`)
    return Array.isArray(data?.agents) ? data.agents : []
  }
  const result = await createHostClient({ config, home, instance, log: quiet }).agents()
  return Array.isArray(result?.agents) ? result.agents : []
}

/** 完整会话清单（含标题/updatedAt）；比 agents 贵一个数量级，只在真有运行中会话时才调用。 */
async function probeSessionDetails({ config, home, peer, instance, timeoutMs }) {
  const data = peer
    ? unwrap(
        await callPeerTool(peer, {
          tool: 'host_sessions',
          args: { instance, limit: 200, includeEnded: false },
          timeoutMs
        })
      )
    : await createHostClient({ config, home, instance, log: quiet }).sessions({ limit: 200, includeEnded: false })
  return Array.isArray(data?.sessions) ? data.sessions : []
}

/**
 * 探测单个实例的运行中会话。只统计 state=working / status=running 的会话。
 * 两段式：先用便宜的活会话接口拿 running 数；只有 running>0 时才拉完整会话清单补标题，
 * 避免每个节点都付一次「扫全部会话」的代价。
 * @param {{config: object, home: string, peer?: object, instance: string, timeoutMs?: number, titles?: 'auto'|'none'}} options
 * @returns {Promise<{ok: boolean, ms: number, source?: string, total?: number, running?: number, sessions?: object[], error?: string}>}
 */
export async function probeRunningSessions({ config, home, peer, instance, timeoutMs = 15000, titles = 'auto' }) {
  const started = Date.now()
  let agents = null
  try {
    agents = await probeLiveAgents({ config, home, peer, instance, timeoutMs })
  } catch {
    agents = null // 旧对端没有 channel_agents / token 未放行 → 退回完整清单
  }
  if (agents) {
    const running = agents.filter((a) => a.status === 'running' || a.status === 'working')
    const sessions = running.map((a) => ({
      sessionId: a.id || a.sessionId,
      title: String(a.title || '').replace(/\s+/g, ' ').slice(0, 80),
      state: a.status || null,
      updatedAt: a.updatedAt || null
    }))
    const row = { ok: true, source: 'agents', total: agents.length, running: sessions.length, sessions }
    if (titles !== 'none' && sessions.length > 0) {
      const titleStarted = Date.now()
      try {
        const details = await probeSessionDetails({ config, home, peer, instance, timeoutMs })
        const byId = new Map(details.map((s) => [s.sessionId, s]))
        for (const session of sessions) {
          const detail = byId.get(session.sessionId)
          if (!detail) continue
          session.title = String(detail.title || session.title || '').replace(/\s+/g, ' ').slice(0, 80)
          session.updatedAt = detail.updatedAt || null
          if (detail.state) session.state = detail.state
        }
      } catch (error) {
        row.titleError = tail(error?.message || error)
      }
      row.titleMs = Date.now() - titleStarted
    }
    row.ms = Date.now() - started
    return row
  }
  // 兜底：完整清单（旧行为），一次拿齐 total/running/标题
  try {
    const all = await probeSessionDetails({ config, home, peer, instance, timeoutMs })
    const working = all.filter((s) => s.state === 'working' || s.running === true)
    return {
      ok: true,
      source: 'host_sessions',
      ms: Date.now() - started,
      total: all.length,
      running: working.length,
      sessions: working.map((s) => ({
        sessionId: s.sessionId,
        title: String(s.title || '').replace(/\s+/g, ' ').slice(0, 80),
        state: s.state || null,
        updatedAt: s.updatedAt || null
      }))
    }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: tail(error?.message || error) }
  }
}

/** 按 --node / --instance 过滤目标；两个参数都是「不传=不过滤」。 */
export function filterTargets(targets, { node = '', instance = '' } = {}) {
  return targets.filter(
    (target) =>
      (!node || target.scope === node) && (!instance || target.instance === instance)
  )
}

function cachePath(home) {
  return join(home, CACHE_SUBDIR, CACHE_NAME)
}

function readCache(home) {
  try {
    const raw = JSON.parse(readFileSync(cachePath(home), 'utf8'))
    return raw && typeof raw === 'object' && raw.entries ? raw : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

function writeCache(home, cache) {
  try {
    const dir = join(home, CACHE_SUBDIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath(home), JSON.stringify(cache, null, 1) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* 缓存写失败不影响结果 */
  }
}

/**
 * 并发探测一组目标，带每目标独立超时与短 TTL 磁盘缓存。
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.home
 * @param {Array<{scope: string, instance: string, peer?: object}>} options.targets
 * @param {number} [options.timeoutMs] 每个目标独立超时
 * @param {number} [options.concurrency] 并发上限（默认 8）
 * @param {number} [options.ttlMs] 缓存 TTL（默认 30s）
 * @param {boolean} [options.cache] 是否读写缓存（默认 true；--no-cache 置 false）
 * @returns {Promise<object>} 含 rows / runningCount / okCount / failedCount / cachedCount
 */
export async function collectRunningSessions({
  config,
  home,
  targets,
  timeoutMs = 15000,
  concurrency = 8,
  ttlMs = DEFAULT_TTL_MS,
  cache = true,
  titles = 'auto'
}) {
  const now = Date.now()
  const store = cache ? readCache(home) : { entries: {} }
  const results = new Map()
  const pending = []
  for (const target of targets) {
    const key = `${target.scope}/${target.instance}`
    const hit = store.entries[key]
    if (cache && hit && now - Number(hit.at || 0) < ttlMs) {
      results.set(key, { ...hit.row, cached: true, cacheAgeMs: now - hit.at })
      continue
    }
    pending.push({ target, key })
  }
  let index = 0
  const workers = Math.max(1, Math.min(concurrency, pending.length || 1))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (index < pending.length) {
        const item = pending[index]
        index += 1
        const probed = await probeRunningSessions({
          config,
          home,
          peer: item.target.peer,
          instance: item.target.instance,
          timeoutMs,
          titles
        })
        const row = { scope: item.target.scope, instance: item.target.instance, ...probed, cached: false }
        results.set(item.key, row)
        if (cache && probed.ok) store.entries[item.key] = { at: Date.now(), row: { ...row, cached: false } }
      }
    })
  )
  if (cache) writeCache(home, store)
  const rows = [...results.entries()]
    .map(([key, row]) => ({ ...row, key }))
    .sort((a, b) => `${a.scope}/${a.instance}`.localeCompare(`${b.scope}/${b.instance}`))
  return {
    at: new Date().toISOString(),
    ttlMs,
    cacheEnabled: Boolean(cache),
    runningCount: rows.reduce((sum, row) => sum + (row.running || 0), 0),
    okCount: rows.filter((row) => row.ok).length,
    failedCount: rows.filter((row) => !row.ok).length,
    cachedCount: rows.filter((row) => row.cached).length,
    updatedAtField: UPDATED_AT_FIELD,
    rows
  }
}
