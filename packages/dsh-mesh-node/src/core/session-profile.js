import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Delegation safety profile (2026-10-25).
 *
 * A peer must never inject a task into a session that owns a scheduled job:
 * that mixes two contexts and pollutes the scheduled conversation (real
 * incident: a `channel_wake` landed inside a company `定时-*` session).
 *
 * The profile joins two local sources of truth:
 *   - `<dshHome>/storages/schedule.json`      schedules  -> sessionId
 *   - `<fsRoot>/.mesh/tasks/<taskId>/request.json` delegations -> sessionId
 *
 * A session is *protected* when it owns at least one schedule record.
 * Delegations are the sessions this node created for a peer, so they are
 * identified explicitly instead of being guessed from titles.
 */

const TITLE_SCHEDULE_HINT = /定时|班次|schedule|nightly/i
const EMPTY = Object.freeze([])

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** `<home>/profiles/web` -> `<home>`; empty/unknown profileDir -> ''. */
export function dshHomeOf(hostEntry) {
  const dir = String(hostEntry?.profileDir || '')
  if (!dir) return ''
  return dirname(dirname(dir))
}

/** sessionId -> [{id,title,kind,status,instance}] for one configured instance. */
export function readScheduleIndex(hostEntry) {
  const home = dshHomeOf(hostEntry)
  const file = home ? join(home, 'storages', 'schedule.json') : ''
  const index = new Map()
  const raw = file && existsSync(file) ? readJson(file) : null
  const tasks = raw?.tables?.tasks || {}
  for (const [id, entry] of Object.entries(tasks)) {
    const sessionId = entry?.sessionId
    if (!sessionId) continue
    const record = entry.record || {}
    const rows = index.get(sessionId) || []
    rows.push({
      id,
      title: record.title || '',
      kind: record.kind || '',
      status: entry.status || '',
      instance: hostEntry?.id || ''
    })
    index.set(sessionId, rows)
  }
  return index
}

/** sessionId -> delegation record from this node's `.mesh/tasks` mailbox. */
export function readDelegationIndex(root) {
  const dir = root ? join(root, '.mesh', 'tasks') : ''
  const index = new Map()
  if (!dir || !existsSync(dir)) return index
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return index
  }
  for (const name of names) {
    const request = readJson(join(dir, name, 'request.json'))
    if (!request?.sessionId) continue
    index.set(request.sessionId, {
      taskId: request.taskId || name,
      conversationId: request.conversationId || '',
      from: request.from || '',
      policy: request.sessionPolicy || '',
      createdAt: request.requestedAt || ''
    })
  }
  return index
}

/** Join every configured instance's schedules plus this node's delegations. */
export function buildSessionProfile(config) {
  const schedules = new Map()
  for (const entry of config?.hosts || []) {
    if (entry?.enabled === false) continue
    for (const [sessionId, rows] of readScheduleIndex(entry)) {
      const merged = schedules.get(sessionId) || []
      merged.push(...rows.map((row) => ({ ...row, instance: entry.id })))
      schedules.set(sessionId, merged)
    }
  }
  return { schedules, delegations: readDelegationIndex(config?.acl?.fsRoots?.[0] || '') }
}

/** Classify one host_sessions / delegate_candidates / listAgents row. */
export function classifySession(profile, session) {
  const sessionId = session?.sessionId || session?.id || ''
  const schedules = profile?.schedules?.get(sessionId) || EMPTY
  const delegation = profile?.delegations?.get(sessionId) || null
  const title = String(session?.title || '')
  const alive = session?.agentAvailable === true && session?.state !== 'ended'
  let kind = 'unknown'
  let reason = 'no schedule record and no delegation record'
  if (schedules.length > 0) {
    kind = 'business-scheduled'
    reason = `owns ${schedules.length} scheduled task(s) — injecting here would pollute the scheduled conversation`
  } else if (delegation) {
    kind = 'delegation'
    reason = `created by delegation ${delegation.taskId}`
  } else if (TITLE_SCHEDULE_HINT.test(title)) {
    kind = 'business'
    reason = 'title looks like a scheduled/business session (no schedule record found — still inject with care)'
  }
  return {
    kind,
    protected: schedules.length > 0,
    delegatable: alive && schedules.length === 0,
    recommended: alive && String(session?.state) === 'idle' && schedules.length === 0,
    reason,
    schedules,
    delegation
  }
}

/**
 * Guard for write-capable tools (host_session_prompt / channel_wake /
 * host_call / delegate continuation). Returns null when the target is safe.
 */
export function sessionBlock(profile, sessionId) {
  const schedules = profile?.schedules?.get(String(sessionId || '')) || EMPTY
  if (schedules.length === 0) return null
  return {
    kind: 'business-scheduled',
    reason: `session ${sessionId} owns ${schedules.length} scheduled task(s): ${schedules
      .map((row) => row.title || row.id)
      .join(' / ')}`,
    schedules,
    hint: 'delegate to a FRESH conversation instead (omit sessionId), or pass force:true if you really mean to inject into this scheduled session'
  }
}
