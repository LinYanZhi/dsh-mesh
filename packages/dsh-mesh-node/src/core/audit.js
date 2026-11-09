import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso, short, stripBom } from './util.js'

const MAX_AUDIT_BYTES = 5 * 1024 * 1024
const KEEP_TAIL_LINES = 400

export function auditPath(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return join(home, 'audit.jsonl')
}

function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_AUDIT_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    /* rotation is best-effort: never break a tool call because of it */
  }
}

/**
 * Audit writer. One JSON line per tool call: who (token id), what, result, duration.
 * Never contains argument values (they may hold secrets); only argument key names.
 */
export function makeAudit({ home, log = console }) {
  const file = auditPath(home)
  return async function audit(event) {
    const line = {
      ts: nowIso(),
      ...event,
      args: Array.isArray(event?.args) ? event.args : undefined
    }
    try {
      rotateIfNeeded(file)
      appendFileSync(file, JSON.stringify(line) + '\n', { encoding: 'utf8' })
    } catch (error) {
      log?.error?.(`[dsh-mesh] audit write failed: ${error?.message || error}`)
    }
  }
}

/** Read the last `limit` audit lines (newest last). */
export function tailAudit(home, { limit = 50, tool, ok } = {}) {
  const file = auditPath(home)
  if (!existsSync(file)) return { path: file, entries: [], total: 0 }
  const text = stripBom(readFileSync(file, 'utf8'))
  const lines = text.split(/\r?\n/).filter(Boolean)
  let entries = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(stripBom(line)))
    } catch {
      /* skip corrupt line */
    }
  }
  const total = entries.length
  if (tool) entries = entries.filter((e) => e.tool === tool)
  if (typeof ok === 'boolean') entries = entries.filter((e) => e.ok === ok)
  const slice = entries.slice(-Math.min(Math.max(1, limit), KEEP_TAIL_LINES))
  return { path: file, total, matched: entries.length, entries: slice }
}

export function auditSummary(home) {
  const file = auditPath(home)
  if (!existsSync(file)) return { path: file, exists: false, sizeBytes: 0 }
  let sizeBytes = 0
  try {
    sizeBytes = statSync(file).size
  } catch {
    /* ignore */
  }
  return { path: file, exists: true, sizeBytes, preview: short('', 0) }
}
