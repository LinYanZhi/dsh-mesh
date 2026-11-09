// Autostart helper: keep the mesh endpoint alive across user logins (Windows Task Scheduler).
// Read-only by default: `status` only queries schtasks; `install`/`remove` need an explicit
// confirmation flag because creating a per-user scheduled task is a user-level config change.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname as dirnameOf, join as joinPath } from 'node:path'

export const TASK_NAME = 'dsh-mesh-endpoint'

const CLI_PATH = joinPath(dirnameOf(fileURLToPath(import.meta.url)), '..', 'cli.js')

function exec(args) {
  return new Promise((resolvePromise) => {
    // schtasks writes the console code page (GBK on zh-CN Windows), so decode bytes ourselves.
    execFile(
      'schtasks',
      args,
      { windowsHide: true, timeout: 15000, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolvePromise({
          code,
          stdout: decodeText(stdout),
          stderr: decodeText(stderr),
          message: error ? String(error.message) : ''
        })
      }
    )
  })
}

function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) return buf || ''
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

function assertWindows() {
  if (process.platform !== 'win32') throw new Error('autostart is Windows-only (schtasks)')
}

/** Parse `schtasks /Query /V /FO LIST` into a flat object (localized labels are matched by suffix). */
function parseVerboseList(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (key && value) out[key] = value
  }
  return out
}

/** Inspect the task. Never throws for "not installed" — that is the normal state. */
export async function autostartStatus(name = TASK_NAME) {
  assertWindows()
  const res = await exec(['/Query', '/TN', name, '/V', '/FO', 'LIST'])
  if (res.code !== 0) {
    return { installed: false, name, detail: (res.stderr || res.message || '').trim() }
  }
  const fields = parseVerboseList(res.stdout)
  // zh-CN Windows localizes these labels ("状态", "要运行的任务", …), so a suffix match on the
  // English name alone silently returns undefined — match localized aliases too (2026-10-19).
  const ALIASES = {
    status: ['Status', '状态'],
    state: ['ScheduledTaskState', '计划任务状态', '已计划的任务状态'],
    taskToRun: ['TaskToRun', '要运行的任务'],
    lastRun: ['LastRunTime', '上次运行时间'],
    lastResult: ['LastResult', '上次结果'],
    runAsUser: ['RunAsUser', '运行身份', '运行方式', '作为用户运行']
  }
  const pick = (aliases) => {
    const squash = (value) => value.replace(/[\s.]/g, '')
    const key = Object.keys(fields).find((candidate) => aliases.some((alias) => squash(candidate).endsWith(squash(alias)) && squash(candidate).length <= squash(alias).length + 2))
      || Object.keys(fields).find((candidate) => aliases.includes(candidate.trim()))
    return key ? fields[key] : undefined
  }
  return {
    installed: true,
    name,
    status: pick(ALIASES.status),
    state: pick(ALIASES.state),
    taskToRun: pick(ALIASES.taskToRun),
    lastRun: pick(ALIASES.lastRun),
    lastResult: pick(ALIASES.lastResult),
    runAsUser: pick(ALIASES.runAsUser)
  }
}

/** The exact command a login-time task would run. */
export function autostartCommand(name = TASK_NAME, port) {
  const portArg = port ? ` --port ${port}` : ''
  return `"${process.execPath}" "${CLI_PATH}" serve${portArg}`
}

/**
 * Create/replace a logon-triggered task that runs `serve`.
 * Callers must pass `yes: true`; the CLI only forwards it after an explicit `--yes`.
 */
export async function autostartInstall({ name = TASK_NAME, command = autostartCommand(name), yes = false } = {}) {
  assertWindows()
  if (!yes) throw new Error('refusing to install without --yes (creates a per-user scheduled task)')
  // /RL LIMITED: run at the user's normal integrity level, never elevated.
  const res = await exec(['/Create', '/TN', name, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', command, '/F'])
  if (res.code !== 0) throw new Error(`schtasks /Create failed (${res.code}): ${(res.stderr || res.message || '').trim()}`)
  return { ok: true, name, command, stdout: res.stdout.trim() }
}

export async function autostartRemove({ name = TASK_NAME, yes = false } = {}) {
  assertWindows()
  if (!yes) throw new Error('refusing to remove without --yes')
  const res = await exec(['/Delete', '/TN', name, '/F'])
  if (res.code !== 0) throw new Error(`schtasks /Delete failed (${res.code}): ${(res.stderr || res.message || '').trim()}`)
  return { ok: true, name }
}
