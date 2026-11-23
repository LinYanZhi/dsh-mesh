// @generated 2026-11-23 P1：直读会话/定时任务注册表
// [why] 跨机委托前，dsh 需要看到目标机哪些会话在跑、最近活跃、是否被定时任务
//       保护；以前只有分散的 host_sessions / peer-inspect，对端 AI 还要自己猜。
//       这里只读本地 host bridge + schedule.json，返回元数据，不注入/不改任何会话。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHostClient, hostInstances } from './host-agent.js'
import { dshHomeOf } from './session-profile.js'

const SCHEDULE_CACHE = new Map()
const MAX_TITLE = 200

const text = (value, max = MAX_TITLE) => String(value == null ? '' : value).slice(0, max)

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function iso(value) {
  const ms = toMs(value)
  return ms > 0 ? new Date(ms).toISOString() : ''
}

/** Read one instance's schedule.json, cached by mtime+size. Never returns prompts. */
export function readScheduleTasks(hostEntry) {
  const home = dshHomeOf(hostEntry)
  if (!home) return []
  const file = join(home, 'storages', 'schedule.json')
  if (!existsSync(file)) return []
  let stat
  try {
    stat = statSync(file)
  } catch {
    return []
  }
  const cached = SCHEDULE_CACHE.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.tasks
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A malformed/half-written schedule file must not break the read-only registry.
    return []
  }
  const tasks = []
  const table = raw?.tables?.tasks
  if (table && typeof table === 'object') {
    for (const [taskId, entry] of Object.entries(table)) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry.record && typeof entry.record === 'object' ? entry.record : {}
      const sessionIds = new Set()
      for (const id of Array.isArray(entry.involvedSessionIds) ? entry.involvedSessionIds : []) {
        if (typeof id === 'string' && id) sessionIds.add(id)
      }
      if (typeof entry.target?.sessionId === 'string' && entry.target.sessionId) sessionIds.add(entry.target.sessionId)
      if (typeof record.sessionId === 'string' && record.sessionId) sessionIds.add(record.sessionId)
      const last = entry.lastDelivery && typeof entry.lastDelivery === 'object' ? entry.lastDelivery : {}
      tasks.push({
        taskId,
        title: text(record.title),
        kind: text(record.kind, 40),
        status: text(entry.status, 40),
        instance: text(hostEntry?.id, 40),
        sessionIds: [...sessionIds],
        rrule: text(record.rrule, 300),
        nextRunAt: iso(record.scheduledAt),
        lastRunAt: iso(last.deliveredAt || last.scheduledAt),
        lastScheduledAt: iso(last.scheduledAt),
        createdAt: iso(entry.createdAt),
        updatedAt: iso(entry.updatedAt)
      })
    }
  }
  SCHEDULE_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, tasks })
  return tasks
}

function enabledHosts(config) {
  return hostInstances(config).filter((entry) => entry.enabled !== false)
}

function resolveHosts(config, instance) {
  const list = enabledHosts(config)
  if (!instance || instance === 'all') return list
  const found = list.find((entry) => entry.id === instance)
  if (!found) {
    const known = list.map((entry) => entry.id).join(', ') || '(none)'
    const error = new Error(`unknown DSH instance "${instance}"; known: ${known}`)
    error.code = 'E_UNKNOWN_INSTANCE'
    throw error
  }
  return [found]
}

/** Flat schedule list for one/all instances, read-only. */
export function collectSchedules(config, { instance = 'all' } = {}) {
  const tasks = []
  const errors = []
  for (const entry of resolveHosts(config, instance)) {
    try {
      tasks.push(...readScheduleTasks(entry))
    } catch (error) {
      errors.push({ instance: entry.id, error: error?.message || String(error) })
    }
  }
  tasks.sort((a, b) => (a.title || a.taskId).localeCompare(b.title || b.taskId))
  return { count: tasks.length, tasks, errors }
}

/** sessionId -> schedule metadata[], scoped to one instance. */
function schedulesFor(hostEntry) {
  const bySession = new Map()
  let tasks = []
  try {
    tasks = readScheduleTasks(hostEntry)
  } catch {
    return bySession
  }
  for (const task of tasks) {
    for (const sessionId of task.sessionIds) {
      const rows = bySession.get(sessionId) || []
      rows.push(task)
      bySession.set(sessionId, rows)
    }
  }
  return bySession
}

/**
 * Aggregate host_sessions across instances and join schedule metadata.
 * Read-only: no session creation, no prompt injection, no writes.
 */
export async function collectSessions(ctx, {
  instance = 'all',
  filter = 'all',
  limit = 50,
  includeEnded = true,
  workspace = ''
} = {}) {
  const entries = resolveHosts(ctx.getConfig(), instance)
  const sessions = []
  const errors = []
  const wanted = Number(limit) > 0 ? Math.min(Number(limit), 200) : 50
  for (const entry of entries) {
    const bySession = schedulesFor(entry)
    try {
      const client = createHostClient({
        config: ctx.getConfig(),
        home: ctx.home,
        log: ctx.log,
        instance: entry.id,
        peerId: ctx.peerId
      })
      const data = await client.sessions({ limit: wanted, includeEnded, workspace })
      for (const session of data.sessions || []) {
        const sessionId = String(session.sessionId || '')
        if (!sessionId) continue
        const schedules = bySession.get(sessionId) || []
        const sessionMs = toMs(session.updatedAt) || toMs(session.createdAt)
        const scheduleMs = schedules.reduce((max, task) => Math.max(max, toMs(task.lastRunAt), toMs(task.updatedAt)), 0)
        const lastActivityMs = Math.max(sessionMs, scheduleMs)
        const lastActivitySource = scheduleMs > sessionMs ? 'schedule' : 'session'
        sessions.push({
          sessionId,
          title: text(session.title),
          cwd: text(session.cwd, 1000),
          state: text(session.state, 40),
          running: session.running === true || session.state === 'working',
          agentAvailable: session.agentAvailable === true,
          live: session.live === true,
          persisted: session.persisted === true,
          instance: entry.id,
          lastActivityAt: iso(lastActivityMs),
          lastActivitySource,
          protected: schedules.length > 0,
          scheduled: schedules.length > 0,
          schedules: schedules.map((task) => ({
            taskId: task.taskId,
            title: task.title,
            kind: task.kind,
            status: task.status,
            nextRunAt: task.nextRunAt,
            lastRunAt: task.lastRunAt
          })),
          _lastActivityMs: lastActivityMs
        })
      }
    } catch (error) {
      errors.push({ instance: entry.id, error: error?.message || String(error) })
    }
  }
  let filtered = sessions
  if (filter === 'running') filtered = filtered.filter((session) => session.running)
  else if (filter === 'scheduled' || filter === 'protected') filtered = filtered.filter((session) => session.scheduled)
  else if (filter !== 'all') {
    const error = new Error(`unknown filter "${filter}"`)
    error.code = 'E_INVALID_ARG'
    throw error
  }
  filtered.sort((a, b) => b._lastActivityMs - a._lastActivityMs || a.sessionId.localeCompare(b.sessionId))
  const out = filtered.slice(0, wanted).map(({ _lastActivityMs, ...session }) => session)
  return { count: out.length, sessions: out, errors }
}

/** sessionId -> schedule links for one/all instances. */
export function collectScheduleLinks(config, { instance = 'all' } = {}) {
  const links = new Map()
  const errors = []
  for (const entry of resolveHosts(config, instance)) {
    let tasks = []
    try {
      tasks = readScheduleTasks(entry)
    } catch (error) {
      errors.push({ instance: entry.id, error: error?.message || String(error) })
      continue
    }
    for (const task of tasks) {
      for (const sessionId of task.sessionIds) {
        const rows = links.get(sessionId) || []
        rows.push(task)
        links.set(sessionId, rows)
      }
    }
  }
  return { count: links.size, links: Object.fromEntries(links), errors }
}
