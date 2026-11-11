// SakuraFrp 账号级隧道状态（只读）：读本机 Launcher token + 调 api.natfrp.com/v4/tunnels（+ /v4/nodes 解析节点域名）
// 用途：PC 端即可看到同账号下所有设备（含手机）的樱花隧道在线状态，不依赖对端上报。
// 安全：token 只在内存中使用，绝不写日志/输出；结果缓存 60s。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const API_BASE = 'https://api.natfrp.com'
// 2026-11-09：动态检测——默认 5s 重新拉取账号隧道状态（SAKURA_POLL_MS 可覆盖；<=3s 会被抬到 3s）
const CACHE_TTL_MS = Math.max(3000, Number(process.env.SAKURA_POLL_MS || 5000))

const CACHE_FILE = join(homedir(), '.dsh-mesh', 'sakura-cache.json')
let cache = { at: 0, data: null, ttl: 0 }
let lastGood = null
function saveCache() {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify({ at: cache.at, data: cache.data, ttl: cache.ttl, lastGood }), 'utf8')
  } catch { /* cache is best-effort */ }
}
try {
  const saved = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  if (saved && saved.data) { cache = { at: Number(saved.at) || 0, data: saved.data, ttl: Number(saved.ttl) || 0 }; lastGood = saved.lastGood || null }
} catch { /* no cache yet */ }

/** 本机 Launcher 配置里的账号 token（Windows / Linux / macOS 常见路径，或 SAKURA_TOKEN 环境变量）。 */
function findToken() {
  const candidates = [
    'C:/ProgramData/SakuraFrpService/config.json',
    '/var/lib/sakurafrp/config.json',
    '/ProgramData/SakuraFrpService/config.json',
    join(homedir(), '.config', 'sakura-frp', 'config.json'),
    join(homedir(), '.config', 'sakurafrp', 'config.json')
  ]
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      if (cfg && cfg.token) return { token: String(cfg.token), source: file }
    } catch {
      /* try next */
    }
  }
  if (process.env.SAKURA_TOKEN) return { token: process.env.SAKURA_TOKEN, source: 'env:SAKURA_TOKEN' }
  return null
}

async function apiGet(path, token) {
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: 'Bearer ' + token, accept: 'application/json', 'user-agent': 'dsh-mesh-sakura' },
    signal: AbortSignal.timeout(12_000)
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 隧道名 → 设备 key 的猜测映射（名字里含设备名时用）。 */
function deviceKeyOf(name) {
  const n = String(name || '')
  if (!n) return null
  let h = 0
  for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return 'dev' + (h % 1000)
}

/**
 * 账号级樱花隧道列表 + 节点域名。失败返回 { available:false, error }，不抛异常。
 * @param {{ttlMs?:number, token?:string}} [opts]
 */
export async function collectSakuraAccount({ ttlMs = CACHE_TTL_MS, token } = {}) {
  if (!token && cache.data && Date.now() - cache.at < (cache.ttl || ttlMs)) return cache.data
  const found = token ? { token, source: 'arg' } : findToken()
  if (!found) {
    const data = { available: false, error: '本机未找到 Sakura Launcher token（config.json / SAKURA_TOKEN）', generatedAt: new Date().toISOString() }
    cache = { at: Date.now(), data, ttl: ttlMs }
  saveCache()
    return data
  }
  try {
    const [tunnels, nodes] = await Promise.all([apiGet('/v4/tunnels', found.token), apiGet('/v4/nodes', found.token)])
    const list = (Array.isArray(tunnels) ? tunnels : []).map((t) => {
      const node = nodes && nodes[String(t.node)] ? nodes[String(t.node)] : {}
      const remote = t.remote == null ? '' : String(t.remote)
      return {
        id: t.id,
        name: t.name,
        note: t.note || '',
        type: t.type,
        nodeId: t.node,
        nodeName: node.name || '',
        host: node.host || '',
        remotePort: remote,
        localIp: t.local_ip || '',
        localPort: t.local_port == null ? null : Number(t.local_port),
        online: t.online === true,
        status: t.status == null ? null : Number(t.status),
        statusReason: t.status_reason || '',
        deviceKey: deviceKeyOf(t.name),
        addr: (node.host || '') + (remote ? ':' + remote : '')
      }
    })
    const data = {
      available: true,
      source: found.source,
      generatedAt: new Date().toISOString(),
      total: list.length,
      online: list.filter((t) => t.online).length,
      tunnels: list,
      error: null
    }
    lastGood = data
    cache = { at: Date.now(), data, ttl: ttlMs }
  saveCache()
    return data
  } catch (error) {
    const data = {
      available: false,
      error: String(error?.message || error),
      generatedAt: new Date().toISOString(),
      source: found.source,
      stale: true,
      tunnels: lastGood?.tunnels || [],
      total: lastGood?.total || (lastGood?.tunnels || []).length,
      online: lastGood?.online || 0
    }
    // 429/限流时不要每 60s 再打 API；保留上一次成功列表，5 分钟后再试
    cache = { at: Date.now(), data, ttl: Math.max(ttlMs, 300_000) }
  saveCache()
    return data
  }
}
