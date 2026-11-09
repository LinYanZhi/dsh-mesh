// dsh-mesh 隧道采集（只读）：自建 frps（.runtime/frpc/frpc.toml）+ Sakura Launcher 日志/进程 + 端口探测
// 用途：/health 上报给其它节点、mesh-health 聚合、面板显示、可独立 CLI 调用
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { collectSakuraAccount } from './sakura-api.js'

const SAKURA_LOG_DIR_WIN = 'C:\\ProgramData\\SakuraFrpService\\Logs'
const SAKURA_LOG_DIR_LINUX = '/var/log/sakurafrp'

function readText(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function frpcToml(repo) {
  const file = join(repo || '', '.runtime', 'frpc', 'frpc.toml')
  const text = readText(file)
  if (!text) return null
  const grab = (key) => {
    const m = new RegExp('^\\s*' + key + '\\s*=\\s*"?([^"\\r\\n]+)"?', 'm').exec(text)
    return m ? m[1].trim() : null
  }
  const host = grab('serverAddr')
  const port = grab('remotePort')
  if (!host || !port) return null
  return { host, port, serverPort: grab('serverPort') || null, localPort: grab('localPort') || null, name: grab('name') || null, configPath: file }
}

function sakuraTunnels() {
  const dir = process.platform === 'win32' ? SAKURA_LOG_DIR_WIN : SAKURA_LOG_DIR_LINUX
  try {
    if (!existsSync(dir)) return []
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .sort()
    if (!files.length) return []
    const text = readText(join(dir, files[files.length - 1]))
    const tail = text.slice(-400000)
    const found = new Map()
    const re = /frpc\[([^\]|]+)[^\]]*\][^\n]*?使用 >>([^\s:]+):(\d+)<</g
    let m
    while ((m = re.exec(tail))) found.set(m[1].trim(), { name: m[1].trim(), host: m[2], port: m[3] })
    return [...found.values()]
  } catch {
    return []
  }
}

function processes() {
  const out = { frpc: [], sakura: [], error: null }
  try {
    if (process.platform === 'win32') {
      const ps = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(frpc|SakuraLauncher|SakuraFrpService)\\.exe$' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        ],
        { encoding: 'utf8', timeout: 8000, windowsHide: true }
      ).trim()
      const parsed = ps ? JSON.parse(ps) : []
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const p of list) {
        const name = String(p.Name || '')
        const cmd = String(p.CommandLine || '')
        if (name.toLowerCase() === 'frpc.exe') {
          out.frpc.push({ pid: p.ProcessId || null, kind: /SakuraFrpLauncher/i.test(cmd) ? 'sakura' : 'self-hosted', cmd: cmd.slice(0, 200) })
        } else {
          out.sakura.push({ pid: p.ProcessId || null, name })
        }
      }
    } else {
      const txt = execFileSync('ps', ['-eo', 'pid,comm,args'], { encoding: 'utf8', timeout: 5000 }).toString()
      for (const line of txt.split('\n')) {
        if (!/frpc/i.test(line)) continue
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
        if (!m) continue
        out.frpc.push({ pid: Number(m[1]), kind: /sakura/i.test(m[3]) ? 'sakura' : 'self-hosted', cmd: m[3].slice(0, 200) })
      }
    }
  } catch (error) {
    out.error = String(error?.message || error)
  }
  return out
}

/** 已知公网隧道端点（~/.dsh-mesh/tunnels-known.json）：不依赖对端上报即可探测樱花/公网入口。 */
function knownEndpoints(home) {
  if (!home) return []
  try {
    const raw = JSON.parse(readFileSync(join(home, 'tunnels-known.json'), 'utf8'))
    const list = Array.isArray(raw?.endpoints) ? raw.endpoints : []
    return list.filter((x) => x && x.host && x.port).map((x) => ({
      node: String(x.node || ""),
      kind: String(x.kind || 'sakura'),
      host: String(x.host),
      port: Number(x.port),
      label: String(x.label || "")
    }))
  } catch {
    return []
  }
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const sock = net.connect({ host, port: Number(port) })
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'))
    const finish = (up, error) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve({ up, latencyMs: Date.now() - startedAt, error: error || null })
    }
    sock.once('connect', () => finish(true))
    sock.once('error', (error) => finish(false, String(error?.code || error?.message || error)))
  })
}

/**
 * 采集本机隧道状态（只读，会做少量端口探测，默认 ~2.5s 超时）。
 * 返回：{ generatedAt, processes, selfHosted, sakura } —— 供 /health / mesh-health / 面板使用。
 */
export async function collectTunnels({ repo, home, timeoutMs = 2500 } = {}) {
  const procs = processes()
  const selfHosted = frpcToml(repo)
  const sakura = sakuraTunnels()
  const selfProbe = selfHosted ? await probe(selfHosted.host, selfHosted.port, timeoutMs) : null
  const sakuraProbes = await Promise.all(
    sakura.slice(0, 4).map(async (t) => ({ ...t, probe: await probe(t.host, t.port, timeoutMs) }))
  )
  const sakuraAlive = procs.sakura.length > 0 || procs.frpc.some((p) => p.kind === 'sakura')
  const sakuraAccount = await collectSakuraAccount({ ttlMs: 60_000 })
  const known = await Promise.all(
    knownEndpoints(home).map(async (x) => ({ ...x, probe: await probe(x.host, x.port, timeoutMs) }))
  )
  return {
    generatedAt: new Date().toISOString(),
    processes: procs,
    selfHosted: selfHosted ? { ...selfHosted, probe: selfProbe } : null,
    sakura: { launcherRunning: sakuraAlive, tunnels: sakuraProbes },
    known,
    sakuraAccount,
    summary: {
      selfHostedUp: Boolean(selfProbe && selfProbe.up),
      sakuraRunning: sakuraAlive,
      sakuraTunnels: sakuraProbes.length,
      sakuraUp: sakuraProbes.filter((t) => t.probe && t.probe.up).length,
      knownUp: known.filter((x) => x.probe && x.probe.up).length,
      knownTotal: known.length,
      accountTotal: sakuraAccount.total || 0,
      accountOnline: sakuraAccount.online || 0,
      accountError: sakuraAccount.available ? null : (sakuraAccount.error || "unavailable")
    }
  }
}

/** 后台缓存：/health 每次请求都探测会拖慢 peer 探测，这里 60s 刷新一次。 */
export function createTunnelCache({ repo, home, refreshMs = 60_000, log } = {}) {
  let value = null
  let timer = null
  let running = false
  const file = home ? join(home, 'TUNNEL.json') : null
  const refresh = async () => {
    if (running) return value
    running = true
    try {
      value = await collectTunnels({ repo, home })
      if (file) {
        try {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(file, JSON.stringify(value, null, 2))
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      if (log) log('tunnel cache: ' + String(error?.message || error))
    } finally {
      running = false
    }
    return value
  }
  return {
    start() {
      refresh().catch(() => {})
      timer = setInterval(() => refresh().catch(() => {}), refreshMs)
      if (timer.unref) timer.unref()
      return this
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    get() {
      return value
    },
    refresh
  }
}
