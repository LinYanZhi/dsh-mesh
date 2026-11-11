/**
 * dsh-mesh-autostart — 在 DSH host 进程内托管 dsh-mesh serve、frpc、手机直控 daemon、自更新，并做基线自愈。
 *
 * 为什么需要：手机（dsh-Go 本机引擎）的容器在引擎重启时会杀掉所有子进程（--kill-on-exit），
 * 而 serve / frpc / pc-daemon / updater 是独立服务，必须由插件托管才能跨引擎重启恢复。
 *
 * 职责：
 *   1) 8124 未监听则 spawn `cli.js serve`，退出后按退避重启；
 *   2) frpc 未运行则 spawn `frpc -c frpc.toml`；
 *   3) pc-daemon（127.0.0.1:19555）未监听则 spawn（低延迟直控通道）；
 *   4) phone-updater 常驻：每 5 分钟 git fetch/pull，落后则写 restart.flag；
 *   5) 监听 restart.flag：检测到就重启 serve（加载新代码）；
 *   6) dsh-app 覆盖 AGENTS.md 时补回用户基线（延迟多次重试，规避 app 写入竞态）。
 *
 * 约束：纯 ESM、不 import @deepseek-ai/*，可直接放进任意 DSH profile 的 node_modules。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, appendFileSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'

export const name = 'dsh-mesh-autostart'
export const inject = []

/**
 * Locate the dsh-mesh-node installation that owns the mesh server.
 * Order: DSH_MESH_REPO -> installed dsh-mesh-node dependency -> legacy phone path.
 * Missing installation fails loud: silently doing nothing was the original bug.
 */
function resolveMeshRoot() {
  const candidates = []
  if (process.env.DSH_MESH_REPO) candidates.push(process.env.DSH_MESH_REPO)
  function pushNodeFromRequire(req) {
    try {
      let dir = dirname(req.resolve('dsh-mesh-node'))
      for (let i = 0; i < 5; i++) {
        if (existsSync(join(dir, 'src', 'cli.js'))) { candidates.push(dir); return true }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* try next */ }
    return false
  }
  try { pushNodeFromRequire(createRequire(import.meta.url)) } catch { /* virtual module URL */ }
  // DSH 有时用虚拟模块 URL 装载 patch，createRequire(import.meta.url) 解析不到同 profile 的依赖。
  const dshHomes = new Set([process.env.DSH_HOME, process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh2') : null, process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh1') : null, join(homedir(), '.dsh2'), join(homedir(), '.dsh1'), join(homedir(), '.dsh0'), join(homedir(), '.dsh')])
  // 3082 计划任务/S4U 会话下 homedir 可能不是用户目录；用 DSH_MESH_HOME 反推同级 DSH_HOME。
  if (process.env.DSH_MESH_HOME) {
    const meshBase = basename(process.env.DSH_MESH_HOME)
    if (/-mesh$/i.test(meshBase)) dshHomes.add(join(dirname(process.env.DSH_MESH_HOME), '.' + meshBase.replace(/-mesh$/i, '')))
  }
  for (const dshHome of dshHomes) {
    if (!dshHome) continue
    candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mesh-node'))
    try { pushNodeFromRequire(createRequire(join(dshHome, 'profiles', 'web', 'package.json'))) } catch { /* try next */ }
  }
  // Legacy phone-kit layout: keep working when the file really exists.
  candidates.push('/root/dsh-mesh-kit/mesh')
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'src', 'cli.js'))) return candidate
  }
  throw new Error(
    'dsh-mesh-autostart: dsh-mesh-node is not installed (no dsh-mesh-node dependency and no DSH_MESH_REPO). ' +
      'Install it with `npm i -g dsh-mesh-node`, or set DSH_MESH_REPO to a dsh-mesh checkout.'
  )
}

export function apply(ctx) {
  const meshHome = process.env.DSH_MESH_HOME || join(homedir(), '.dsh-mesh')
  const repo = resolveMeshRoot()
  const cli = join(repo, 'src', 'cli.js')
  const frpcBin = process.env.DSH_FRPC_BIN || '/root/dsh-mesh-kit/frp/frpc'
  const frpcConf = process.env.DSH_FRPC_CONF || '/root/dsh-mesh-kit/frp/frpc.toml'
  const daemonPath = process.env.DSH_PC_DAEMON || '/root/dsh-mesh-kit/pc-daemon.mjs'
  const updaterPath = process.env.DSH_PHONE_UPDATER || '/root/dsh-mesh-kit/phone-updater.mjs'
  const baselinePath = process.env.DSH_BASELINE || '/root/dsh-mesh-kit/AGENTS-baseline.md'
  const logPath = join(meshHome, 'serve.log')
  const flagPath = join(meshHome, 'restart.flag')
  const autoUpdate = process.env.DSH_AUTOUPDATE !== '0'

  let child = null
  let frpc = null
  let daemon = null
  let updater = null
  let timer = null
  let flagTimer = null
  let updateTimer = null
  let stopping = false
  let failures = 0

  function log(msg) {
    try {
      mkdirSync(meshHome, { recursive: true })
      appendFileSync(logPath, `[${new Date().toISOString()}] [autostart] ${msg}\n`)
    } catch {
      /* log is best-effort */
    }
  }

  /**
   * dsh-app 会覆盖 $DSH_HOME/AGENTS.md（managed 文件），用户基线/纪律卡会丢。
   * 启动时以及延迟几次重试补回（app 的写入可能晚于插件加载，需重试）。
   */
  function ensureAgents() {
    if (!existsSync(baselinePath)) return
    const mark = '用户全局基线（从peer-x同步'
    const targets = [join(process.env.DSH_HOME || '/root/.dsh', 'AGENTS.md'), '/root/AGENTS.md']
    let base = ''
    try { base = readFileSync(baselinePath, 'utf8') } catch { return }
    for (const p of targets) {
      try {
        let cur = ''
        try { cur = readFileSync(p, 'utf8') } catch {}
        if (cur.includes(mark)) continue
        writeFileSync(p, cur + (cur ? '\n\n' : '') + '<!-- ===== 用户全局基线（从peer-x同步，autostart 恢复）===== -->\n\n' + base, 'utf8')
        log(`AGENTS baseline restored -> ${p}`)
      } catch {
        /* best-effort */
      }
    }
  }

  function port() {
    try { return Number(JSON.parse(readFileSync(join(meshHome, 'config.json'), 'utf8'))?.node?.port) || 8124 } catch { return 8124 }
  }

  function listening(p = port()) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: p, timeout: 1200 })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
    })
  }

  function frpcRunning() {
    try { execFileSync('pgrep', ['-x', 'frpc'], { stdio: 'ignore' }); return true } catch { return false }
  }

  function startFrpc() {
    if (stopping || frpcRunning()) return
    if (!existsSync(frpcBin) || !existsSync(frpcConf)) { log(`skip frpc: missing ${frpcBin} or ${frpcConf}`); return }
    try {
      const fd = openSync(join(meshHome, 'frpc.log'), 'a')
      frpc = spawn(frpcBin, ['-c', frpcConf], { detached: true, stdio: ['ignore', fd, fd] })
      frpc.unref()
      log(`spawned frpc pid=${frpc.pid}`)
      frpc.once('exit', () => { frpc = null })
    } catch (error) { log(`spawn frpc failed: ${String(error?.message || error)}`) }
  }

  async function startDaemon() {
    if (stopping) return
    if (!existsSync(daemonPath)) { log(`skip pc-daemon: missing ${daemonPath}`); return }
    if (await listening(19555)) { log('skip pc-daemon: already listening'); return }
    try {
      const fd = openSync(join(meshHome, 'pc-daemon.log'), 'a')
      daemon = spawn(process.execPath, [daemonPath], { detached: true, stdio: ['ignore', fd, fd] })
      daemon.unref()
      log(`spawned pc-daemon pid=${daemon.pid}`)
    } catch (error) { log(`spawn pc-daemon failed: ${String(error?.message || error)}`) }
  }

  function startUpdater() {
    if (stopping || !autoUpdate) return
    if (!existsSync(updaterPath)) { log(`skip phone-updater: missing ${updaterPath}`); return }
    try {
      const fd = openSync(join(meshHome, 'phone-updater.log'), 'a')
      updater = spawn(process.execPath, [updaterPath], { detached: true, stdio: ['ignore', fd, fd] })
      updater.unref()
      log(`spawned phone-updater pid=${updater.pid}`)
    } catch (error) { log(`spawn phone-updater failed: ${String(error?.message || error)}`) }
  }

  async function start() {
    if (stopping) return
    if (!existsSync(cli)) { log(`skip serve: cli not found at ${cli}`); return }
    if (await listening()) { log('skip serve: already listening'); return }
    mkdirSync(meshHome, { recursive: true })
    const fd = openSync(logPath, 'a')
    try {
      child = spawn(process.execPath, [cli, 'serve'], {
        cwd: repo,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, DSH_MESH_HOME: meshHome }
      })
      child.unref()
      log(`spawned serve pid=${child.pid} repo=${repo} home=${meshHome}`)
      child.once('exit', (code, signal) => {
        child = null
        if (stopping) return
        failures += 1
        const delay = Math.min(60_000, 2_000 * failures)
        log(`serve exited code=${code} signal=${signal}; respawn in ${delay}ms (failure #${failures})`)
        timer = setTimeout(start, delay)
        if (typeof timer.unref === 'function') timer.unref()
      })
    } catch (error) {
      log(`spawn serve failed: ${String(error?.message || error)}`)
      failures += 1
      timer = setTimeout(start, Math.min(60_000, 2_000 * failures))
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  function watchRestartFlag() {
    flagTimer = setInterval(() => {
      try {
        if (!existsSync(flagPath)) return
        unlinkSync(flagPath)
        log('restart.flag detected -> restart serve')
        if (child) { try { process.kill(child.pid) } catch {} }
      } catch {}
    }, 10_000)
    if (typeof flagTimer.unref === 'function') flagTimer.unref()
  }

  function watchGitUpdate() {
    if (!autoUpdate || !existsSync(join(repo, '.git'))) return
    let busy = false
    updateTimer = setInterval(() => {
      if (busy || stopping) return
      busy = true
      try {
        execFileSync('git', ['-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 60_000, stdio: 'ignore' })
        const behind = Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8', timeout: 20_000 }).trim() || 0)
        if (behind > 0) {
          execFileSync('git', ['-C', repo, 'pull', '--ff-only', '--quiet'], { timeout: 120_000, stdio: 'ignore' })
          log(`git updated (${behind} commits behind) -> write restart.flag`)
          writeFileSync(flagPath, new Date().toISOString() + '\n', 'utf8')
        }
      } catch (error) {
        log(`git update failed: ${String(error?.message || error).slice(0, 200)}`)
      } finally { busy = false }
    }, 5 * 60_000)
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
  }

  function dispose() {
    stopping = true
    if (timer) { clearTimeout(timer); timer = null }
    if (flagTimer) { clearInterval(flagTimer); flagTimer = null }
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null }
    if (child) { try { process.kill(child.pid) } catch { /* gone */ } child = null }
    if (frpc) { try { process.kill(frpc.pid) } catch {} frpc = null }
    if (daemon) { try { process.kill(daemon.pid) } catch {} daemon = null }
    if (updater) { try { process.kill(updater.pid) } catch {} updater = null }
  }

  // 基线恢复：立即 + 延迟重试（dsh-app 可能在插件加载后才写 AGENTS.md）
  ensureAgents()
  const agentRetries = [5_000, 20_000, 60_000]
  for (const delay of agentRetries) {
    try { const t = setTimeout(ensureAgents, delay); if (typeof t.unref === 'function') t.unref() } catch {}
  }

  start().catch((error) => log(`start failed: ${String(error?.message || error)}`))
  try { startFrpc() } catch (error) { log(`frpc start failed: ${String(error?.message || error)}`) }
  startDaemon().catch((error) => log(`pc-daemon start failed: ${String(error?.message || error)}`))
  startUpdater()
  watchRestartFlag()
  watchGitUpdate()

  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'dsh-mesh-autostart: supervise')
  return dispose
}
