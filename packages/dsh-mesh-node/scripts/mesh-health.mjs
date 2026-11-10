#!/usr/bin/env node
// @generated 2026-10-27 一条命令回答「AI 网络现在怎么样」（只读，不写任何配置、不动任何进程）
// [why] 2026-10-27 家里 dsh0/dsh1 挂掉时，AI 花了 10+ 分钟手工串 status --deep / peer doctor /
//       host_instances / channel_sessions / audit 才能说清「哪一跳断了」；用户要求「以后问 AI 网络情况
//       一条命令快速给答案」→ 本脚本把「实例 + 链路 + 远端修复能力 + 本机看护」压成一次快照。
// 用法：
//   node scripts/mesh-health.mjs            # 人类可读（默认 ~3-5s）
//   node scripts/mesh-health.mjs --json     # 给 AI / 归档用
//   node scripts/mesh-health.mjs --fast     # 只探实例+链路，跳过能力探测（~1-2s）
//   node scripts/mesh-health.mjs --no-peers # 只看本机
// 退出码：0 = verdict ok/degraded（有 down 也算 degraded，详情看输出）；3 = down（有实例或 peer 不可用）
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { loadConfig, meshHome, MESH_VERSION } from '../src/core/config.js'
import { loadPeers } from '../src/core/pairing.js'
import { clusterReport, probeSelfEndpoint } from '../src/core/cluster.js'
import { collectTunnels } from '../src/core/tunnels.js'
import { callPeerTool } from '../src/core/peer-client.js'
import { collectRunningSessions, DEFAULT_TTL_MS, filterTargets, localInstanceIds } from './lib/session-stats.mjs'
import { fileURLToPath } from 'node:url'
import { alertLine, appendAlertHistory, bumpBadRun, clearAlert, lastAlert, resetBadRun, writeAlert } from './lib/alerts.mjs'
import { installHiddenTask, hiddenTaskCommand, taskState as runnerTaskState, uninstallTask } from './lib/hidden-task.mjs'
import { powershellExe } from './lib/win.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const arg = (f, d = undefined) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
// --json 主要是面板/脚本采集，必须控制在面板采集超时（25s）以内。
// 未显式 --full 时，--json 自动走 fast 档：保留实例/peer/verdict 数据，跳过
// 能力探测与“down 后自动重探”（peer-x离线时这两步会拖到 40s+）。
const jsonMode = has('--json')
const fastMode = has('--fast') || (jsonMode && !has('--full') && !has('--alert'))
if (has('--help') || has('-h')) {
  console.log(`mesh-health — AI 网络快速体检（只读）

用法:
  node scripts/mesh-health.mjs [--json] [--fast] [--full] [--no-peers] [--timeout-ms 4000]
  node scripts/mesh-health.mjs --sessions [--json] [--node <peer>] [--instance dshN] [--no-cache] [--cache-ttl 30]
                               # 追加：每节点每实例「正在运行(working)的会话数 + 标题」
  node scripts/mesh-health.mjs --alert [--quiet]        # 异常时写 alerts.jsonl + ALERT.json（计划任务用）
  node scripts/mesh-health.mjs --install-alert [--interval 5] [--yes]   # 装「每 5 分钟自查 + 异常告警」任务（隐藏窗口）
  node scripts/mesh-health.mjs --uninstall-alert [--yes]
  node scripts/mesh-health.mjs --clear-alert            # 清掉「最近告警」指针（历史 jsonl 保留）

输出:
  1) 本机 mesh 端点 + 各 DSH 实例（up/pid/tools/错误）
  2) 每个 peer：链路延迟 / 版本 / TLS 指纹是否匹配 / 其下实例数
  3) 每个节点「远程修复通道」能力（repair.enabled + restartScripts）
  4) 本机实例看护 watchdog（计划任务状态）
  5) verdict + 逐条下一步建议；--json 输出机器可读快照
`)
  process.exit(0)
}

const SELF = fileURLToPath(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALERT_TASK = 'dsh-mesh-alert'
const alertIntervalMin = Math.min(60, Math.max(1, Number(arg('--interval', '5'))))
if (has('--clear-alert')) {
  console.log(clearAlert() ? '已清除最近告警（历史 alerts.jsonl 保留）' : '清除失败')
  process.exit(0)
}
if (has('--uninstall-alert')) {
  if (!has('--yes')) { console.log('（dry-run）将执行：schtasks /Delete /TN ' + ALERT_TASK + ' /F'); process.exit(0) }
  const removed = uninstallTask(ALERT_TASK)
  console.log(removed.out || 'exit=' + removed.exit)
  process.exit(removed.ok ? 0 : 1)
}
if (has('--install-alert')) {
  const preview = hiddenTaskCommand(process.execPath, SELF, ['--alert', '--quiet'])
  if (!has('--yes')) {
    console.log('（dry-run）将安装隐藏窗口计划任务 ' + ALERT_TASK + '（每 ' + alertIntervalMin + ' 分钟自查一次，异常才写告警）：')
    console.log('  schtasks /Create /TN ' + ALERT_TASK + ' /SC MINUTE /MO ' + alertIntervalMin + ' /TR ' + preview + ' /F /RL LIMITED')
    console.log('加 --yes 才真正安装。')
    process.exit(0)
  }
  const installed = installHiddenTask({ taskName: ALERT_TASK, nodeExe: process.execPath, scriptPath: SELF, scriptArgs: ['--alert', '--quiet'], intervalMin: alertIntervalMin })
  console.log(installed.out || 'exit=' + installed.exit)
  process.exit(installed.ok ? 0 : 6)
}

const quiet = { info() {}, warn() {}, error() {} }
const timeoutMs = Math.max(1000, Number(arg('--timeout-ms', '4000')) || 4000)
const home = meshHome()
const startedAt = Date.now()

function tailText(s, n = 200) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
function unwrap(wrapper) {
  // callPeerTool 返回 { peer, tool, ok, ms, result: <MCP callTool 结果> }
  const result = wrapper?.result ?? wrapper
  const text = result?.content?.find?.((c) => c && c.type === 'text')?.text
  if (typeof text === 'string') {
    try { return JSON.parse(text) } catch { return { _text: tailText(text) } }
  }
  return result
}
/** host_sessions 里的 updatedAt 是 epoch ms；统一按上海时区显示到分钟。 */
function fmtEpoch(v) {
  const ms = typeof v === 'number' ? v : Date.parse(v)
  if (!Number.isFinite(ms)) return '-'
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
}
function frpFlapSummary(windowMin = 60) {
  const file = join(home, 'frp-probe.jsonl')
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').trim().split('\n')
  } catch {
    return null
  }
  const since = Date.now() - windowMin * 60 * 1000
  let total = 0
  let fails = 0
  const byPeer = {}
  for (const line of lines.slice(-2000)) {
    try {
      const row = JSON.parse(line)
      const at = Date.parse(row.at || '')
      if (!Number.isFinite(at) || at < since) continue
      total += 1
      if (row.ok !== true) {
        fails += 1
        byPeer[row.peer] = (byPeer[row.peer] || 0) + 1
      }
    } catch {
      /* ignore torn lines */
    }
  }
  if (total === 0) return null
  return { windowMin, total, fails, byPeer }
}
function watchdogState() {
  // 用 PowerShell 结构化取状态（schtasks 文本在中文系统是本地化标签，解析不可靠）
  const script = [
    "$n='dsh-instance-watchdog'",
    '$t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue',
    "if(-not $t){'{\"installed\":false}'}else{$i=Get-ScheduledTaskInfo -TaskName $n;[pscustomobject]@{installed=$true;state=[string]$t.State;lastResult=$i.LastTaskResult;lastRun=$i.LastRunTime.ToString('s');nextRun=$i.NextRunTime.ToString('s')}|ConvertTo-Json -Compress}",
  ].join('; ')
  const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || !r.stdout) return { installed: false }
  try {
    const j = JSON.parse(r.stdout.trim())
    if (!j.installed) return { installed: false }
    return { installed: true, status: j.state, lastResult: j.lastResult ?? null, lastRun: j.lastRun ?? null, nextRun: j.nextRun ?? null }
  } catch {
    return { installed: false }
  }
}

/**
 * 组装 --sessions 的探测目标：本机实例 + 各 peer 的实例。
 * 同一台机可能有控制 token 别名（xxx-exec，同证书/同 URL）——按「机器 + 实例」去重，优先用非 -exec 的名字。
 */
function sessionsTargets(report, peers) {
  const best = new Map()
  for (const item of report.remoteInstances || []) {
    if (item.up === false) continue
    const peer = peers.find((p) => p.name === item.scope)
    const machine = String(peer?.certFingerprint || peer?.url || item.scope)
    const key = `${machine}|${item.id}`
    const rank = /-exec$/.test(item.scope) ? 1 : 0
    const prev = best.get(key)
    if (!prev || rank < prev.rank) best.set(key, { scope: item.scope, instance: item.id, rank, peer })
  }
  const remote = [...best.values()].map(({ scope, instance, peer }) => ({ scope, instance, peer }))
  return [...localInstanceIds(config).map((instance) => ({ scope: 'local', instance })), ...remote]
}

const config = loadConfig(home, { log: quiet })
const peerItems = has('--no-peers') ? [] : (loadPeers(home).items || [])
const peers = peerItems.map((p) => ({ id: p.id, name: p.name, url: p.url, certFingerprint: p.certFingerprint, token: p.token }))

const [report, self] = await Promise.all([
  clusterReport({ config, home, log: quiet, peers, timeoutMs }),
  probeSelfEndpoint(config, { timeoutMs }).catch((error) => ({ ok: false, error: String(error?.message || error) })),
])

// —— 能力探测（repair 通道 / watchdog）——
const localRepair = {
  enabled: Boolean(config.repair?.enabled),
  restartScripts: Object.keys(config.repair?.restartScripts || {}),
  timeoutMs: config.repair?.timeoutMs ?? null,
  shellRun: Boolean(config.shell?.enabled),
  aclAllows: ['service_restart', 'repair_status'].filter((t) => (config.acl?.allow || []).includes(t)),
}
const peerRepair = fastMode
  ? []
  : await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await callPeerTool(peer, { tool: 'repair_status', args: {}, timeoutMs })
          const data = unwrap(res)
          if (res?.ok === false || data?.code) return { name: peer.name, ok: false, error: data?.code || 'E_TOOL', detail: tailText(data?.message) }
          return { name: peer.name, ok: true, enabled: Boolean(data.enabled), restartScripts: data.restartScripts || [], timeoutMs: data.timeoutMs ?? null }
        } catch (error) {
          return { name: peer.name, ok: false, error: 'E_CALL', detail: tailText(error?.message || error) }
        }
      })
    )
const localWatchdog = fastMode ? null : watchdogState()
const localAlertTask = fastMode ? null : runnerTaskState(ALERT_TASK)
const frpFlaps = fastMode ? null : frpFlapSummary()
// --sessions：可选，回答「每台机/每实例有几条会话正在跑」；不需要就完全不探测。
// 注意：sessions 探测失败**不影响 verdict**（verdict 只看 report 里的节点/实例/peer 真实状态），
// 单个 peer 慢/超时只标记该行 ok=false，不拖垮整体。
const sessionsReport = has('--sessions')
  ? await collectRunningSessions({
      config,
      home,
      targets: filterTargets(sessionsTargets(report, peers), {
        node: arg('--node', ''),
        instance: arg('--instance', '')
      }),
      timeoutMs: Math.max(timeoutMs, 15000), // host_sessions 跨机实测 0.05~13s，不能沿用 4s 的探测超时
      ttlMs: Math.max(0, Number(arg('--cache-ttl', String(Math.round(DEFAULT_TTL_MS / 1000)))) * 1000),
      cache: !has('--no-cache')
    })
  : null

// —— 汇总 ——
const clusterById = new Map((report.cluster || []).map((c) => [`${c.scope}/${c.id}`, c]))
const instances = (report.instances || []).map((inst) => {
  const extra = clusterById.get(`local/${inst.id}`) || {}
  return { scope: 'local', id: inst.id, up: Boolean(inst.up), pid: extra.pid ?? null, tools: extra.toolCount ?? null, error: inst.error?.code || null }
})
const downInstances = instances.filter((i) => !i.up)
const remoteDown = (report.remoteInstances || []).filter((i) => i.up === false)
const peersDown = (report.peers || []).filter((p) => !p.up)
const versionMismatch = (report.peers || []).filter((p) => p.up && p.version && p.version !== MESH_VERSION)
const repairGaps = []
if (!localRepair.enabled) repairGaps.push('local')
for (const pr of peerRepair) if (pr.ok && !pr.enabled) repairGaps.push(pr.name)

const hints = []
for (const inst of downInstances) {
  hints.push(`本机 ${inst.id} 未监听：等 watchdog 拉起（≤5 分钟，若已装）或 node scripts/restart-dsh-instance.mjs --instance ${inst.id} --yes`)
}
for (const r of remoteDown) {
  const peerName = peers.find((p) => p.name === r.scope)?.name || r.scope
  hints.push(`远端 ${peerName}/${r.id} 未监听：在任一节点跑 node scripts/mesh-health.mjs --json 看该节点 repair 是否 enabled；enabled 则 node src/cli.js peer call service_restart --to ${peerName} --args "{\\"script\\":\\"${r.id}\\",\\"confirm\\":true}"`)
}
for (const p of peersDown) hints.push(`peer ${p.name} 不可达：先查该机 mesh server / frp 隧道，再查 TLS 指纹`)
for (const p of versionMismatch) hints.push(`peer ${p.name} 版本 ${p.version} ≠ 本机 ${MESH_VERSION}：该节点需 git pull + 重启 mesh server（node scripts/mesh-restart.mjs）`)
for (const gap of repairGaps) {
  hints.push(
    gap === 'local'
      ? '本机未开远程修复通道（repair.enabled=false）：实例全死后别人拉不起来，需在本机 config.json 开 repair + ACL service_restart'
      : `${gap} 未开远程修复通道：同上，需在该节点 config.json 开 repair + ACL service_restart`
  )
}
if (localWatchdog && !localWatchdog.installed) hints.push('本机未装实例看护 watchdog：node scripts/instance-watchdog.mjs --install --interval 5 --yes')

let verdict = downInstances.length || remoteDown.length || peersDown.length ? 'down' : report.verdict || 'ok'
// 2026-11-10：普通 --json 调用（面板采集/脚本）也做一次重探 —— 远端机器忙时 4s 探测会偶发超时，
// 面板就会出现"莫名其妙 down 但拓扑/设备都正常"。重探用更长超时；首探异常、重探恢复则判 ok。
if (!has('--alert') && !fastMode && verdict === 'down') {
  // 两轮重探：远端机器忙时单轮 4~6s 超时很常见；两轮都失败才判 down；
  // 若最终只有"远端实例"不可用（peer 与本机实例都正常）→ 降级为 degraded（实例抖动不该让整个网络变红）
  let lastPeersDown = peersDown
  let lastRemoteDown = remoteDown
  let lastLocalDown = downInstances
  for (let attempt = 1; attempt <= 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 1200))
    try {
      const retry = await clusterReport({ config, home, log: quiet, peers, timeoutMs: Math.max(timeoutMs, 6000 + attempt * 2000) })
      lastPeersDown = (retry.peers || []).filter((p) => !p.up)
      lastRemoteDown = (retry.remoteInstances || []).filter((i) => i.up === false)
      lastLocalDown = (retry.instances || []).filter((i) => !i.up)
      if (!lastPeersDown.length && !lastRemoteDown.length && !lastLocalDown.length) {
        verdict = 'ok'
        hints.push('verdict：首探 down、第 ' + attempt + ' 轮重探恢复（瞬时探测失败，已忽略）')
        break
      }
    } catch { /* 继续下一轮 */ }
  }
  if (verdict === 'down' && !lastPeersDown.length && !lastLocalDown.length && lastRemoteDown.length) {
    verdict = 'degraded'
    hints.push('verdict=degraded：仅远端实例不可用（' + lastRemoteDown.map((i) => i.scope + '/' + i.id).join(', ') + '），链路/本机均正常')
  }
}
const snapshot = {
  at: new Date().toISOString(),
  meshVersion: MESH_VERSION,
  home,
  elapsedMs: Date.now() - startedAt,
  endpoint: self,
  verdict,
  issues: report.issues || [],
  local: { instances, repair: localRepair, watchdog: localWatchdog },
  peers: (report.peers || []).map((p) => ({ name: p.name, url: p.url, up: Boolean(p.up), latencyMs: p.latencyMs ?? null, version: p.version ?? null, fingerprintMatch: p.fingerprintMatch ?? null, instances: (p.instances || []).length, tunnels: p.tunnels || null, error: p.error?.code || null })),
  tunnels: await collectTunnels({ repo: REPO, home }),
  peerRepair,
  remoteInstances: report.remoteInstances || [],
  versionMismatch: versionMismatch.map((p) => ({ name: p.name, version: p.version })),
  frpFlaps,
  ...(sessionsReport ? { sessions: sessionsReport } : {}),
  hints,
}

if (has('--alert')) {
  // 2026-11-06 告警降噪（证据：2 天内 20 条 mesh-degraded，几乎全是单次 peer TLS 瞬断）：
  //   ① 软失败先重探一次（1.5s 后，只对 peer/远端实例恢复的情况生效）
  //   ② 仍失败才计数；连续 2 次异常才写告警（迟滞）
  //   ③ 恢复时写一条 mesh-recovered 到 alerts.jsonl（不动 ALERT.json 指针）
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const badNow = () => Boolean(downInstances.length || remoteDown.length || peersDown.length || verdict !== 'ok')
  if (!badNow()) {
    if (resetBadRun()) appendAlertHistory({ kind: 'mesh-recovered', summary: 'verdict=' + verdict })
  } else {
    await sleepMs(1500)
    const retry = await clusterReport({ config, home, log: quiet, peers, timeoutMs })
    const retryPeersDown = (retry.peers || []).filter((p) => !p.up)
    const retryRemoteDown = (retry.cluster || []).filter((c) => c.scope !== 'local' && !c.up)
    const retryVerdict = retryPeersDown.length || retryRemoteDown.length ? 'down' : (retry.verdict || verdict)
    const stillBad = Boolean(retryRemoteDown.length || retryVerdict !== 'ok')
    if (!stillBad) {
      resetBadRun()
      appendAlertHistory({ kind: 'mesh-recovered', summary: 'verdict=ok（首探异常、重探恢复：' + verdict + '）' })
    } else {
      const run = bumpBadRun()
      if (run >= 2) {
        writeAlert({
          kind: 'mesh-degraded',
          summary: 'verdict=' + retryVerdict + ' localDown=' + downInstances.length + ' remoteDown=' + retryRemoteDown.length + ' peersDown=' + retryPeersDown.length,
          verdict: retryVerdict,
          consecutiveBad: run,
          issues: retry.issues || report.issues || [],
          down: [...downInstances.map((i) => 'local/' + i.id), ...retryRemoteDown.map((i) => i.scope + '/' + i.id)],
          peersDown: retryPeersDown.map((p) => p.name)
        })
      } else if (!quiet) {
        console.log(`[alert] 首次探测异常（${retryVerdict}），已计数 ${run}/2（迟滞：连续 2 次才告警）`)
      }
    }
  }
}

if (has('--json')) {
  console.log(JSON.stringify(snapshot, null, 2))
  process.exit(verdict === 'down' ? 3 : 0)
}

const icon = (ok) => (ok ? '✅' : '❌')
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
const lines = []
lines.push(`AI 网络 · ${new Date().toLocaleString('zh-CN', { hour12: false })} · mesh ${MESH_VERSION} · ${home}`)
lines.push(`端点 ${icon(Boolean(self?.up))} ${self?.up ? `${self.url || ''} pid=${self.pid ?? '-'} tools=${self.tools ?? '-'} v${self.version || '?'}` : tailText(self?.error || 'down', 120)}`)
lines.push('')
lines.push(`本机实例（${instances.filter((i) => i.up).length}/${instances.length} up）`)
for (const i of instances) lines.push(`  ${icon(i.up)} ${pad(i.id, 6)} pid=${pad(i.pid ?? '-', 7)} tools=${pad(i.tools ?? '-', 4)}${i.error ? '  ' + i.error : ''}`)
lines.push('')
lines.push(`远端节点（${(report.peers || []).filter((p) => p.up).length}/${(report.peers || []).length} up）`)
for (const p of report.peers || []) {
  lines.push(`  ${icon(p.up)} ${pad(p.name, 10)} ${pad(p.latencyMs ?? '-', 5)}ms ver=${pad(p.version ?? '-', 7)} TLS=${p.fingerprintMatch === false ? '✗不匹配' : '✓'} 实例=${(p.instances || []).length}${p.error?.code ? '  ' + p.error.code : ''}`)
}
if ((report.remoteInstances || []).length) lines.push(`  远端实例：${report.remoteInstances.map((i) => `${i.scope}/${i.id}=${i.up === false ? '❌' : '✅'}`).join('  ')}`)
if (sessionsReport) {
  lines.push('')
  const failed = sessionsReport.failedCount
  lines.push(
    `正在运行的会话（--sessions · state=working · 共 ${sessionsReport.runningCount} 条 · 目标 ${sessionsReport.rows.length} 个` +
      ` · 成功 ${sessionsReport.okCount}` +
      (failed ? ` / 探测失败 ${failed}（不影响 verdict）` : '') +
      ` · 缓存命中 ${sessionsReport.cachedCount}）`
  )
  for (const row of sessionsReport.rows) {
    const where = `${row.scope}/${row.instance}`
    const fromCache = row.cached ? ' [cache]' : ''
    lines.push(`  ${row.ok ? '✅' : '⚠️'} ${pad(where, 22)} running=${row.running ?? '-'} / live=${row.total ?? '-'}${row.ms ? ` ${row.ms}ms` : ''}${fromCache}`)
    if (!row.ok) lines.push(`      ${row.error}`)
    for (const s of (row.sessions || []).slice(0, 5)) {
      const when = s.updatedAt ? fmtEpoch(s.updatedAt) : '-'
      lines.push(`      ${when}  ${String(s.sessionId || '').slice(0, 20)}  ${s.title || '(无标题)'}`)
    }
    if ((row.sessions || []).length > 5) lines.push(`      ... 还有 ${row.sessions.length - 5} 条运行中`)
  }
  lines.push(`  时间口径：${sessionsReport.updatedAtField}`)
}
lines.push('')
lines.push(`远程修复通道 ${localRepair.enabled ? '✅' : '❌'} 本机 enabled=${localRepair.enabled} scripts=[${localRepair.restartScripts.join(',')}] timeout=${localRepair.timeoutMs ?? '-'}`)
for (const pr of peerRepair) {
  lines.push(`  ${pr.ok && pr.enabled ? '✅' : pr.ok ? '❌' : '⚠️'} ${pad(pr.name, 10)} ${pr.ok ? `enabled=${pr.enabled} scripts=[${(pr.restartScripts || []).join(',')}]` : `探测失败 ${pr.error}${pr.detail ? ' ' + pr.detail : ''}`}`)
}
if (localWatchdog) lines.push(`实例看护 watchdog ${localWatchdog.installed ? `✅ ${localWatchdog.status || 'Ready'} lastResult=${localWatchdog.lastResult ?? '-'} lastRun=${localWatchdog.lastRun || '-'} nextRun=${localWatchdog.nextRun || '-'}` : '❌ 未安装'}`)
lines.push('')
lines.push(`verdict: ${verdict.toUpperCase()}   耗时 ${snapshot.elapsedMs}ms`)
if (frpFlaps) lines.push(`frp 探测（近 ${frpFlaps.windowMin} 分钟）：失败 ${frpFlaps.fails}/${frpFlaps.total}${Object.keys(frpFlaps.byPeer).length ? " · " + Object.entries(frpFlaps.byPeer).map(([k, v]) => `${k}:${v}`).join(",") : ""}`)
if (localAlertTask) lines.push(`异常告警任务 ${localAlertTask.installed ? '✅ ' + (localAlertTask.status || 'Ready') : '❌ 未安装（node scripts/mesh-health.mjs --install-alert --yes）'}`)
const recentAlert = alertLine(lastAlert())
if (recentAlert) lines.push(`  ⚠️ ${recentAlert}`)
for (const h of hints) lines.push(`  · ${h}`)
console.log(lines.join('\n'))
process.exit(verdict === 'down' ? 3 : 0)
