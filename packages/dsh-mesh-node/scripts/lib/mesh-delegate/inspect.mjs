// @generated mesh-delegate/inspect: 观察侧子命令（sessions / history / gc-stale / overview）
// 纯搬移自 scripts/mesh-delegate.mjs（2026-10-25 拆分），行为不变。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../../src/core/config.js'
import { loadPeers } from '../../../src/core/pairing.js'
import { clusterReport } from '../../../src/core/cluster.js'
import { gitSpawnDiagnostics, runGit } from '../../../src/core/git-exec.js'
import { joinRemote } from '../../../src/core/remote-path.js'
import { collectRunningSessions, localInstanceIds, remoteInstanceIds } from '../session-stats.mjs'
import { arg, has, HOME, TERMINAL, peerByName, peerCall, peerContext, readRemoteJson, localNodeName } from './common.mjs'
import { chooseSession } from './delegate.mjs'

export async function sessions() {
  const peer = peerByName(arg('to', 'company'))
  const only = arg('instance')
  const limit = Number(arg('limit', 50))
  const includeEnded = !has('no-ended')
  const workspace = arg('workspace')
  let hosts = only ? [{ id: only, alive: true }] : []
  if (!only) {
    const listed = await peerCall(peer, 'host_instances')
    hosts = (listed.instances || []).filter((host) => host.alive)
  }
  const rows = []
  for (const host of hosts) {
    const payload = { instance: host.id, limit: 200, includeEnded }
    if (workspace) payload.workspace = workspace
    try {
      const data = await peerCall(peer, 'host_sessions', payload, 30000)
      for (const session of data.sessions || []) {
        // `protected` comes from the peer's schedule/task indexes: never offer a
        // scheduled business conversation as a delegation target.
        const safe = session.protected !== true
        rows.push({
          instance: host.id,
          ...session,
          delegatable: safe && session.delegatable !== false && session.state !== 'ended',
          recommended: safe && session.recommended === true
        })
      }
    } catch (error) {
      rows.push({ instance: host.id, error: String(error?.message || error), delegatable: false, recommended: false })
    }
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const visible = has('only-safe') ? rows.filter((row) => row.delegatable === true) : rows
  // Without --instance we list BOTH instances; slicing the global sorted list would
  // hide the less-recently-used instance entirely (2026-10-25: dsh1 always won).
  const perInstance = new Map()
  for (const row of visible) {
    const key = row.instance || 'unknown'
    perInstance.set(key, (perInstance.get(key) || 0) + 1)
  }
  let selected = visible
  if (!only) {
    const buckets = new Map()
    for (const row of visible) {
      const key = row.instance || 'unknown'
      if (!buckets.has(key)) buckets.set(key, [])
      const bucket = buckets.get(key)
      if (bucket.length < limit) bucket.push(row)
    }
    selected = [...buckets.values()].flat().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  } else {
    selected = visible.slice(0, limit)
  }
  const protectedCount = rows.filter((row) => row.protected === true).length
  // Peers < 0.17.0 return no `kind`, so protection cannot be evaluated there.
  const classified = rows.length > 0 && rows.every((row) => row.error || typeof row.kind === 'string')
  const hints = []
  if (!classified) {
    hints.push('peer mesh did not classify sessions (version < 0.17.0): protectedCount is unreliable and delegate --session will refuse until the peer is upgraded (git pull + scripts/mesh-restart.mjs)')
  }
  if (protectedCount > 0) {
    hints.push('protected sessions own scheduled tasks (kind=business-scheduled) — a delegation there would pollute them; use delegate without --session (fresh conversation) or pass --force')
  }
  console.log(
    JSON.stringify(
      {
        peer: peer.name,
        count: selected.length,
        instances: [...perInstance.entries()].map(([instance, total]) => ({ instance, total })).sort((a, b) => a.instance.localeCompare(b.instance)),
        limit: only ? limit : `per-instance ${limit}`,
        protectedCount,
        classified,
        ...(hints.length ? { hint: hints.join(' ; ') } : {}),
        sessions: selected
      },
      null,
      2
    )
  )
  return 0
}

/**
 * Cross-machine transcript read WITHOUT opening any write channel.
 *
 * A peer's DSH session logs live outside the mesh fsRoots (e.g. ~/.dsh1/sessions),
 * so fs_read cannot reach them and fs_read is text-only anyway (the logs are
 * zstd frames). Instead: ask the peer AI to run its own local
 * `dsh-sessions.mjs history` (read-only) and dump the JSON into its .mesh/tasks/,
 * which IS inside fsRoots — we then read it back. Needs no ACL change; the peer
 * only reads its own data and writes inside the delegation mailbox.
 */
export async function history() {
  const peer = peerByName(arg('to', 'company'))
  const target = arg('of') || arg('session')
  if (!target) throw new Error('history requires --session <sessionId> (the DSH session whose transcript you want)')
  const instance = arg('instance', 'dsh0')
  const limit = Number(arg('limit', 30))
  const ctx = await peerContext(peer)
  const root = ctx.fsRoot
  const nonce = `${Date.now()}`
  // 对端 absolute 路径：用平台无关拼接（Windows caller 拼 POSIX 对端路径时本机 join 会丢斜杠方向）
  const outPath = joinRemote(root, '.mesh', 'tasks', `history-${target}-${nonce}.json`)
  const script = joinRemote(root, 'my-skills', 'scripts', 'platforms', 'dsh', 'dsh-sessions.mjs')
  const goal = [
    '只做一件事：把本机某个 DSH 会话的历史导出成精简 JSON（只读；不修改任何文件/配置/进程）。',
    `1) 运行并先存原始输出：node "${script}" history --home ${instance} --session ${target} --limit ${limit} --json > "$env:TEMP\\dsh-history-${nonce}.json"`,
    '   若报错或拿不到消息（会话已结束/非活跃），追加 --offline 再试（离线解日志帧，只读）。',
    '   注意：--json 的原始输出可能有好几 MB（含 raw records），不要原样交上去。',
    `2) 用 node 把它精简成只含 messages 的 JSON，写到：${outPath}`,
    '   精简规则：保留 {source, title, messages}；messages 每条只留 {role, seq, time, text}，text 截断到 4000 字符；丢弃 records 等大字段。UTF-8、无 BOM。',
    '   参考一行命令（按需改路径）：node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'));const o={source:p.source,title:p.title,messages:(p.messages||[]).map(m=>({role:m.role,seq:m.seq,time:m.time,text:String(m.text||\'\').slice(0,4000)}))};fs.writeFileSync(process.argv[2],JSON.stringify(o,null,2))" "$env:TEMP\\dsh-history-...json" "<outPath>"',
    '3) 若命令失败：把 {"error":"<stderr 原文>","command":"<完整命令>"} 写到同一个文件。',
    '4) 回复里只报：消息条数 + 文件路径 + 文件大小。不要往任何会话注入消息、不要 kill 进程、不要 push、不要改 DSH 配置。'
  ].join('\n')
  const via = arg('via')
  const chosen = via
    ? { sessionId: via, created: false, status: 'idle', instance }
    : await chooseSession(peer, 'new', null, undefined, arg('workspace'), instance, { dryRun: has('dry-run') })
  const text = `[dsh-mesh history request]\nfrom=${localNodeName()}\n\n${goal}`
  if (has('dry-run')) {
    console.log(JSON.stringify({ dryRun: true, peer: peer.name, sessionId: chosen.sessionId, created: chosen.created === true, instance: chosen.instance, outPath }, null, 2))
    return 0
  }
  const forceFlag = has('force') ? { force: true } : {}
  const delivery = chosen.created
    ? await peerCall(peer, 'host_session_prompt', { sessionId: chosen.sessionId, text, mode: 'queue', instance: chosen.instance, ...forceFlag })
    : await peerCall(peer, 'channel_wake', { sessionId: chosen.sessionId, text, target: 'next-turn', instance: chosen.instance, ...forceFlag })
  const waitSec = Number(arg('wait', 180))
  const deadline = Date.now() + Math.max(waitSec, 1) * 1000
  let data = null
  while (Date.now() < deadline) {
    data = await readRemoteJson(peer, outPath)
    if (data) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (!data) {
    console.error(
      `mesh-delegate: no transcript within ${waitSec}s on ${peer.name} (delegated session ${chosen.sessionId}). It may still be running — retry with: ` +
        `node scripts/mesh-delegate.mjs history --to ${peer.name} --session ${target} --via ${chosen.sessionId} --wait 180`
    )
    console.log(JSON.stringify({ peer: peer.name, sessionId: chosen.sessionId, instance: chosen.instance, outPath, delivered: chosen.created ? delivery.accepted === true : delivery.wokeUp === true }, null, 2))
    return 2
  }
  console.log(JSON.stringify({ peer: peer.name, target, instance, via: chosen.sessionId, outPath, transcript: data }, null, 2))
  return 0
}

export async function gcStale() {
  const peer = peerByName(arg('to', 'company'))
  const payload = {
    olderThanSeconds: Number(arg('older-than', 3600)),
    apply: has('apply'),
    limit: Number(arg('limit', 50))
  }
  const data = await peerCall(peer, 'delegate_gc', payload, 30000)
  console.log(JSON.stringify({ peer: peer.name, ...data }, null, 2))
  return 0
}

function localTaskStats(root) {
  const dir = join(root, '.mesh', 'tasks')
  if (!existsSync(dir)) return { active: 0, stale: 0 }
  let active = 0
  let stale = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let status = null
    try {
      status = JSON.parse(readFileSync(join(dir, entry.name, 'status.json'), 'utf8'))
    } catch {
      status = null
    }
    const state = status?.state || 'submitted'
    if (TERMINAL.has(state)) continue
    active += 1
    if (Number(status?.staleSeconds || 0) > 3600 || (status?.updatedAt && Date.now() - Date.parse(status.updatedAt) > 3600_000)) stale += 1
  }
  return { active, stale }
}

async function gitInfo(repo) {
  if (!repo) return { path: '', error: 'no repo path' }
  const run = async (args) => {
    const out = await runGit(['-C', repo, ...args], { timeout: 5000 })
    if (out.error) {
      const error = new Error(out.error.message || out.stderr.trim() || `git ${args[0]} failed`)
      error.spawnCode = typeof out.error.code === 'string' ? out.error.code : null
      throw error
    }
    return out.stdout.trim()
  }
  try {
    const head = await run(['rev-parse', '--short', 'HEAD'])
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const dirty = (await run(['status', '--porcelain'])) !== ''
    let ahead = null
    let behind = null
    try {
      const counts = (await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).split(/\s+/).map(Number)
      ahead = counts[0] || 0
      behind = counts[1] || 0
    } catch {
      /* no upstream */
    }
    return { path: repo, head, branch, dirty, ahead, behind }
  } catch (error) {
    if (error?.spawnCode) return { path: repo, error: `E_GIT_SPAWN: ${error.message}`, ...gitSpawnDiagnostics() }
    return { path: repo, error: String(error?.message || error) }
  }
}

export async function overview() {
  const config = loadConfig(HOME)
  const peers = loadPeers(HOME).items || []
  const report = await clusterReport({
    config,
    home: HOME,
    log: console,
    peers: peers.map((peer) => ({ id: peer.id, name: peer.name, url: peer.url, certFingerprint: peer.certFingerprint, token: peer.token })),
    timeoutMs: 4000
  })
  const root = config.acl?.fsRoots?.[0]?.path || ''
  const local = root ? localTaskStats(root) : { active: 0, stale: 0 }
  // 每个 peer 的 delegate_list / mesh_self / git_status 原来一条条串行跑（7 个 peer 最多 21 次跨机往返），
  // 这里改成「per-peer 内串行、peer 之间并行」，单 peer 慢不再拖垮整体。
  const peerResults = await Promise.all(
    peers.map(async (peer) => {
      let taskRow
      try {
        const listed = await peerCall(peer, 'delegate_list', { limit: 100 }, 8000)
        taskRow = { peer: peer.name, activeCount: listed.activeCount || 0, staleActiveCount: listed.staleActiveCount || 0 }
      } catch (error) {
        taskRow = { peer: peer.name, error: String(error?.message || error) }
      }
      let repoRow
      try {
        const self = await peerCall(peer, 'mesh_self', {}, 8000)
        // 对端仓库路径由**对端**决定：用平台无关拼接，别用本机 path.join（Linux caller 拼 Windows 路径会错）
        const repoPath = self.mesh?.repo || joinRemote(self.acl?.fsRoots?.[0]?.path || '', 'dsh-mesh')
        const status = await peerCall(peer, 'git_status', { path: repoPath }, 8000)
        repoRow = {
          peer: peer.name,
          path: repoPath,
          head: status.head ? String(status.head).slice(0, 7) : '',
          branch: status.branch || '',
          dirty: (status.dirty?.modified || 0) + (status.dirty?.untracked || 0),
          ahead: status.ahead ?? null,
          behind: status.behind ?? null
        }
      } catch (error) {
        repoRow = { peer: peer.name, error: String(error?.message || error) }
      }
      return { taskRow, repoRow }
    })
  )
  const peerTasks = peerResults.map((item) => item.taskRow)
  const peerRepos = peerResults.map((item) => item.repoRow)
  // ---- 每节点每实例「正在运行的会话」（B3）：复用 session-stats（两段式探测 + 30s 缓存） ----
  const peerTargets = new Map() // 同一台机可能有 xxx-exec 别名（同证书）→ 只探一次，优先非 -exec 名字
  for (const peer of peers) {
    const machine = String(peer.certFingerprint || peer.url || peer.name)
    const prev = peerTargets.get(machine)
    if (!prev || (/-exec$/.test(prev.name) && !/-exec$/.test(peer.name))) peerTargets.set(machine, peer)
  }
  const sessionTargets = localInstanceIds(config).map((instance) => ({ scope: 'local', instance }))
  for (const peer of peerTargets.values()) {
    for (const instance of await remoteInstanceIds(peer, { timeoutMs: 8000 })) {
      sessionTargets.push({ scope: peer.name, instance, peer })
    }
  }
  const sessions = await collectRunningSessions({
    config,
    home: HOME,
    targets: sessionTargets,
    timeoutMs: 15000,
    cache: !has('no-cache')
  })
  const runningByInstance = new Map(sessions.rows.map((row) => [`${row.scope}/${row.instance}`, row]))
  const localRepo = await gitInfo(process.cwd())
  console.log(JSON.stringify({
    node: report.node,
    summary: report.summary,
    verdict: report.verdict,
    issues: report.issues,
    repos: { local: localRepo, peers: peerRepos },
    instances: (report.instances || []).map((instance) => {
      const stats = runningByInstance.get(`local/${instance.id}`)
      return {
        id: instance.id,
        up: instance.up,
        plugin: instance.plugin,
        pid: instance.pid,
        toolCount: instance.toolCount,
        liveAgents: (instance.agents || []).length,
        runningSessions: stats?.running ?? null
      }
    }),
    peers: report.peers,
    tasks: { local, peers: peerTasks },
    // B3：每节点每实例 running 会话数与标题；updatedAt 是会话索引时间，不等于最后活动时间
    sessions: {
      runningCount: sessions.runningCount,
      targets: sessions.rows.length,
      ok: sessions.okCount,
      failed: sessions.failedCount,
      cached: sessions.cachedCount,
      notes: sessions.updatedAtField,
      rows: sessions.rows.map((row) => ({
        scope: row.scope,
        instance: row.instance,
        ok: row.ok,
        source: row.source || null,
        running: row.running ?? null,
        live: row.total ?? null,
        ms: row.ms ?? null,
        error: row.error || null,
        sessions: (row.sessions || []).map((s) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt }))
      }))
    }
  }, null, 2))
  return 0
}
