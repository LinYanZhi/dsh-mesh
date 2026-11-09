import { execFile } from 'node:child_process'

/**
 * desktop-proxy：mesh server 可能运行在 session 0（S4U/计划任务），看不到用户桌面。
 * 这种情况下把 pc_* 调用转发给用户会话里常驻的 desktop helper（127.0.0.1:19556）。
 *
 * 设计：
 * - helper 由「登录时触发」的计划任务在交互 session 启动（install-desktop-helper-task.mjs）；
 * - mesh 侧缓存自己的 session id；只有 session 0 才转发；
 * - helper 进程带 DSH_PC_DESKTOP_DIRECT=1，直接执行不再转发（避免回环）；
 * - helper 不可达（ECONNREFUSED 等）时回退本地执行（保持原有行为，不会让工具直接失败）。
 *
 * 2026-11-09 修正（close 报 E_WINDOW_NOT_FOUND 但窗口其实已关）：
 * PowerShell 在负载高的机器上冷启动可能 10~20s，原来固定 6s 超时 → 超时后回退到 session 0 本地执行，
 * 而 session 0 看不见用户桌面，必然算出 NOT_FOUND，形成假失败（helper 其实已经把窗口关了）。
 * 现在：超时默认放宽到 30s；超时不回退本地，而是返回超时哨兵，让上层明确报「结果未知，请复核」。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_PC_PROXY_TIMEOUT_MS || 30000)
const PROXY_TIMEOUT_MARK = '__meshDesktopProxyTimeout'

let sessionPromise = null

export function meshSessionId() {
  if (!sessionPromise) {
    sessionPromise = new Promise((resolve) => {
      try {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId'],
          { timeout: 10000, windowsHide: true },
          (error, stdout) => {
            if (error) return resolve(-1)
            const n = Number(String(stdout || '').trim())
            resolve(Number.isFinite(n) ? n : -1)
          }
        )
      } catch {
        resolve(-1)
      }
    })
  }
  return sessionPromise
}

/** true = helper 收到了请求但超时未响应（操作可能已生效，不能当失败处理） */
export function isProxyTimeout(value) {
  return Boolean(value && value[PROXY_TIMEOUT_MARK] === true)
}

/** 超时哨兵对应的用户可读错误：明确"结果未知"，避免上层误判成 E_WINDOW_NOT_FOUND。 */
export function proxyTimeoutMessage(tool, value) {
  const sec = Math.round(Number(value?.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)
  return (
    'E_DESKTOP_TIMEOUT: desktop helper 已接收 ' +
    tool +
    ' 请求但 ' +
    sec +
    's 内未返回（机器负载高时 PowerShell 冷启动可能很慢）。操作**可能已生效**：请用 window list / app list 复核，不要直接重发。'
  )
}

export async function maybeProxy(tool, args, options = {}) {
  if (process.env.DSH_PC_DESKTOP_DIRECT === '1') return null
  if (process.platform !== 'win32') return null
  const sid = await meshSessionId()
  if (sid !== 0) return null
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch('http://127.0.0.1:19556/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const json = await res.json()
    return json && json.ok && json.result ? json.result : null
  } catch (error) {
    const name = String(error?.name || '')
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { [PROXY_TIMEOUT_MARK]: true, tool, timeoutMs }
    }
    return null
  }
}
