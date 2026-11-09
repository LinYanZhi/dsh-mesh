/**
 * Restart the dsh-mesh server without killing a process or depending on DSH.
 *
 *   node scripts/mesh-restart.mjs            # flag + wait for a new pid
 *   node scripts/mesh-restart.mjs --status   # read /health only
 *
 * Requires the supervisor (scripts/mesh-supervisor.mjs) to be the process that
 * owns `serve`. If the running server predates the restart.flag watcher, this
 * exits 2 and prints the one-time migration note.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { request as httpRequest } from 'node:http'

const HOME = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
const FLAG = join(HOME, 'restart.flag')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function config() {
  try {
    return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function health() {
  const cfg = config()
  const tls = cfg.node?.tls?.enabled === true
  const port = cfg.node?.port || 8124
  const host = cfg.node?.bind || '127.0.0.1'
  const options = { host, port, path: '/health', timeout: 1500, rejectUnauthorized: false }
  return new Promise((resolve) => {
    const req = (tls ? request : httpRequest)(options, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, ...JSON.parse(body) })
        } catch {
          resolve({ ok: false, error: 'invalid json' })
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout' })
    })
    req.on('error', (error) => resolve({ ok: false, error: error.message }))
    req.end()
  })
}

/**
 * 桌面 helper（127.0.0.1:19556）在登录时启动、进程内加载 control/control-apps 代码，
 * 所以 pc_* 代码更新后必须重启它，否则 session 0 的 mesh 转发的还是旧逻辑。
 *
 * 坑（2026-11-09 实测）：计划任务的 action 是 wscript.exe <vbs>，`schtasks /End` 只结束 wscript，
 * 真正的 node 子进程还活着占着 19556 端口，新实例绑不上端口 → 仍然是旧代码。
 * 因此这里用 install/uninstall 脚本同款的做法：仅针对 CommandLine 含 `pc-desktop-helper` 的 node 进程做定向清理，
 * 不碰任何其它进程；然后重新 /Run 并用 /health 的 pid 变化自证。
 */
function helperHealth() {
  const script = "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:19556/health).Content } catch { 'down' }"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  const raw = String(r.stdout || '').trim()
  if (raw === 'down' || !raw) return { reachable: false, pid: null, tools: [] }
  try {
    const j = JSON.parse(raw)
    return { reachable: true, pid: j.pid ?? null, tools: Array.isArray(j.tools) ? j.tools : [] }
  } catch {
    return { reachable: false, pid: null, tools: [] }
  }
}

function restartDesktopHelper() {
  if (process.platform !== 'win32') return { skipped: 'not-windows' }
  const task = 'dsh-mesh-desktop-helper'
  const opts = { encoding: 'utf8', timeout: 30000, windowsHide: true }
  if (spawnSync('schtasks', ['/Query', '/TN', task], opts).status !== 0) return { skipped: 'task-not-installed' }
  const before = helperHealth()
  spawnSync('schtasks', ['/End', '/TN', task], opts)
  // /End 只结束 wscript；把残留的 helper node 定向清掉（只匹配它自己的 CommandLine）
  const sweep = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pc-desktop-helper*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }"],
    opts
  )
  const stopped = String(sweep.stdout || '').trim()
  const run = spawnSync('schtasks', ['/Run', '/TN', task], opts)
  const deadline = Date.now() + 15000
  let after = before
  while (Date.now() < deadline) {
    after = helperHealth()
    if (after.reachable && after.pid && after.pid !== before.pid) break
    sleepSync(700) // 同步等待，仅用于重启后的自证，最多 15s
  }
  return {
    task,
    runOk: run.status === 0,
    stoppedPids: stopped || null,
    oldPid: before.pid,
    newPid: after.pid,
    replaced: Boolean(after.reachable && after.pid && after.pid !== before.pid),
    hasPcPath: after.tools.includes('pc_path'),
    tools: after.tools
  }
}

async function main() {
  const before = await health()
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(before, null, 2))
    return 0
  }
  if (!before.ok) {
    console.error(`mesh health unreachable: ${before.error}`)
    return 1
  }
  if (!before.pid) {
    console.error('running server does not expose /health.pid — it predates this tool; one-time migration needed (see docs/DESIGN-SELF-ITERATION.md §restart)')
    return 2
  }
  writeFileSync(FLAG, `${new Date().toISOString()} oldPid=${before.pid}\n`)
  const deadline = Date.now() + 30000
  let last = before
  while (Date.now() < deadline) {
    await sleep(500)
    last = await health()
    if (last.ok && last.pid && last.pid !== before.pid) {
      const helper = restartDesktopHelper()
      console.log(JSON.stringify({ action: 'restarted', oldPid: before.pid, newPid: last.pid, version: last.version, uptimeSec: last.uptimeSec, desktopHelper: helper }, null, 2))
      return 0
    }
  }
  console.error(`timed out waiting for new pid (old=${before.pid}, last=${JSON.stringify(last)}) — is the supervisor running?`)
  return 3
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`mesh-restart: ${error?.message || error}`)
    process.exitCode = 1
  })
