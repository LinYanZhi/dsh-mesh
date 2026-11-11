// @generated mesh-delegate/common: 共享常量与工具函数
//
// 为什么拆：`scripts/mesh-delegate.mjs` 到 2026-10-25 已 819 行（仓库建议单文件不超过 600 行），
// CLI 分发 / 各子命令 / 跨机助手全混在一起，改一处要在 800 行里翻。现按职责拆到
// `scripts/lib/mesh-delegate/`（common / delegate / tasks / inspect / cli），本文件只放
// 所有子命令都要用的东西；函数体与原文件逐字一致（纯搬移，不改行为）。
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { loadConfig, meshHome } from '../../../src/core/config.js'
import { loadPeers } from '../../../src/core/pairing.js'
import { callPeerTool } from '../../../src/core/peer-client.js'
import { joinRemote } from '../../../src/core/remote-path.js'

export const HOME = meshHome()
export const REGISTRY = join(HOME, 'delegations.json')
export const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/**
 * 2026-11-06：防「长任务被误判失败 → 重复委托 → 重复执行」。
 * 同一目标 node + 同一 goal（trim 后严格相等）+ 仍是未终态任务 + 30 分钟内 → 视为重复，返回已有任务。
 * `--force` 时调用方跳过本检查（人工确认要并行跑两份）。
 */
export function findActiveDuplicate(data, { node, goal, withinMs = 30 * 60 * 1000 } = {}) {
  const text = String(goal || '').trim()
  if (!text) return null
  const nowMs = Date.now()
  for (const task of Object.values(data?.tasks || {})) {
    if (!task || task.node !== node) continue
    if (TERMINAL.has(task.state)) continue
    if (String(task.goal || '').trim() !== text) continue
    const at = Date.parse(task.createdAt || task.updatedAt || '')
    if (!Number.isFinite(at) || nowMs - at > withinMs) continue
    return task
  }
  return null
}

export const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback
}
export const has = (name) => process.argv.includes(`--${name}`)
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
export const now = () => new Date().toISOString()

/**
 * Read a possibly-Chinese argument. Windows PowerShell -> node.exe argv is not
 * guaranteed UTF-8 (GBK bytes arrive as mojibake), so any non-ASCII payload MUST
 * use `--<name>-file` with a UTF-8 file. ASCII `--<name>` stays supported.
 */
export const textArg = (name) => {
  const file = arg(`${name}-file`)
  if (file) return readFileSync(resolve(file), 'utf8')
  return arg(name, '')
}
export const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
export const writeJson = (file, data) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
export const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
export const shortId = (prefix) => `${prefix}-${stamp()}-${randomUUID().slice(0, 4)}`

export function registry(home = HOME) {
  const file = join(home, 'delegations.json')
  const data = readJson(file, null)
  if (data && data.version === 1) return data
  const fresh = { version: 1, conversations: {}, tasks: {} }
  writeJson(file, fresh)
  return fresh
}
export const saveRegistry = (data, home = HOME) => writeJson(join(home, 'delegations.json'), data)

/**
 * 串行化读-改-写。2026-10-27 事故：同时向两个节点发委托时，两个进程各自 registry() 读旧值再 saveRegistry()，
 * 后写者覆盖前写者 → 本地注册表丢 taskId（status 报 unknown taskId，但任务其实已在执行）。
 * 现在所有写盘走这里：`delegations.json.lock` 独占创建 → 锁内重新读 → mutator → 临时文件 + rename 原子替换。
 * 锁超过 30s 视为残留（进程崩溃）自动清理；等锁最多 5s，超时报错而不是静默丢数据。
 */
export function updateRegistry(mutate, home = HOME) {
  const file = join(home, 'delegations.json')
  const lockPath = `${file}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + 5000
  let fd
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) unlinkSync(lockPath)
      } catch {
        /* 锁刚被释放 */
      }
      if (Date.now() > deadline) throw new Error('delegations.json lock timeout (5s) — another mesh-delegate is writing')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
    }
  }
  try {
    const data = registry(home)
    const next = mutate(data) || data
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return next
  } finally {
    closeSync(fd)
    try {
      unlinkSync(lockPath)
    } catch {
      /* 已被清理 */
    }
  }
}

export function peerByName(name) {
  const peers = loadPeers(HOME).items || []
  const peer = peers.find((item) => item.name === name || item.id === name)
  if (!peer) throw new Error(`unknown peer "${name}" — known: ${peers.map((item) => item.name || item.id).join(', ') || '(none)'}`)
  return peer
}

export async function peerCall(peer, tool, args = {}, timeoutMs = 20000) {
  const out = await callPeerTool(peer, { tool, args, timeoutMs })
  const text = out.result?.content?.[0]?.text || ''
  if (!out.ok) throw new Error(`${tool} failed: ${text}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

/**
 * Like peerCall, but never throws for a tool-level failure: returns the error
 * code/message so the caller can branch on it (e.g. cancel() distinguishes an
 * old peer without the tool from an ACL denial). Transport failures still throw.
 */
export async function peerToolCall(peer, tool, args = {}, timeoutMs = 20000) {
  const out = await callPeerTool(peer, { tool, args, timeoutMs })
  const text = out.result?.content?.[0]?.text || ''
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  const code = String(data?.code || '')
  return { ok: out.ok && code === '', code, message: String(data?.message || text || ''), data }
}

export async function peerContext(peer) {
  const self = await peerCall(peer, 'mesh_self')
  let agents = []
  try {
    const hosts = await peerCall(peer, 'host_instances')
    for (const host of hosts.instances || []) {
      if (!host.alive) continue
      try {
        const listed = await peerCall(peer, 'host_sessions', { instance: host.id, limit: 200, includeEnded: false })
        for (const session of listed.sessions || []) {
          if (session.agentAvailable !== true) continue
          agents.push({
            id: session.sessionId,
            instance: host.id,
            status: session.state === 'working' ? 'running' : 'idle',
            title: session.title || '',
            cwd: session.cwd || '',
            seq: 0,
            updatedAt: session.updatedAt || 0
          })
        }
      } catch {
        const listed = await peerCall(peer, 'channel_agents', { instance: host.id })
        for (const agent of listed.agents || []) agents.push({ ...agent, instance: host.id, updatedAt: 0 })
      }
    }
  } catch {
    const listed = await peerCall(peer, 'channel_agents')
    agents = (listed.agents || []).map((agent) => ({ ...agent, updatedAt: 0 }))
  }
  return {
    fsRoot: self.acl?.fsRoots?.[0]?.path || '',
    meshVersion: self.mesh?.version || '',
    agents
  }
}

export function localFsRoot() {
  const config = loadConfig(HOME)
  const root = config.acl?.fsRoots?.[0]
  if (!root) throw new Error('local config has no acl.fsRoots[0]')
  return root
}

export function localNodeName() {
  const config = loadConfig(HOME)
  return config.node?.name || 'local'
}

/** fsRoots 条目既可能是字符串，也可能是 { path, basename }（历史版本），统一取字符串。 */
export function normalizeFsRoot(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.path === 'string') return entry.path
  return ''
}

/** 对端根是 POSIX 绝对路径（/root/workspace）时用 posix 拼接，避免 Windows 的 path.join 产生反斜杠。 */
// 对端路径统一用共享实现 src/core/remote-path.js：`/` 与 `\` 都支持。
// 旧实现在 Linux 上会对 Windows 路径调 posix.join（拼成混合分隔符/相对路径），是同类 bug 的源头。
export const remoteJoin = joinRemote

export function taskPaths(task, peerRoot) {
  return {
    requestLocal: join(localFsRoot(), '.mesh', 'tasks', task.taskId, 'request.json'),
    statusRemote: remoteJoin(peerRoot, '.mesh', 'tasks', task.taskId, 'status.json'),
    resultRemote: remoteJoin(peerRoot, '.mesh', 'tasks', task.taskId, 'result.json')
  }
}

export function wakeText(task, peerRoot) {
  const requestInline = JSON.stringify(
    { taskId: task.taskId, conversationId: task.conversationId, from: task.from, to: task.node, dedicated: task.dedicated === true, workspace: task.workspace || '', goal: task.goal, scope: task.scope, acceptance: task.acceptance, sessionPolicy: task.policy },
    null,
    2
  )
  return `[dsh-mesh delegation]
taskId=${task.taskId}
conversationId=${task.conversationId}
from=${task.from}
policy=${task.policy}
dedicated=${task.dedicated === true}

请求内容（与 request.json 等价，可直接按它执行）：
${requestInline}

1) 可选：读请求原文（只读）：${task.paths.requestLocal}  （用对端 fs_read）
2) 按 goal / scope / acceptance 执行。
3) 状态写到：${join(peerRoot, '.mesh', 'tasks', task.taskId, 'status.json')}
   形如 {"taskId":"${task.taskId}","state":"accepted|working|question|done|failed","question":"...","error":"...","summary":"...","heartbeatAt":"ISO"}
   完成时再写 ${join(peerRoot, '.mesh', 'tasks', task.taskId, 'result.json')}（JSON，含证据/产物路径）。
4) 长任务：每 30~60 秒更新一次 status.json（至少 heartbeatAt），让协调者能区分 working 与 stalled。
5) 需要澄清：写 state=question + question 字段，然后停止；协调者会回复并唤醒本会话继续。
6) 不要 kill 进程、不要 push、不要改无关文件。
  7) 协议产物例外：本任务要求写 status.json / result.json 属于委托协议握手，**必须写**；即使 goal 写着「只读 / 不要写文件」，这两个文件仍要写（它们是协调者判断完成的唯一依据）。`
}

export async function readRemoteJson(peer, path) {
  try {
    const out = await peerCall(peer, 'fs_read', { path })
    const content = out.content
    if (typeof content !== 'string') return null
    return JSON.parse(content)
  } catch {
    return null
  }
}

/** 当前 DSH 实例名：优先从 DSH_HOME（如 ~/.dsh0）推导，其次 DSH_INSTANCE；无法判断返回 'unknown'。 */
export function instanceName() {
  const home = String(process.env.DSH_HOME || '').replace(/[\\/]+$/, '')
  const base = home.split(/[\\/]/).pop() || ''
  if (/^\.?dsh\d+$/i.test(base)) return base.replace(/^\./, '')
  const inst = String(process.env.DSH_INSTANCE || '').trim()
  return /^[A-Za-z0-9_.-]{1,40}$/.test(inst) ? inst : 'unknown'
}