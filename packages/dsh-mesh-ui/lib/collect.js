// dsh-mesh-ui — 数据采集（服务端半，后台异步跑）
//
// 目标：给设置页「AI 网络」提供一份**够用但轻**的数据：
//   - mesh-health --json（节点/peer/实例/诊断，权威口径）
//   - 本机实例的模型（解析 <dshN>/profiles/web/cordis.patch.yml 的 agent-default-model）
//   - 每实例活跃会话数 / 运行中数（host status / host_self 的 agents）
//   - 最近委托任务（~/.dsh-mesh/delegations.json）
//   - 告警历史（~/.dsh-mesh/alerts.jsonl 尾部 N 条 + ALERT.json 最新）
//
// 为什么不在 HTTP handler 里算：2026-11-06 实测 spawnSync 会堵死 DSH host 事件循环，
// 而 mesh-health 又要探测同进程的 host bridge（9100/9101）→ 自死锁。所以本模块只在
// 后台刷新时被调用，handler 只读缓存。
//
// 归宿：reusable（dsh-mesh/plugin/dsh-mesh-ui/lib/collect.js）

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { arch as osArch, cpus as osCpus, freemem as osFreemem, homedir, platform as osPlatform, release as osRelease, totalmem as osTotalmem } from 'node:os'
import { join } from 'node:path'

const CLI_TIMEOUT_MS = 25_000
const ALERT_HISTORY_MAX = 12
const DELEGATION_RECENT_MAX = 8

export function meshHome() {
  return process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
}

export function resolveRepo() {
  const candidates = [process.env.DSH_MESH_REPO, join(homedir(), 'Code', 'dsh-mesh'), join(homedir(), 'Desktop', 'dsh-mesh')].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'scripts', 'mesh-health.mjs'))) return candidate
  }
  return null
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 异步跑子进程（永不阻塞事件循环）。 */
/**
 * 子进程应使用的 Node 可执行文件。
 * 桌面版 Host 跑在 Electron Node 模式下，process.execPath 是 Electron 本体；
 * 直接 spawn 它会拉起 GUI，必须带 ELECTRON_RUN_AS_NODE=1（见 run()）或改用系统 node。
 * 可用 DSH_NODE_EXEC 显式指定。
 */
export function nodeExec() {
  if (process.env.DSH_NODE_EXEC) return process.env.DSH_NODE_EXEC
  return process.execPath
}

export function run(file, args, { cwd, timeout = CLI_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
          {
            cwd,
            timeout,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            encoding: 'utf8',
            env: (function () {
              var childEnv = Object.assign({}, env || process.env)
              // 桌面版（Electron）里 process.execPath 是 Electron 本体；以 Node 模式运行脚本，否则会拉起 GUI
              if (process.versions.electron && String(file) === String(process.execPath)) childEnv.ELECTRON_RUN_AS_NODE = '1'
              return childEnv
            })()
          },
      (error, stdout, stderr) => resolve({ error: error ? String(error.message || error) : null, stdout: stdout || '', stderr: stderr || '' })
    )
  })
}

/** mesh-health 是独立脚本（不是 cli 子命令），直接跑脚本拿 --json。 */
async function meshHealthJson(repo) {
  // DSH host 进程里可能继承 NODE_OPTIONS（--import tsx 等）导致子 node 起不来；子进程清理掉。
  const cleanEnv = { ...process.env }
  delete cleanEnv.NODE_OPTIONS
  delete cleanEnv.NODE_EXTRA_CA_CERTS
  const { error, stdout, stderr } = await run(nodeExec(), [join(repo, 'scripts', 'mesh-health.mjs'), '--json'], { cwd: repo, env: cleanEnv })
  // 注意：mesh-health 在 verdict≠ok 时退出码为 3（有 down 节点），execFile 会把它当 error；
  // 但只要 stdout 是完整 JSON 就必须采用——不能因为退出码丢掉真实数据（2026-11-07 踩到）。
  const start = String(stdout || '').indexOf('{')
  if (start >= 0) {
    try {
      return JSON.parse(stdout.slice(start))
    } catch {
      /* fall through to diag */
    }
  }
  if (error) return { __diag: 'spawn error: ' + error + ' | stderr: ' + String(stderr || '').slice(-300) }
  return { __diag: 'no JSON; stderr: ' + String(stderr || '').slice(-300) + '; stdout: ' + String(stdout || '').slice(-200) }
}

/** 跑 dsh-mesh CLI 并解析 JSON（cli 输出偶有前缀噪音 → 从第一个 { 开始解析）。 */
export async function cliJson(repo, args, options = {}) {
  const { error, stdout } = await run(nodeExec(), [join(repo, 'src', 'cli.js'), ...args], { cwd: repo, ...options })
  if (error) return null
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return null
  }
}

/** peer call 结果把正文塞在 result.content[0].text（JSON 字符串）里。 */
export function unwrapPeerCall(wrapper) {
  const text = wrapper?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 从 profile patch 里读 agent-default-model（最后一条为准）。 */
function instanceModel(instanceId) {
  const file = join(homedir(), `.${instanceId}`, 'profiles', 'web', 'cordis.patch.yml')
  const text = readText(file)
  if (!text) return null
  const blocks = text.split(/^- id: /m)
  const block = blocks.reverse().find((item) => item.startsWith('agent-default-model'))
  if (!block) return null
  const grab = (key) => {
    const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(block)
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null
  }
  const provider = grab('provider')
  const model = grab('model')
  if (!provider && !model) return null
  return { provider, model, reasoningEffort: grab('reasoningEffort') }
}

/** OS 标签：win32 + 版本号 → 更可读的名字（无法识别就原样拼）。 */
function osLabel(platform, releaseText) {
  const rel = String(releaseText || '')
  if (platform === 'win32') {
    const build = Number((rel.split('.').pop() || '0'))
    if (build >= 22000) return 'Windows 11 (' + rel + ')'
    if (build >= 10240) return 'Windows 10 (' + rel + ')'
    return 'Windows (' + (rel || '?') + ')'
  }
  if (platform === 'linux') return 'Linux ' + (rel || '')
  if (platform === 'darwin') return 'macOS ' + (rel || '')
  return String(platform || '?') + ' ' + rel
}

function gb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024 / 1024) * 10) / 10
}

/** 本机硬件概况（远端拿不到，需要 host_self 扩展；先只给本机）。 */
function localHardware() {
  const cpuList = osCpus()
  const first = cpuList[0] || {}
  return {
    os: osLabel(osPlatform(), osRelease()),
    arch: osArch(),
    cpuModel: String(first.model || '').replace(/\s+/g, ' ').trim(),
    cpuCores: cpuList.length,
    memTotalGB: gb(osTotalmem()),
    memFreeGB: gb(osFreemem())
  }
}

/** 判断 peer 链接走的是公网穿透、内网直连还是本机回环。 */
function tunnelOf(url) {
  try {
    const host = new URL(url).hostname
    const port = new URL(url).port
    if (host === '127.0.0.1' || host === 'localhost') return { kind: 'loopback', host, port, label: '本机回环' }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const isLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
      return { kind: isLan ? 'lan' : 'wan', host, port, label: isLan ? '内网直连' : '公网 IP' }
    }
    return { kind: 'frp', host, port, label: '公网穿透' }
  } catch {
    return { kind: 'unknown', host: '', port: '', label: '未知' }
  }
}

/** 本机 SakuraFrp 隧道公网入口：从服务日志里解析 "使用 >>host:port<<" 行。 */
function localFrpTunnels() {
  try {
    const dir = 'C:\\ProgramData\\SakuraFrpService\\Logs'
    const files = readdirSync(dir).filter((name) => name.endsWith('.log'))
    if (!files.length) return []
    files.sort()
    const latest = join(dir, files[files.length - 1])
    const text = readText(latest)
    const tail = text.slice(-400000)
    const found = new Map()
    const re = /frpc\[([^\]|]+)[^\]]*\][^\n]*?使用 >>([^\s:]+):(\d+)<</g
    let match
    while ((match = re.exec(tail))) {
      found.set(match[1].trim(), { name: match[1].trim(), host: match[2], port: match[3] })
    }
    return Array.from(found.values())
  } catch {
    return []
  }
}

/** 本机 frp 客户端是否在跑（tasklist 很快；失败就当未运行）。 */
async function frpState() {
  const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq frpc.exe', '/NH'], { timeout: 8000 })
  const count = (stdout.match(/frpc\.exe/gi) || []).length
  return { running: count > 0, frpcCount: count }
}

/** 从 agents 数组算活跃/运行数。 */
function agentStats(agents) {
  const list = Array.isArray(agents) ? agents : []
  return { sessions: list.length, running: list.filter((agent) => agent && agent.status === 'running').length }
}

/** 最近委托任务 + 统计（读本地台账；台账是 CLI/MCP 发起方写的）。 */
function delegationSummary() {
  const data = readJson(join(meshHome(), 'delegations.json'), { tasks: {} })
  const tasks = Object.values(data?.tasks || {})
  const recent = tasks
    .slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, DELEGATION_RECENT_MAX)
    .map((task) => ({
      taskId: task.taskId,
      node: task.node,
      state: task.state,
      policy: task.requestedPolicy || task.policy || '',
      goal: String(task.goal || '').slice(0, 80),
      createdAt: task.createdAt || '',
      updatedAt: task.updatedAt || '',
      durationSec: (() => {
        const start = Date.parse(task.createdAt || '')
        const end = Date.parse(task.updatedAt || '') || Date.now()
        return Number.isFinite(start) ? Math.max(0, Math.round((end - start) / 1000)) : null
      })()
    }))
  const byState = {}
  for (const task of tasks) byState[task.state || 'unknown'] = (byState[task.state || 'unknown'] || 0) + 1
  return { total: tasks.length, byState, recent }
}

/** 告警历史：alerts.jsonl 尾部 N 条（旧→新）+ 最新指针。 */
function alertSummary() {
  const latest = readJson(join(meshHome(), 'ALERT.json'), null)
  const lines = readText(join(meshHome(), 'alerts.jsonl')).split('\n').filter(Boolean)
  const history = []
  for (const line of lines.slice(-ALERT_HISTORY_MAX)) {
    try {
      const item = JSON.parse(line)
      history.push({ at: item.at || '', kind: item.kind || '', summary: item.summary || '', verdict: item.verdict || '' })
    } catch {
      /* 跳过坏行 */
    }
  }
  return {
    latest: latest?.at ? { at: latest.at, kind: latest.kind || '', summary: latest.summary || '', verdict: latest.verdict || '', peersDown: latest.peersDown || [], consecutiveBad: latest.consecutiveBad || 0 } : null,
    history
  }
}

/**
 * 采集一次完整快照。
 * @param {string} repo dsh-mesh 仓库绝对路径
 * @returns {Promise<object>} 仪表盘数据
 */
// 2026-11-07 性能：collect 原来串行跑 mesh-health(9s) + overview(21s) + mesh_self(21s) + 每 peer host_self(21s)
// → 单轮 50s+，超过 30s 刷新周期。现在：
//   1) mesh-health / overview / 本机硬件 / frp 全部**并发**启动；
//   2) overview 结果缓存 5 分钟（uptime/任务数不需要 30s 新鲜度），且单次调用超时 8s 就跳过；
//   3) 本机实例 host status、各 peer host_self 全部并发，单调用超时 6s，慢 peer 不拖垮整轮。
let overviewCache = { at: 0, byNode: {} }

function localPeerName() {
  try {
    const data = readJson(join(meshHome(), 'peers.json'), { items: [] })
    return data?.items?.[0]?.name || ''
  } catch {
    return ''
  }
}

async function overviewData(repo, force = false) {
  const now = Date.now()
  if (!force && overviewCache.byNode && now - overviewCache.at < 300_000) return overviewCache.byNode
  const calledPeer = localPeerName()
  if (!calledPeer) return overviewCache.byNode || {}
  try {
    const [ovResult, selfResult] = await Promise.all([
      cliJson(repo, ['peer', 'call', 'mesh_overview', '--to', calledPeer, '--args', '{}'], { timeout: 8000 }),
      cliJson(repo, ['peer', 'call', 'mesh_self', '--to', calledPeer, '--args', '{}'], { timeout: 8000 })
    ])
    const ov = unwrapPeerCall(ovResult)
    const self = unwrapPeerCall(selfResult)
    if (!ov) return overviewCache.byNode || {}
    const byNode = {}
    const tasksByName = {}
    for (const item of ov?.tasks?.peers || []) tasksByName[item.peer] = item.activeCount ?? null
    byNode[calledPeer] = {
      uptimeSec: self?.host?.uptimeSec ?? null,
      nodePid: null,
      nodeTools: null,
      tasksActive: ov?.tasks?.local?.active ?? null,
      instances: ov?.instances || []
    }
    for (const item of ov?.peers || []) {
      const key = item.name || item.id || ''
      if (!key) continue
      byNode[key] = {
        uptimeSec: item.uptimeSec ?? null,
        nodePid: item.pid ?? null,
        nodeTools: item.tools ?? null,
        tasksActive: tasksByName[key] ?? null,
        instances: item.instances || []
      }
    }
    overviewCache = { at: now, byNode }
    return byNode
  } catch {
    return overviewCache.byNode || {}
  }
}

/**
 * 采集一次完整快照（并发执行，单轮目标 <10s）。
 * @param {string} repo dsh-mesh 仓库绝对路径
 * @returns {Promise<object>} 仪表盘数据
 */
export async function collect(repo) {
  const generatedAt = new Date().toISOString()
  if (!repo) return { ok: false, error: 'dsh-mesh repo not found (set DSH_MESH_REPO)', generatedAt }

  const meshPromise = meshHealthJson(repo)
  const overviewPromise = overviewData(repo)
  const frpPromise = frpState()
  const hardware = localHardware()
  const frpTunnels = localFrpTunnels()
  const localConfig = readJson(join(meshHome(), 'config.json'), {})?.node || {}
  const meshTunnel = frpTunnels.find((item) => item.name === (localConfig.name || '')) || frpTunnels[0] || null

  const [mesh, ov, frp] = await Promise.all([meshPromise, overviewPromise, frpPromise])
  if (!mesh || mesh.__diag) return { ok: false, error: mesh?.__diag || 'mesh-health returned no JSON', generatedAt }
  const overviewByNode = ov || {}

  // 本机实例：mesh-health 给 up/pid/tools；host status --json 补 agents（并发）
  const localBase = mesh.local?.instances || []
  const localDetails = await Promise.all(localBase.map(async (instance) => {
    if (!instance.up) return null
    return await cliJson(repo, ['host', 'status', '--instance', instance.id, '--json'], { timeout: 6000 })
  }))
  const localInstances = localBase.map((instance, index) => {
    const detail = localDetails[index]
    const stats = agentStats(detail?.agents)
    return {
      id: instance.id,
      up: Boolean(instance.up),
      pid: instance.pid ?? detail?.node?.pid ?? null,
      tools: instance.tools ?? detail?.tools ?? null,
      model: instanceModel(instance.id),
      sessions: stats.sessions,
      running: stats.running,
      detectedAt: new Date().toISOString(),
      port: 3080 + (Number(String(instance.id || '').replace(/\D/g, '')) || 0),
      hostname: detail?.node?.hostname || '',
      error: instance.error?.code || null
    }
  })

  // 远端实例端口映射（mesh-health remoteInstances，scope=peer 名）
  const remoteByNode = {}
  for (const inst of mesh.remoteInstances || []) {
    const list = remoteByNode[inst.scope] || (remoteByNode[inst.scope] = [])
    const idx = Number(String(inst.id || '').replace(/\D/g, '')) || 0
    list.push({ id: inst.id, port: 3080 + idx, up: Boolean(inst.up) })
  }

  // 远端节点：host_self 并发（单调用超时 6s）
  const meshPeers = mesh.peers || []
  const peerSelfs = await Promise.all(meshPeers.map(async (peer) => {
    if (!peer.up) return null
    return await cliJson(repo, ['peer', 'call', 'host_self', '--to', peer.name, '--args', '{}'], { timeout: 6000 })
  }))
  const peers = meshPeers.map((peer, index) => {
    const self = unwrapPeerCall(peerSelfs[index])
    const stats = agentStats(self?.agents)
    return {
      name: peer.name,
      url: peer.url || '',
      up: Boolean(peer.up),
      latencyMs: peer.latencyMs ?? null,
      version: peer.version || null,
      tls: peer.fingerprintMatch !== false,
      instancesCount: Array.isArray(peer.instances) ? peer.instances.length : Number(peer.instances) || 0,
      instancesList: remoteByNode[peer.name] || [],
      sessions: stats.sessions,
      running: stats.running,
      hostname: self?.node?.hostname || '',
      release: self?.node?.release || '',
      os: osLabel(self?.node?.platform, self?.node?.release),
      uptimeSec: overviewByNode[peer.name]?.uptimeSec ?? null,
      nodePid: overviewByNode[peer.name]?.nodePid ?? self?.node?.pid ?? null,
      nodeTools: overviewByNode[peer.name]?.nodeTools ?? null,
      tasksActive: overviewByNode[peer.name]?.tasksActive ?? null,
      detectedAt: new Date().toISOString(),
      tunnel: tunnelOf(peer.url || ''),
      plugin: self?.plugin || '',
      error: peer.error?.code || null
    }
  })

  return {
    ok: true,
    generatedAt,
    repo,
    nodeName: localConfig.name || '',
    meshVersion: mesh.meshVersion || null,
    verdict: mesh.verdict || 'unknown',
    elapsedMs: mesh.elapsedMs ?? null,
    endpoint: mesh.endpoint || null,
    local: { instances: localInstances },
    hardware,
    frp,
    localTunnel: {
      bind: localConfig.bind || '',
      port: localConfig.port || null,
      tls: Boolean(localConfig.tls?.enabled),
      frpRunning: Boolean(frp.running),
      frpcCount: frp.frpcCount || 0,
      tunnels: frpTunnels,
      publicEntry: meshTunnel
    },
    peers,
    remoteInstances: mesh.remoteInstances || [],
    versionMismatch: mesh.versionMismatch || [],
    issues: mesh.issues || [],
    hints: mesh.hints || [],
    frpFlaps: mesh.frpFlaps ?? null,
    delegations: delegationSummary(),
    alerts: alertSummary()
  }
}