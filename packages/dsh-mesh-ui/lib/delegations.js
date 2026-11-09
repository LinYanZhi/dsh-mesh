// dsh-mesh-ui — 委托面板数据层（只读）
//
// 供设置页「AI 网络」之外的独立面板使用：委托列表 / 单任务状态 / 对端会话正文。
// 全部只读：
//   - 列表：读本地 ~/.dsh-mesh/delegations.json
//   - 任务状态：跑 `mesh-delegate.mjs status <taskId>`（只读查询，不改变对端）
//   - 会话正文：走对端 session_history 只读工具（解压会话日志，无模型往返）
//
// 归宿：reusable（dsh-mesh/plugin/dsh-mesh-ui/lib/）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliJson, meshHome, nodeExec, resolveRepo, run, unwrapPeerCall } from './collect.js'

export const NODE_LABELS = {}

export function nodeLabel(name) {
  return NODE_LABELS[String(name || '').toLowerCase()] || String(name || '未知节点')
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 委托列表（本地台账，按更新时间倒序）。 */
export function listDelegations(limit = 50) {
  const data = readJson(join(meshHome(), 'delegations.json'), { tasks: {} })
  const localNode = readJson(join(meshHome(), 'config.json'), {})?.node?.name || ''
  const tasks = Object.values(data?.tasks || {}).map((task) => {
    const start = Date.parse(task.createdAt || '')
    const end = Date.parse(task.updatedAt || '') || Date.now()
    const from = task.from || ''
    return {
      taskId: task.taskId || '',
      conversationId: task.conversationId || '',
      sessionId: task.sessionId || '',
      from,
      fromLabel: nodeLabel(from),
      fromIsLocal: Boolean(from) && from === localNode,
      fromInstance: task.fromInstance || '',
      node: task.node || '',
      nodeLabel: nodeLabel(task.node),
      toIsLocal: Boolean(task.node) && task.node === localNode,
      instance: task.instance || '',
      workspace: task.workspace || '',
      dedicated: Boolean(task.dedicated),
      state: task.state || 'unknown',
      startedAt: task.startedAt || '',
      finishedAt: task.finishedAt || '',
      isActive: ['working', 'submitted', 'accepted', 'question', 'provisioning', 'running'].indexOf(task.state || '') >= 0,
      activeFresh: ['working', 'submitted', 'accepted', 'question', 'provisioning', 'running'].indexOf(task.state || '') >= 0 && (Date.now() - Date.parse(task.updatedAt || 0) < 12 * 3600 * 1000),
      displayAt: task.finishedAt || task.updatedAt || '',
      policy: task.requestedPolicy || task.policy || '',
      goal: String(task.goal || ''),
      createdAt: task.createdAt || '',
      updatedAt: task.updatedAt || '',
      durationSec: (() => {
        if (!Number.isFinite(start)) return null
        const value = Math.max(0, Math.round((end - start) / 1000))
        return value > 12 * 3600 ? null : value // 台账 updatedAt 会被轮询刷新，超长值不可信
      })(),
      stalledReason: task.stalledReason || '',
      lastSummary: task.summary || ''
    }
  })
  tasks.sort((a, b) => {
    if (a.activeFresh !== b.activeFresh) return a.activeFresh ? -1 : 1
    return String(b.displayAt || b.updatedAt || '').localeCompare(String(a.displayAt || a.updatedAt || ''))
  })
  const byState = {}
  for (const task of tasks) byState[task.state] = (byState[task.state] || 0) + 1
  return { total: tasks.length, byState, localNode, tasks: tasks.slice(0, Math.max(1, Math.min(limit, 200))) }
}

/** 对端是 POSIX 时把 Windows 拼接产生的 \root\Code\... 归一化成 /root/workspace/...。 */

/** 读对端某个 JSON 文件（只读 fs_read，路径来自本地台账 task.paths）。 */
async function readPeerJson(repo, node, filePath) {
  if (!repo || !node || !filePath) return null
  const args = JSON.stringify({ path: String(filePath) })
  const { stdout } = await run(nodeExec(), [join(repo, 'src', 'cli.js'), 'peer', 'call', 'fs_read', '--to', String(node), '--args', args], { cwd: repo, timeout: 15_000, env: { ...process.env } })
  const start = String(stdout || '').indexOf('{')
  if (start < 0) return null
  try {
    const wrapper = JSON.parse(String(stdout).slice(start))
    const payload = unwrapPeerCall(wrapper)
    if (!payload || payload.ok === false) return null
    const content = payload.content ?? payload.text ?? payload
    if (typeof content === 'string') { try { return JSON.parse(content) } catch { return null } }
    return content && typeof content === 'object' ? content : null
  } catch {
    return null
  }
}

/** 从对端产物里算真实时间线（request.requestedAt → status.updatedAt）。 */
async function artifactTimeline(repo, node, taskId) {
  const data = readJson(join(meshHome(), 'delegations.json'), { tasks: {} })
  const task = data?.tasks?.[taskId]
  const paths = task?.paths || {}
  const requestLocal = paths.requestLocal || paths.request || ''
  const statusRemote = paths.statusRemote || paths.status || ''
  const [request, status] = await Promise.all([
    Promise.resolve(requestLocal && !/^[A-Za-z]:\\\\/.test(requestLocal) === false ? readJson(requestLocal, null) : readJson(requestLocal, null)),
    readPeerJson(repo, node, statusRemote)
  ])
  const requestedAt = request?.requestedAt || task?.createdAt || ''
  const finishedAt = status?.updatedAt || status?.heartbeatAt || ''
  const startMs = Date.parse(requestedAt)
  const endMs = Date.parse(finishedAt)
  const durationSec = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : null
  return { requestedAt, finishedAt, durationSec, state: status?.state || '', summary: status?.summary || '', error: status?.error || '' }
}

/** 单任务状态 + 详情（只读；对端产物 + 会话元信息 + 时间线）。 */
export async function taskStatus(taskId) {
  const repo = resolveRepo()
  if (!repo) return { ok: false, error: 'dsh-mesh repo not found' }
  if (!/^[A-Za-z0-9._:-]{4,120}$/.test(String(taskId || ''))) return { ok: false, error: 'invalid taskId' }
  const registry = readJson(join(meshHome(), 'delegations.json'), { tasks: {} })
  const entry = registry?.tasks?.[String(taskId)] || null
  const node = entry?.node || ''
  const paths = entry?.paths || {}

  const { error, stdout, stderr } = await run(nodeExec(), [join(repo, 'scripts', 'mesh-delegate.mjs'), 'status', String(taskId)], {
    cwd: repo,
    timeout: 45_000,
    env: { ...process.env }
  })
  const start = String(stdout || '').indexOf('{')

  // 对端产物（status.json / result.json）+ 本机 request.json + 对端会话元信息，全部并发
  const [requestJson, statusJson, resultJson, sessionMeta] = node
    ? await Promise.all([
        Promise.resolve(paths.requestLocal ? readJson(paths.requestLocal, null) : null),
        readPeerJson(repo, node, posixPath(paths.statusRemote || paths.status)),
        readPeerJson(repo, node, posixPath(paths.resultRemote || paths.result)),
        entry?.sessionId ? sessionHistory(node, entry.sessionId, 1).then((r) => (r.ok ? { totalMessages: r.payload?.totalMessages ?? 0, frameCount: r.payload?.frameCount ?? 0, bytes: r.payload?.bytes ?? 0, title: r.payload?.title || '' } : null)).catch(() => null) : Promise.resolve(null)
      ])
    : [null, null, null, null]

  const seconds = (from, to) => {
    const a = Date.parse(from || '')
    const b = Date.parse(to || '')
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null
  }
  const requestedAt = requestJson?.requestedAt || entry?.createdAt || ''
  const startedAt = statusJson?.startedAt || statusJson?.heartbeatAt || statusJson?.updatedAt || ''
  const finishedAt = statusJson?.updatedAt || resultJson?.completedAt || ((statusJson?.state === 'done' || statusJson?.state === 'failed' || statusJson?.state === 'cancelled') ? statusJson?.heartbeatAt || '' : '')
  const heartbeatAt = statusJson?.heartbeatAt || ''
  const detail = {
    request: requestJson,
    status: statusJson,
    result: resultJson,
    session: sessionMeta,
    timeline: {
      requestedAt,
      startedAt,
      heartbeatAt,
      finishedAt,
      responseSec: seconds(requestedAt, heartbeatAt || startedAt),
      execSec: seconds(startedAt, finishedAt),
      totalSec: seconds(requestedAt, finishedAt)
    },
    // 对端做过哪些操作 / 权限范围（来自 result.json 与 request.json 的协议字段）
    operations: {
      commandsRun: Array.isArray(resultJson?.commandsRun) ? resultJson.commandsRun : [],
      evidence: Array.isArray(resultJson?.evidence) ? resultJson.evidence : [],
      notes: resultJson?.notes || resultJson?.readonlyEvidence || '',
      readonly: resultJson?.readonly === true,
      scope: requestJson?.scope || '',
      acceptance: requestJson?.acceptance || '',
      sessionPolicy: requestJson?.sessionPolicy || '',
      targetInstance: requestJson?.instance || entry?.instance || '',
      workspace: requestJson?.workspace || entry?.workspace || ''
    },
    artifacts: statusJson && requestJson
      ? { requestedAt, finishedAt, durationSec: seconds(requestedAt, finishedAt), state: statusJson.state || '', summary: statusJson.summary || '', error: statusJson.error || '' }
      : null
  }

  if (start < 0) {
    return {
      ok: true,
      degraded: true,
      error: error || 'mesh-delegate status 未返回 JSON（对端可能离线或超时）',
      status: entry
        ? { state: entry.state, sessionState: '', staleSeconds: null, error: 'status.json 未取到', summary: entry.goal ? '（台账）' + String(entry.goal).slice(0, 200) : '' }
        : { state: 'unknown', sessionState: '', staleSeconds: null, error: '台账里也没有该任务' },
      artifacts: detail.artifacts,
      detail
    }
  }
  try {
    const status = JSON.parse(String(stdout).slice(start))
    return { ok: true, status, artifacts: detail.artifacts, detail }
  } catch {
    return { ok: false, error: 'task status JSON parse failed', stderr: String(stderr || '').slice(-400) }
  }
}

/** 对端会话正文（只读；走 session_history，最多 200 条消息）。 */
export async function sessionHistory(node, sessionId, limit = 40) {
  const repo = resolveRepo()
  if (!repo) return { ok: false, error: 'dsh-mesh repo not found' }
  if (!/^[A-Za-z0-9._:-]{1,40}$/.test(String(node || ''))) return { ok: false, error: 'invalid node' }
  if (!/^[A-Za-z0-9._-]{8,120}$/.test(String(sessionId || ''))) return { ok: false, error: 'invalid sessionId' }
  const lines = Math.min(Math.max(Number(limit) || 40, 1), 200)
  const args = JSON.stringify({ sessionId: String(sessionId), limit: lines })
  const { error, stdout, stderr } = await run(
    nodeExec(),
    [join(repo, 'src', 'cli.js'), 'peer', 'call', 'session_history', '--to', String(node), '--args', args],
    { cwd: repo, timeout: 60_000, env: { ...process.env } }
  )
  const start = String(stdout || '').indexOf('{')
  if (start >= 0) {
    try {
      const wrapper = JSON.parse(String(stdout).slice(start))
      const payload = unwrapPeerCall(wrapper)
      if (payload?.ok === true) return { ok: true, payload }
      return { ok: false, error: payload?.message || 'session_history failed', payload }
    } catch {
      /* fall through */
    }
  }
  return { ok: false, error: error || 'session_history returned no JSON', stderr: String(stderr || '').slice(-400) }
}

export { cliJson }
