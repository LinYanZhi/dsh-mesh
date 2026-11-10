import { z } from 'zod'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPeers } from '../core/pairing.js'
import { clusterReport, probePeer } from '../core/cluster.js'
import { callPeerTool } from '../core/peer-client.js'
import { gitSpawnDiagnostics, runGit } from '../core/git-exec.js'
import { joinRemote } from '../core/remote-path.js'
import { fail, ok } from '../core/result.js'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/**
 * 本机仓库摘要。走共享的 git 解析（DSH_MESH_GIT → PATH → 常见安装目录），
 * 否则计划任务式干净 PATH 下这里会把「找不到 git」报成空摘要。
 * @param {string} repo 仓库目录
 * @returns {Promise<object>} { path, head, branch, dirty, ahead, behind } 或 { path, error, ...诊断 }
 */
async function gitInfo(repo) {
  if (!repo) return { path: '', error: 'no repo path' }
  const run = async (args) => {
    const out = await runGit(['-C', repo, ...args], { timeout: 5000 })
    if (out.error) {
      const code = typeof out.error.code === 'string' ? out.error.code : `exit-${out.code}`
      const error = new Error(out.error.message || out.stderr.trim() || `git ${args[0]} failed`)
      error.spawnCode = typeof out.error.code === 'string' ? out.error.code : null
      error.code = code
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
    if (error?.spawnCode) {
      return { path: repo, error: `E_GIT_SPAWN: ${error.message}`, ...gitSpawnDiagnostics() }
    }
    return { path: repo, error: String(error?.message || error) }
  }
}

function taskStats(root) {
  const dir = join(root, '.mesh', 'tasks')
  if (!existsSync(dir)) return { active: 0, stale: 0, activeStale: 0 }
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
    const match = /^T-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(entry.name)
    const idTime = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime() : 0
    const age = Number(status?.staleSeconds || 0)
    const statusAge = status?.updatedAt ? (Date.now() - Date.parse(status.updatedAt)) / 1000 : null
    if (age > 3600 || (statusAge !== null && statusAge > 3600) || (idTime && Date.now() - idTime > 3600_000)) stale += 1
  }
  return { active, stale, activeStale: stale }
}
/**
 * Cluster view (M7 step 4). One read-only call answers "is the whole cluster
 * healthy, and if not which hop is broken": every local DSH instance behind a
 * host bridge, plus every paired remote node's `/health` (version / tools /
 * uptime / TLS pin). Used as the first step of the A-crashed-B-repairs-A drill.
 */
export function buildCluster(ctx) {
  return [
    {
      name: 'mesh_peers',
      title: 'Lightweight configured peers',
      description:
        'Read-only, near-instant list of peer names configured in this node (peers.json). Does not probe peers, does not return tokens/URLs. Intended for topology federation; pair with the peer\'s own mesh_peers for one-hop visibility.',
      inputSchema: z.object({}),
      handler: async () => {
        const peers = loadPeers(ctx.home).items || []
        return ok({
          peers: peers.map((peer) => ({ id: peer.id, name: peer.name }))
        })
      }
    },
    {
      name: 'cluster_status',
      title: 'Cluster health snapshot',
      description:
        'Read-only snapshot of everything this node can reach: local DSH instances behind host bridges (pid, tool count, live agents, latency) and paired remote nodes probed over /health (version, tools, uptime, TLS fingerprint match). Also aggregates each peer\'s own host_instances into summary{local,remote,total} / cluster[] / remoteInstances[] so one call lists every machine\'s DSH instances (four-instance view); a peer that denies host_instances shows instancesError without failing the verdict. Returns a verdict (ok / degraded / down) plus an issues list. Start here before repairing anything: it tells you which hop is broken. Never mutates state.',
      inputSchema: z.object({
        includePeers: z.boolean().optional().describe('Probe paired remote nodes too (default true).'),
        timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Per-probe timeout in ms (default 4000).')
      }),
      handler: async ({ includePeers, timeoutMs }) => {
        try {
          const config = ctx.getConfig()
          const peers = includePeers === false ? [] : loadPeers(ctx.home).items || []
          const report = await clusterReport({
            config,
            home: ctx.home,
            log: ctx.log,
            peers: peers.map((peer) => ({
              id: peer.id,
              name: peer.name,
              url: peer.url,
              certFingerprint: peer.certFingerprint,
              token: peer.token
            })),
            timeoutMs: timeoutMs ?? 4000
          })
          return ok(report)
        } catch (error) {
          return fail('E_CLUSTER_ERROR', error?.message || String(error))
        }
      }
    },
    {
      name: 'mesh_overview',
      title: 'One-screen mesh overview',
      description:
        'Read-only overview for AI: node/mesh version, local DSH instances (up/plugin/pid/tools/live agents), peers (health/version), local active/stale delegation tasks, each peer active/stale task counts, and local/peer git head/dirty/ahead/behind. Use this first instead of chaining cluster_status + delegate_list.',
      inputSchema: z.object({
        includePeers: z.boolean().optional().describe('Probe and query paired peers too (default true).'),
        timeoutMs: z.number().int().min(1000).max(60000).optional()
      }),
      handler: async ({ includePeers = true, timeoutMs = 4000 }) => {
        try {
          const config = ctx.getConfig()
          const peers = includePeers === false ? [] : loadPeers(ctx.home).items || []
          const report = await clusterReport({
            config,
            home: ctx.home,
            log: ctx.log,
            peers: peers.map((peer) => ({
              id: peer.id,
              name: peer.name,
              url: peer.url,
              certFingerprint: peer.certFingerprint,
              token: peer.token
            })),
            timeoutMs
          })
          const localRoot = config.acl?.fsRoots?.[0]?.path || ''
          const localTasks = localRoot ? taskStats(localRoot) : { active: 0, stale: 0, activeStale: 0 }
          const peerTasks = []
          for (const peer of peers) {
            try {
              const out = await callPeerTool(peer, { tool: 'delegate_list', args: { limit: 100 }, timeoutMs: Math.min(timeoutMs, 8000) })
              const text = out.result?.content?.[0]?.text || '{}'
              const listed = JSON.parse(text)
              peerTasks.push({ peer: peer.name, activeCount: listed.activeCount || 0, staleActiveCount: listed.staleActiveCount || 0 })
            } catch (error) {
              peerTasks.push({ peer: peer.name, error: String(error?.message || error) })
            }
          }
          const peerRepos = []
          for (const peer of peers) {
            try {
              const selfOut = await callPeerTool(peer, { tool: 'mesh_self', args: {}, timeoutMs: Math.min(timeoutMs, 8000) })
              const selfText = selfOut.result?.content?.[0]?.text || '{}'
              const self = JSON.parse(selfText)
              // 对端仓库路径由**对端**决定：用平台无关拼接（Linux 节点拼 Windows 对端路径不能走本机 path.join）
              const repoPath = self.mesh?.repo || joinRemote(self.acl?.fsRoots?.[0]?.path || '', 'dsh-mesh')
              const statusOut = await callPeerTool(peer, { tool: 'git_status', args: { path: repoPath }, timeoutMs: Math.min(timeoutMs, 8000) })
              const statusText = statusOut.result?.content?.[0]?.text || '{}'
              const status = JSON.parse(statusText)
              peerRepos.push({
                peer: peer.name,
                path: repoPath,
                head: status.head ? String(status.head).slice(0, 7) : '',
                branch: status.branch || '',
                dirty: (status.dirty?.modified || 0) + (status.dirty?.untracked || 0),
                ahead: status.ahead ?? null,
                behind: status.behind ?? null
              })
            } catch (error) {
              peerRepos.push({ peer: peer.name, error: String(error?.message || error) })
            }
          }
          const localRepo = await gitInfo(process.cwd())
          return ok({
            node: report.node,
            summary: report.summary,
            verdict: report.verdict,
            issues: report.issues,
            repos: { local: localRepo, peers: peerRepos },
            instances: (report.instances || []).map((instance) => ({
              id: instance.id,
              label: instance.label,
              up: instance.up,
              plugin: instance.plugin,
              pid: instance.pid,
              toolCount: instance.toolCount,
              liveAgents: (instance.agents || []).length
            })),
            peers: report.peers,
            tasks: { local: localTasks, peers: peerTasks }
          })
        } catch (error) {
          return fail('E_OVERVIEW_ERROR', error?.message || String(error))
        }
      }
    },
    {
      name: 'cluster_exec',
      title: 'Run one MCP tool on a paired peer',
      description:
        'Calls exactly one tool on a paired remote node (the reverse direction: this node acts on the other machine). Looks the peer up by name/id in peers.json (token imported via `peer import` or obtained by `peer add`), re-checks its /health and TLS pin first, then makes one MCP tool call. Denied by default — add "cluster_exec" to acl.allow. Read-only tools are the intended use; write/repair tools on the peer are still governed by THAT node\'s own ACL.',
      inputSchema: z.object({
        peer: z.string().describe('Paired peer name or id, as listed by `node src/cli.js peer list`.'),
        tool: z.string().describe('Tool name on the peer (e.g. mesh_self, cluster_status).'),
        arguments: z.any().optional().describe('Arguments object for the peer tool (default {}).'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Per-call timeout in ms (default 30000).')
      }),
      handler: async ({ peer, tool, arguments: args, timeoutMs }) => {
        const config = ctx.getConfig()
        const target = String(peer || '').trim()
        const entry = loadPeers(ctx.home).items.find((item) => item.name === target || item.id === target)
        if (!entry) {
          return fail('E_NOT_FOUND', `unknown peer "${target}" — run \`node src/cli.js peer list\` / \`peer import\``)
        }
        const limit = timeoutMs ?? 30000
        const probe = await probePeer(
          { id: entry.id, name: entry.name, url: entry.url, certFingerprint: entry.certFingerprint },
          { timeoutMs: Math.min(limit, 8000) }
        )
        if (probe.up !== true) {
          return fail(probe.error?.code || 'E_PEER_OFFLINE', `peer "${target}" is unreachable: ${probe.error?.message || 'no response'}`, {
            retryable: true,
            peer: target
          })
        }
        if (probe.fingerprintMatch !== true) {
          return fail('E_PEER_PIN_MISMATCH', `peer "${target}" certificate no longer matches the stored fingerprint`, {
            retryable: false,
            peer: target
          })
        }
        try {
          const out = await callPeerTool(entry, { tool, args: args ?? {}, timeoutMs: limit })
          return ok({
            peer: target,
            node: probe.node,
            version: probe.version,
            tool,
            ok: out.ok,
            ms: out.ms,
            result: out.result
          })
        } catch (error) {
          return fail(error.code || 'E_PEER_CALL_FAILED', error.message, { retryable: false, peer: target })
        }
      }
    }
  ]
}
