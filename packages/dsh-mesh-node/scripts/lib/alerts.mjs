// @generated 2026-10-27 告警落盘（instance-watchdog / mesh-health 共用）
// [why] 用户要求「挂了要能主动知道」，但三节点不能依赖某个外部通知服务：
//       统一把告警写 `<mesh home>/alerts.jsonl`（历史）+ `<mesh home>/ALERT.json`（最新一条），
//       由 mesh-health 在输出里显式提示「最近告警」。今后要接微信/邮件/Toast，只需改这一个文件。
// 归宿：reusable（dsh-mesh/scripts/lib/）
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function meshHome() {
  return process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
}
export function alertsPath() {
  return join(meshHome(), 'alerts.jsonl')
}
export function alertStatePath() {
  return join(meshHome(), 'ALERT.json')
}

const HISTORY_MAX = 20

/** Read ALERT.json as an object (never throws). 2026-11-06 新增：迟滞/历史用。 */
export function readAlertState() {
  try {
    const parsed = JSON.parse(readFileSync(alertStatePath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Append one alert and refresh the "latest alert" snapshot. Never throws.
 *  2026-11-06：ALERT.json 同时保留 `recent`（最近 20 条），修掉「单槽被覆盖、历史只剩 jsonl」的问题。 */
export function writeAlert(record) {
  const entry = { at: new Date().toISOString(), ...record }
  try {
    mkdirSync(meshHome(), { recursive: true })
    appendFileSync(alertsPath(), `${JSON.stringify(entry)}\n`)
    const prev = readAlertState()
    const recent = [entry, ...(Array.isArray(prev.recent) ? prev.recent : [])].slice(0, HISTORY_MAX)
    writeFileSync(alertStatePath(), JSON.stringify({ ...entry, consecutiveBad: 0, recent }, null, 2), 'utf8')
  } catch {
    /* alerting must never break the caller */
  }
  return entry
}

/** 只追加 alerts.jsonl，不动 ALERT.json 的「最新告警」指针（用于 mesh-recovered 等事件）。 */
export function appendAlertHistory(record) {
  const entry = { at: new Date().toISOString(), ...record }
  try {
    mkdirSync(meshHome(), { recursive: true })
    appendFileSync(alertsPath(), `${JSON.stringify(entry)}\n`)
  } catch {
    /* alerting must never break the caller */
  }
  return entry
}

/** 连续异常计数（告警迟滞用）：返回累加后次数。 */
export function bumpBadRun() {
  try {
    const prev = readAlertState()
    const n = (Number(prev.consecutiveBad) || 0) + 1
    writeFileSync(alertStatePath(), JSON.stringify({ ...prev, consecutiveBad: n, lastBadAt: new Date().toISOString() }, null, 2), 'utf8')
    return n
  } catch {
    return 1
  }
}

/** 恢复正常：清零连续异常计数；返回 true 表示之前确有计数。 */
export function resetBadRun() {
  try {
    const prev = readAlertState()
    if (!prev.consecutiveBad) return false
    writeFileSync(alertStatePath(), JSON.stringify({ ...prev, consecutiveBad: 0, lastRecoveredAt: new Date().toISOString() }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function lastAlert() {
  try {
    const parsed = JSON.parse(readFileSync(alertStatePath(), 'utf8'))
    return parsed && parsed.at ? parsed : null
  } catch {
    return null
  }
}

/** Human line for "a recent alert still matters" (within 24h), or null. */
export function alertLine(alert = lastAlert(), hours = 24) {
  if (!alert || !alert.at) return null
  const ageMs = Date.now() - Date.parse(alert.at)
  if (!Number.isFinite(ageMs) || ageMs > hours * 3600 * 1000) return null
  const ageMin = Math.max(0, Math.round(ageMs / 60000))
  return `最近告警 ${ageMin} 分钟前 · ${alert.kind || ''} · ${alert.summary || ''}`.trim()
}

/** Clear the "latest alert" pointer (history jsonl is kept for audit). */
export function clearAlert() {
  try {
    if (existsSync(alertStatePath())) writeFileSync(alertStatePath(), '{}\n', 'utf8')
    return true
  } catch {
    return false
  }
}
